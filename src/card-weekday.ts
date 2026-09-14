export interface CardWeekdayDay {
  item_id: string;
  basis: 'ask0' | 'askMax';
  d: string;
  price: number;
  hours: number;
}

const DAY = 86400000;
const dayTime = (d: string) => Date.parse(`${d}T00:00:00Z`);
const weekday = (d: string) => (new Date(dayTime(d)).getUTCDay() + 6) % 7;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** 카드 가격대와 관측 횟수가 전체 평균의 비중을 좌우하지 않게 종목·주 단위로 정규화한다. */
export function cardWeekday(days: CardWeekdayDay[], itemIds: string[], asOf: string) {
  const minHours = 18, minWeeks = 4;
  const today = new Date(Date.parse(asOf) + 9 * 3600000).toISOString().slice(0, 10);
  const ids = [...new Set(itemIds)];
  const groups = (['ask0', 'askMax'] as const).map((basis) => {
    let observedItems = 0, maxWeeks = 0, maxDays = 0;
    const profiles: number[][] = [];
    for (const id of ids) {
      const complete = days.filter((day) => day.item_id === id && day.basis === basis
        && day.d < today && day.price > 0 && day.hours >= minHours);
      if (complete.length) observedItems++;
      maxDays = Math.max(maxDays, complete.length);
      const weeks = new Map<string, CardWeekdayDay[]>();
      for (const day of complete) {
        const monday = new Date(dayTime(day.d) - weekday(day.d) * DAY).toISOString().slice(0, 10);
        if (!weeks.has(monday)) weeks.set(monday, []);
        weeks.get(monday)!.push(day);
      }
      const full = [...weeks.values()].filter((week) => new Set(week.map((day) => day.d)).size === 7);
      maxWeeks = Math.max(maxWeeks, full.length);
      if (full.length < minWeeks) continue;
      const normalized = full.map((week) => {
        const average = mean(week.map((day) => day.price));
        return [...week].sort((a, b) => a.d.localeCompare(b.d)).map((day) => day.price / average * 100);
      });
      profiles.push(Array.from({ length: 7 }, (_, k) => mean(normalized.map((week) => week[k]))));
    }
    const points = profiles.length
      ? Array.from({ length: 7 }, (_, k) => ({ k: k + 1, price: mean(profiles.map((profile) => profile[k])) }))
      : [];
    return { basis, candidates: ids.length, observedItems, eligibleItems: profiles.length,
      maxWeeks, maxDays, points, thursdayPct: points.length ? points[3].price - 100 : null };
  });
  return { asOf, minHours, minWeeks, groups };
}
