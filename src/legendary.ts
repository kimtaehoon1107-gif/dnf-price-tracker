// 같은 시간의 재스캔이 일평균을 더 크게 좌우하지 않도록 마지막 관측만 쓴다.
export type LegendarySnapshot = {
  captured_at: string;
  min_unit_price: number;
  min_item_name: string;
  p10: number | null;
  median: number | null;
  scanned: number;
  with_listings: number;
  total_listings: number;
};

const HOUR = 3600000;
const DAY = 24 * HOUR;
const dateKey = (time: number) => new Date(time + 9 * HOUR).toISOString().slice(0, 10);
const dayTime = (date: string) => Date.parse(`${date}T00:00:00+09:00`);
const dow = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

export type LegendaryDistribution = { captured_at: string; q25: number; q75: number; kinds: number };

// 원본 JSON 전체를 전송하지 않고 성공한 조사별 종류 수·분위수만 읽는다.
export const legendaryDistributionSQL = `
  SELECT to_char(s.finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') captured_at,
    percentile_disc(0.25) WITHIN GROUP (ORDER BY (o->>'minPrice')::float8) q25,
    percentile_disc(0.75) WITHIN GROUP (ORDER BY (o->>'minPrice')::float8) q75,
    count(*)::int kinds
  FROM legendary_card_scans s CROSS JOIN LATERAL jsonb_array_elements(s.observations) o
  WHERE s.status='complete' AND s.failed=0 AND s.succeeded=s.expected
    AND o->>'status'='observed' AND (o->>'minPrice')::float8>0
  GROUP BY s.id,s.finished_at ORDER BY s.finished_at,s.id`;

export function legendarySeries(rows: LegendarySnapshot[], asOf: string, distributions: LegendaryDistribution[] = []) {
  const end = Date.parse(asOf);
  const valid = rows.filter((row) => row.p10 !== null && row.p10 > 0 && row.min_unit_price > 0
    && Date.parse(row.captured_at) <= end)
    .sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
  const hours = new Map<number, LegendarySnapshot>();
  for (const row of valid) hours.set(Math.floor(Date.parse(row.captured_at) / HOUR), row);
  const byTime = new Map(distributions.map(row => [Date.parse(row.captured_at), row]));
  const hourly = [...hours].map(([hour, row]) => {
    const band = byTime.get(Math.floor(Date.parse(row.captured_at) / 1000) * 1000);
    // 날짜가 가까운 다른 조사로 대신하지 않고 지표를 발행한 같은 스캔만 연결한다.
    const matched = band && band.kinds === row.with_listings;
    return { ...row, t: new Date(hour * HOUR).toISOString(),
      q25: matched ? band.q25 : null, q75: matched ? band.q75 : null };
  });
  const groups = new Map<string, typeof hourly>();
  for (const row of hourly) {
    const date = dateKey(Date.parse(row.t));
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date)!.push(row);
  }
  const daily = [...groups].map(([d, group]) => ({
    d, hours: group.length,
    p10: mean(group.map((row) => row.p10!)),
    min: mean(group.map((row) => row.min_unit_price)),
    listings: mean(group.map((row) => row.total_listings)),
    distributionHours: group.filter(row => row.q25 != null && row.q75 != null).length,
    q25: group.every(row => row.q25 != null) ? mean(group.map(row => row.q25!)) : null,
    q75: group.every(row => row.q75 != null) ? mean(group.map(row => row.q75!)) : null,
  }));

  // 당일과 관측이 18시간 미만인 날을 제외하고 월~일을 모두 갖춘 주만 비교한다.
  // 주별 가격 수준 차이는 주평균 100으로 줄이되, 패치 등 다른 원인을 제거한 검정은 아니다.
  const minHours = 18, minWeeks = 4;
  const complete = daily.filter((day) => day.d < dateKey(end) && day.hours >= minHours);
  const weeks = new Map<string, typeof daily>();
  for (const day of complete) {
    const monday = dateKey(dayTime(day.d) - dow(day.d) * DAY);
    if (!weeks.has(monday)) weeks.set(monday, []);
    weeks.get(monday)!.push(day);
  }
  const fullWeeks = [...weeks.values()].filter((week) => week.length === 7);
  const previousDays = new Map(complete.map((day) => [day.d, day]));
  const normalized = fullWeeks.flatMap((week) => {
    const average = mean(week.map((day) => day.p10));
    return week.map((day) => {
      const previous = previousDays.get(dateKey(dayTime(day.d) - DAY));
      return { ...day, price: day.p10 / average * 100,
        change: previous ? (day.p10 / previous.p10 - 1) * 100 : null };
    });
  });
  const points = ['월', '화', '수', '목', '금', '토', '일'].map((label, index) => {
    const group = normalized.filter((day) => dow(day.d) === index);
    const changes = group.flatMap((day) => day.change === null ? [] : [day.change]);
    return { k: index + 1, label, n: group.length,
      price: group.length ? mean(group.map((day) => day.price)) : null,
      change: changes.length ? mean(changes) : null, changeN: changes.length };
  });
  return {
    asOf, observations: valid.length, hourly, daily,
    weekday: {
      ready: fullWeeks.length >= minWeeks, minHours, minWeeks, weeks: fullWeeks.length,
      eligibleDays: complete.length,
      counts: points.map((_, index) => complete.filter((day) => dow(day.d) === index).length),
      points: fullWeeks.length >= minWeeks ? points : [],
    },
  };
}
