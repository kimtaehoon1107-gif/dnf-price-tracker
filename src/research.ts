// 지수 구성과 예측 시점은 고정한다. 뒤늦게 들어온 관측으로 과거 발행값을 다시 쓰지 않는다.
export const LEGACY_RESEARCH_VERSION = '2026-09-16-v1';
export const RESEARCH_VERSION = '2026-09-20-v2';
export const DAY = 86400000;
export const shiftDay = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const kstDay = (t: string) => new Date(Date.parse(t) + 9 * 3600000).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay();
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
export type Observation = { d: string; value: number | null; coverage?: number };
export type Basket = {
  id: string; label: string; basis: 'trade' | 'ask0' | 'askMax'; baseDate: string;
  members: { id: string; name: string; base: number }[];
};
export type Prediction = { model: string; d: string; h: number; value: number };
export type Issue = { series: string; origin: string; train: Observation[]; predictions: Prediction[]; counts: number[] };

export function basketSeries(basket: Basket, rows: Map<string, Observation[]>) {
  const dates = [...new Set(basket.members.flatMap((m) => (rows.get(m.id) ?? []).map((p) => p.d)))].sort();
  const byMember = basket.members.map((m) => new Map((rows.get(m.id) ?? []).map((p) => [p.d, p.value])));
  return dates.map((d) => {
    const values = basket.members.flatMap((m, i) => {
      const value = byMember[i].get(d);
      return value != null && value > 0 ? [value / m.base * 100] : [];
    });
    // 결측 종목의 비중을 남은 종목에 재배분하면 구성 변화가 수익률처럼 보인다.
    return { d, value: values.length === basket.members.length ? mean(values) : null, coverage: values.length };
  });
}

// 추세와 요일 더미를 함께 추정한다. 일요일이 기준이며 x는 실제 달력 일수다.
function weekdayFit(train: { d: string; value: number }[]) {
  const first = train[0].d;
  const features = (d: string) => [1, (Date.parse(d) - Date.parse(first)) / DAY / 7,
    ...[1, 2, 3, 4, 5, 6].map((k) => Number(weekday(d) === k))];
  const x = train.map((p) => features(p.d));
  const a = Array.from({ length: 8 }, (_, i) => [...Array.from({ length: 8 }, (_, j) =>
    x.reduce((s, r) => s + r[i] * r[j], 0)), x.reduce((s, r, k) => s + r[i] * Math.log(train[k].value), 0)]);
  for (let i = 0; i < 8; i++) {
    let pivot = i;
    for (let j = i + 1; j < 8; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    if (Math.abs(a[i][i]) < 1e-10) return null;
    const divisor = a[i][i];
    a[i] = a[i].map((v) => v / divisor);
    for (let j = 0; j < 8; j++) if (j !== i) {
      const factor = a[j][i];
      a[j] = a[j].map((v, k) => v - factor * a[i][k]);
    }
  }
  return (d: string) => Math.exp(features(d).reduce((s, v, i) => s + v * a[i][8], 0));
}

export function issueForecast(series: string, rows: Observation[], origin: string): Issue {
  const train = rows.filter((p): p is { d: string; value: number } =>
    p.d < origin && p.d >= shiftDay(origin, -56) && p.value !== null && Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
  const counts = Array.from({ length: 7 }, (_, k) => train.filter((p) => weekday(p.d) === k).length);
  const predictions: Prediction[] = [];
  // 전날 값이 없으면 오래된 호가를 오늘의 기준 예측으로 발행하지 않는다.
  if (train.at(-1)?.d !== shiftDay(origin, -1)) return { series, origin, train, predictions, counts };
  const fit = counts.every((n) => n >= 4) ? weekdayFit(train) : null;
  const byDate = new Map(train.map((p) => [p.d, p.value]));
  for (let h = 1; h <= 7; h++) {
    const d = shiftDay(origin, h);
    predictions.push({ model: 'naive', d, h, value: train.at(-1)!.value });
    let seasonalDate = shiftDay(d, -7);
    while (seasonalDate >= origin) seasonalDate = shiftDay(seasonalDate, -7);
    const seasonal = byDate.get(seasonalDate);
    if (seasonal !== undefined) predictions.push({ model: 'seasonal', d, h, value: seasonal });
    const value = fit?.(d);
    if (value !== undefined && Number.isFinite(value) && value > 0) predictions.push({ model: 'weekday', d, h, value });
  }
  return { series, origin, train, predictions, counts };
}

export function scoreIssues(issues: Issue[], actuals: Map<string, number | null>) {
  return [1, 7].flatMap((h) => ['naive', 'seasonal', 'weekday'].map((model) => {
    const cases = issues.flatMap((issue) => {
      const p = issue.predictions.find((p) => p.h === h && p.model === model);
      const naive = issue.predictions.find((p) => p.h === h && p.model === 'naive');
      const actual = p ? actuals.get(p.d) : null;
      return p && naive && actual != null && actual > 0 ? [{ p: p.value, naive: naive.value, actual }] : [];
    });
    return { h, model, n: cases.length,
      mape: cases.length ? mean(cases.map((c) => Math.abs(c.p / c.actual - 1))) * 100 : null,
      naiveMape: cases.length ? mean(cases.map((c) => Math.abs(c.naive / c.actual - 1))) * 100 : null };
  }));
}

export function eventWindow(rows: Observation[], eventDate: string, before: string) {
  const byDate = new Map(rows.filter((p) => p.d < before).map((p) => [p.d, p.value]));
  const pre = Array.from({ length: 7 }, (_, i) => shiftDay(eventDate, i - 7));
  const post = Array.from({ length: 7 }, (_, i) => shiftDay(eventDate, i));
  const values = (dates: string[]) => dates.flatMap((d) => byDate.get(d) == null ? [] : [byDate.get(d)!]);
  const a = values(pre), b = values(post);
  const ready = a.length === 7 && b.length === 7 && post.at(-1)! < before;
  return { eventDate, preFrom: pre[0], preTo: pre.at(-1), postFrom: post[0], postTo: post.at(-1),
    preN: a.length, postN: b.length, ready,
    pre: ready ? mean(a) : null, post: ready ? mean(b) : null,
    change: ready && mean(a) > 0 ? (mean(b) / mean(a) - 1) * 100 : null };
}
