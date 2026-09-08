// 가격 예측.
//
// 모델의 성능과 시장의 성질은 별개다. naive 대비 오차와 구간 커버리지를
// 실제 달력 기준 롤링 평가로 확인하고, 실패의 원인은 단정하지 않는다.
//
// 모델: log(가격) = 추세 + 요일효과 + 잔차
//   · 추세는 최근 구간의 최소제곱 직선
//   · 요일효과는 아이템 전체에서 추정한 공통 계수(개별 아이템은 표본이 얇다)
//   · 구간은 잔차의 10/90 분위수 — 정규분포를 가정하지 않는다

export interface Point { d: string; vwap: number; n: number }
export type Market = Map<string, Point[]>;
export interface Score {
  count: number;
  mape: number | null;
  naiveMape: number | null;
  coverage: number | null;
  vsNaive: number | null;
}
export interface Forecast extends Score {
  horizonDays: number;
  points: Array<{ d: string; mid: number; lo: number; hi: number }>;
  backtest: Array<Score & { horizonDays: number }>;
  method: string;
}
export interface BacktestCase {
  origin: string; d: string; horizonDays: number;
  mid: number; lo: number; hi: number; naive: number; actual: number;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const DAY = 86400000;
const time = (d: string) => Date.parse(d + 'T00:00:00Z');
const weekday = (d: string) => ((new Date(time(d)).getUTCDay() + 6) % 7) + 1;

/** 현재·미래 날짜는 자격 판정과 정규화 평균에서도 제외해야 누출을 막을 수 있다. */
export function estimateWeekday(market: Market, before: string): Map<number, number> {
  const buckets = new Map<number, number[]>();
  for (const series of market.values()) {
    const train = series.filter((p) => p.d < before).sort((a, b) => a.d.localeCompare(b.d));
    if (!train.length || time(train.at(-1)!.d) - time(train[0].d) <= 14 * DAY
      || train.reduce((sum, p) => sum + p.n, 0) < 25) continue;
    const mean = train.reduce((sum, p) => sum + p.vwap, 0) / train.length;
    for (const p of train) {
      const k = weekday(p.d);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(Math.log(p.vwap / mean));
    }
  }
  const coefficients = [...buckets].map(([k, values]) =>
    [k, values.reduce((sum, v) => sum + v, 0) / values.length] as const);
  const mean = coefficients.reduce((sum, [, v]) => sum + v, 0) / (coefficients.length || 1);
  return new Map(coefficients.map(([k, v]) => [k, v - mean]));
}

function eligible(train: Point[]): boolean {
  if (train.length < 10) return false;
  const span = Math.max(1, (time(train.at(-1)!.d) - time(train[0].d)) / DAY + 1);
  return train.reduce((sum, p) => sum + p.n, 0) / span >= 5;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** 최소제곱 직선. x는 첫 관측일부터 실제로 흐른 달력 일수다. */
function fitLine(x: number[], y: number[]): { a: number; b: number } {
  const n = y.length;
  const sx = x.reduce((s, v) => s + v, 0);
  const sxx = x.reduce((s, v) => s + v * v, 0);
  const sy = y.reduce((s, v) => s + v, 0);
  const sxy = y.reduce((s, v, i) => s + v * x[i], 0);
  const den = n * sxx - sx * sx;
  if (den === 0) return { a: sy / n, b: 0 };
  const b = (n * sxy - sx * sy) / den;
  return { a: (sy - b * sx) / n, b };
}

function predict(
  pts: Point[],
  dow: Map<number, number>,
  horizonDays: number,
  startAfter: string,
): Forecast['points'] {
  const origin = time(pts[0].d);
  const xs = pts.map((p) => (time(p.d) - origin) / DAY);
  const logs = pts.map((p) => Math.log(p.vwap));
  const dows = pts.map((p) => weekday(p.d));

  // 요일 효과를 먼저 빼고 추세를 잡는다 — 순서를 바꾸면 요일이 추세에 스며든다
  const deseason = logs.map((v, i) => v - (dow.get(dows[i]) ?? 0));
  const { a, b } = fitLine(xs, deseason);

  const resid = deseason.map((v, i) => v - (a + b * xs[i]));
  const sorted = [...resid].sort((x, y) => x - y);
  const lo = quantile(sorted, 0.1);
  const hi = quantile(sorted, 0.9);

  const lastT = time(pts.at(-1)!.d);
  const anchorT = time(startAfter);
  const points = [];
  for (let h = 1; h <= horizonDays; h++) {
    const t = anchorT + h * DAY;
    const x = (t - origin) / DAY;
    const k = ((new Date(t).getUTCDay() + 6) % 7) + 1;
    const base = a + b * x + (dow.get(k) ?? 0);
    // 기존 구간 폭 규칙을 유지해 평가 방식 변경의 효과를 분리한다.
    // 0.45는 경험적 설정이며, 80% 커버리지를 보장하는 공식이 아니다.
    const elapsed = Math.max(1, Math.round((t - lastT) / DAY));
    const w = 1 + 0.45 * (elapsed - 1);
    points.push({ d: iso(t), mid: Math.exp(base), lo: Math.exp(base + lo * w), hi: Math.exp(base + hi * w) });
  }

  return points;
}

/** 평가 당일의 미완성 값은 쓰지 않고 운영과 동일하게 전날까지로 학습한다. */
export function rollingForecasts(series: Point[], market: Market): BacktestCase[] {
  const pts = [...series].sort((a, b) => a.d.localeCompare(b.d));
  if (pts.length < 10) return [];
  const actuals = new Map(pts.map((p) => [p.d, p.vwap]));
  const cases: BacktestCase[] = [];
  for (let t = time(pts[9].d) + DAY; t < time(pts.at(-1)!.d); t += DAY) {
    const origin = iso(t);
    const train = pts.filter((p) => p.d < origin);
    if (!eligible(train)) continue;
    const points = predict(train, estimateWeekday(market, origin), 7, origin);
    for (const h of [1, 7]) {
      const p = points[h - 1];
      const actual = actuals.get(p.d);
      // 무거래일을 다음 관측일로 대신하면 예측 거리가 달라진다.
      if (actual === undefined) continue;
      cases.push({ origin, ...p, horizonDays: h, naive: train.at(-1)!.vwap, actual });
    }
  }
  return cases;
}

export function scoreForecasts(cases: BacktestCase[]): Score {
  if (!cases.length) return { count: 0, mape: null, naiveMape: null, coverage: null, vsNaive: null };
  const mape = cases.reduce((sum, c) => sum + Math.abs(c.mid - c.actual) / c.actual, 0) / cases.length * 100;
  const naiveMape = cases.reduce((sum, c) => sum + Math.abs(c.naive - c.actual) / c.actual, 0) / cases.length * 100;
  return {
    count: cases.length, mape, naiveMape,
    coverage: cases.filter((c) => c.actual >= c.lo && c.actual <= c.hi).length / cases.length * 100,
    vsNaive: naiveMape > 0 ? (naiveMape - mape) / naiveMape * 100 : null,
  };
}

/** startAfter는 빌드 날짜다. 당일은 제외하고 내일부터 예측한다. */
export function forecast(series: Point[], market: Market, horizonDays = 7, startAfter?: string): Forecast | null {
  if (!series.length) return null;
  const sorted = [...series].sort((a, b) => a.d.localeCompare(b.d));
  const origin = startAfter ?? iso(time(sorted.at(-1)!.d) + DAY);
  const train = sorted.filter((p) => p.d < origin);
  if (!eligible(train)) return null;
  const cases = rollingForecasts(train, market);
  const backtest = [1, 7].map((h) => ({
    horizonDays: h, ...scoreForecasts(cases.filter((c) => c.horizonDays === h)),
  }));
  return {
    ...backtest[0], backtest,
    horizonDays, points: predict(train, estimateWeekday(market, origin), horizonDays, origin),
    method: '추세 + 요일효과 + 잔차 10/90 분위수',
  };
}
