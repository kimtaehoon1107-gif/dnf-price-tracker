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

export function legendarySeries(rows: LegendarySnapshot[], asOf: string) {
  const end = Date.parse(asOf);
  const valid = rows.filter((row) => row.p10 !== null && row.p10 > 0 && row.min_unit_price > 0
    && Date.parse(row.captured_at) <= end)
    .sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
  const hours = new Map<number, LegendarySnapshot>();
  for (const row of valid) hours.set(Math.floor(Date.parse(row.captured_at) / HOUR), row);
  const hourly = [...hours].map(([hour, row]) => ({ ...row, t: new Date(hour * HOUR).toISOString() }));
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
