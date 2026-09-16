const DAY = 86400000;
const at = (d: string) => Date.parse(d + 'T00:00:00Z');
const dow = (d: string) => (new Date(at(d)).getUTCDay() + 6) % 7;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const WEEKDAY_MIN_WEEKS = 4;

/** 하루의 유효성은 가격 기준별로 먼저 판단한다. 불완전한 주는 다른 날짜로 채우지 않는다. */
export function weekdayTrend(days: { d: string; price: number }[], before: string) {
  const valid = days.filter((p) => p.d < before && Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
  const byDate = new Map(valid.map((p) => [p.d, p]));
  const unique = [...byDate.values()];
  const weeks = new Map<string, typeof days>();
  for (const p of unique) {
    const monday = new Date(at(p.d) - dow(p.d) * DAY).toISOString().slice(0, 10);
    if (!weeks.has(monday)) weeks.set(monday, []);
    weeks.get(monday)!.push(p);
  }
  const full = [...weeks.values()].filter((w) => w.length === 7);
  const ready = full.length >= WEEKDAY_MIN_WEEKS;
  const rows = full.flatMap((week) => {
    const average = mean(week.map((p) => p.price));
    return week.map((p) => {
      const previous = byDate.get(new Date(at(p.d) - DAY).toISOString().slice(0, 10));
      return { k: dow(p.d), price: p.price / average * 100,
        change: previous ? (p.price / previous.price - 1) * 100 : null };
    });
  });
  return { ready, weeks: full.length, days: unique.length,
    from: full[0]?.[0].d ?? null, to: full.at(-1)?.at(-1)?.d ?? null,
    counts: Array.from({ length: 7 }, (_, k) => unique.filter((p) => dow(p.d) === k).length),
    points: ready ? Array.from({ length: 7 }, (_, k) => {
      const group = rows.filter((p) => p.k === k);
      const changes = group.flatMap((p) => p.change === null ? [] : [p.change]);
      return { k: k + 1, price: mean(group.map((p) => p.price)), n: group.length,
        change: changes.length ? mean(changes) : null, changeN: changes.length };
    }) : [] };
}
