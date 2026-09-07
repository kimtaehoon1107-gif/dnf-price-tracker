// 가격 예측.
//
// 이 데이터로 정직하게 할 수 있는 예측의 한계를 먼저 밝힌다:
// 게임 재화 가격은 랜덤워크에 가까워서, "내일 얼마"라는 점 예측은
// "내일 = 오늘"이라는 naive 예측을 이기기 어렵다. 그래서 점 예측 대신
// 구간을 낸다 — 그리고 그 구간이 실제로 맞는지(커버리지) 함께 보고한다.
//
// 모델: log(가격) = 추세 + 요일효과 + 잔차
//   · 추세는 최근 구간의 최소제곱 직선
//   · 요일효과는 아이템 전체에서 추정한 공통 계수(개별 아이템은 표본이 얇다)
//   · 구간은 잔차의 10/90 분위수 — 정규분포를 가정하지 않는다

export interface Point { d: string; vwap: number }
export interface Forecast {
  horizonDays: number;
  points: Array<{ d: string; mid: number; lo: number; hi: number }>;
  /** naive(마지막 값 유지) 대비 MAPE 개선율. 음수면 naive가 낫다는 뜻 */
  vsNaive: number | null;
  mape: number | null;
  naiveMape: number | null;
  coverage: number | null;
  method: string;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const DAY = 86400000;

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

/**
 * @param dow 요일별 로그 편차(월=1 … 일=7). 전체 아이템에서 추정한 공통 계수.
 * @param startAfter 첫 예측은 이 날짜 다음 날부터 시작한다. 당일 미완성 봉이나
 * 오래된 마지막 체결 뒤의 과거 날짜를 예측으로 내보내지 않기 위한 기준이다.
 */
export function forecast(
  series: Point[],
  dow: Map<number, number>,
  horizonDays = 7,
  startAfter?: string,
): Forecast | null {
  // 최소 10일은 있어야 추세와 잔차 분포를 말할 수 있다
  if (series.length < 10) return null;

  const pts = [...series].sort((a, b) => a.d.localeCompare(b.d));
  const origin = Date.parse(pts[0].d + 'T00:00:00Z');
  const xs = pts.map((p) => (Date.parse(p.d + 'T00:00:00Z') - origin) / DAY);
  const logs = pts.map((p) => Math.log(p.vwap));
  const dows = pts.map((p) => ((new Date(p.d + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1);

  // 요일 효과를 먼저 빼고 추세를 잡는다 — 순서를 바꾸면 요일이 추세에 스며든다
  const deseason = logs.map((v, i) => v - (dow.get(dows[i]) ?? 0));
  const { a, b } = fitLine(xs, deseason);

  const resid = deseason.map((v, i) => v - (a + b * xs[i]));
  const sorted = [...resid].sort((x, y) => x - y);
  const lo = quantile(sorted, 0.1);
  const hi = quantile(sorted, 0.9);

  const lastT = Date.parse(pts.at(-1)!.d + 'T00:00:00Z');
  const anchorT = Math.max(lastT, startAfter ? Date.parse(startAfter + 'T00:00:00Z') : lastT);
  const n = pts.length;
  const points = [];
  for (let h = 1; h <= horizonDays; h++) {
    const t = anchorT + h * DAY;
    const x = (t - origin) / DAY;
    const k = ((new Date(t).getUTCDay() + 6) % 7) + 1;
    const base = a + b * x + (dow.get(k) ?? 0);
    // 예측이 멀어질수록 구간을 넓히되 완만하게. 잔차가 이미 "추세 대비 편차"라
    // 한 걸음치 변동이 아니므로, 랜덤워크의 √h를 그대로 곱하면 이중으로 부푼다.
    const elapsed = Math.max(1, Math.round((t - lastT) / DAY));
    const w = 1 + 0.45 * (elapsed - 1);
    points.push({ d: iso(t), mid: Math.exp(base), lo: Math.exp(base + lo * w), hi: Math.exp(base + hi * w) });
  }

  // ── 백테스트: 마지막 구간을 떼어 두고 naive와 비교한다 ──
  let mape: number | null = null, naiveMape: number | null = null, coverage: number | null = null;
  const test = Math.min(7, Math.floor(n * 0.3));
  if (test >= 3 && n - test >= 8) {
    const trainLogs = deseason.slice(0, n - test);
    const trainX = xs.slice(0, n - test);
    const f2 = fitLine(trainX, trainLogs);
    const r2 = trainLogs.map((v, i) => v - (f2.a + f2.b * trainX[i])).sort((x, y) => x - y);
    const l2 = quantile(r2, 0.1), h2 = quantile(r2, 0.9);
    const lastTrain = pts[n - test - 1].vwap;
    let e = 0, ne = 0, inBand = 0;
    for (let i = 0; i < test; i++) {
      const idx = n - test + i;
      const base = f2.a + f2.b * xs[idx] + (dow.get(dows[idx]) ?? 0);
      const pred = Math.exp(base);
      const actual = pts[idx].vwap;
      e += Math.abs(pred - actual) / actual;
      ne += Math.abs(lastTrain - actual) / actual;
      const elapsed = Math.max(1, xs[idx] - trainX.at(-1)!);
      const w = 1 + 0.45 * (elapsed - 1);
      if (actual >= Math.exp(base + l2 * w) && actual <= Math.exp(base + h2 * w)) inBand++;
    }
    mape = e / test * 100;
    naiveMape = ne / test * 100;
    coverage = inBand / test * 100;
  }

  return {
    horizonDays, points, mape, naiveMape, coverage,
    vsNaive: mape !== null && naiveMape ? (naiveMape - mape) / naiveMape * 100 : null,
    method: '추세 + 요일효과 + 잔차 10/90 분위수',
  };
}
