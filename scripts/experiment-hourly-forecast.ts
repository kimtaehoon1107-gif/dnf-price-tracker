// 일봉 모델을 건드리지 않고 시간봉 해상도가 실제로 naive를 이기는지 비교한다.
// 빈 시간은 가격 0이나 직전 값으로 채우지 않고, 실제 경과시간을 x축으로 쓴다.

import { readFileSync } from 'node:fs';
import { query, pool } from '../src/db.ts';

interface HourPoint { item_id: string; t: Date; vwap: number }
interface Prepared { itemId: string; points: HourPoint[]; test: number }

const fitLine = (x: number[], y: number[]) => {
  const n = y.length;
  const sx = x.reduce((sum, value) => sum + value, 0);
  const sxx = x.reduce((sum, value) => sum + value * value, 0);
  const sy = y.reduce((sum, value) => sum + value, 0);
  const sxy = y.reduce((sum, value, index) => sum + value * x[index], 0);
  const denominator = n * sxx - sx * sx;
  if (denominator === 0) return { a: sy / n, b: 0 };
  const b = (n * sxy - sx * sy) / denominator;
  return { a: (sy - b * sx) / n, b };
};

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const kstHour = (date: Date) => (date.getUTCHours() + 9) % 24;

const rows = (await query<HourPoint>(`
  SELECT b.item_id, b.hour AS t, b.vwap::float8 AS vwap
  FROM candles_1h b JOIN items i USING (item_id)
  WHERE i.tracked AND i.category <> '카드'
  ORDER BY b.item_id, b.hour`)).rows;
const grouped = new Map<string, HourPoint[]>();
for (const row of rows) {
  if (!grouped.has(row.item_id)) grouped.set(row.item_id, []);
  grouped.get(row.item_id)!.push(row);
}

const prepared: Prepared[] = [...grouped].flatMap(([itemId, points]) => {
  if (points.length < 24) return [];
  const test = Math.min(24, Math.floor(points.length * 0.3));
  return points.length - test >= 16 && test >= 6 ? [{ itemId, points, test }] : [];
});

// 공통 시간대 계수는 각 아이템 훈련 구간을 자기 평균으로 정규화한 뒤 계산한다.
// 홀드아웃 구간은 계수 추정에 넣지 않아 미래 정보를 미리 보지 않는다.
const hourBuckets = Array.from({ length: 24 }, () => [] as number[]);
for (const item of prepared) {
  const train = item.points.slice(0, -item.test);
  const logs = train.map((point) => Math.log(point.vwap));
  const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  train.forEach((point, index) => hourBuckets[kstHour(point.t)].push(logs[index] - mean));
}
const rawHourCoef = hourBuckets.map((bucket) => bucket.length
  ? bucket.reduce((sum, value) => sum + value, 0) / bucket.length
  : 0);
const coefficientMean = rawHourCoef.reduce((sum, value) => sum + value, 0) / rawHourCoef.length;
const hourCoef = rawHourCoef.map((value) => value - coefficientMean);

const growthCandidates = [0, 0.02, 0.05, 0.1];
const coverageHits = new Map(growthCandidates.map((growth) => [growth, 0]));
let observations = 0;
let modelError = 0;
let naiveError = 0;
const itemResults: Array<{ itemId: string; model: number; naive: number }> = [];

for (const item of prepared) {
  const { points, test } = item;
  const origin = points[0].t.getTime();
  const x = points.map((point) => (point.t.getTime() - origin) / 3_600_000);
  const logs = points.map((point) => Math.log(point.vwap));
  const trainLength = points.length - test;
  const trainX = x.slice(0, trainLength);
  const trainLogs = logs.slice(0, trainLength)
    .map((value, index) => value - hourCoef[kstHour(points[index].t)]);
  const line = fitLine(trainX, trainLogs);
  const residuals = trainLogs
    .map((value, index) => value - (line.a + line.b * trainX[index]))
    .sort((a, b) => a - b);
  const lowResidual = quantile(residuals, 0.1);
  const highResidual = quantile(residuals, 0.9);
  const lastTrainPrice = points[trainLength - 1].vwap;
  const lastTrainX = trainX.at(-1)!;
  let itemModelError = 0;
  let itemNaiveError = 0;

  for (let index = trainLength; index < points.length; index++) {
    const base = line.a + line.b * x[index] + hourCoef[kstHour(points[index].t)];
    const predicted = Math.exp(base);
    const actual = points[index].vwap;
    const modelAbsoluteError = Math.abs(predicted - actual) / actual;
    const naiveAbsoluteError = Math.abs(lastTrainPrice - actual) / actual;
    modelError += modelAbsoluteError;
    naiveError += naiveAbsoluteError;
    itemModelError += modelAbsoluteError;
    itemNaiveError += naiveAbsoluteError;
    observations++;

    const elapsedHours = Math.max(1, x[index] - lastTrainX);
    for (const growth of growthCandidates) {
      const width = 1 + growth * (elapsedHours - 1);
      const inside = actual >= Math.exp(base + lowResidual * width)
        && actual <= Math.exp(base + highResidual * width);
      if (inside) coverageHits.set(growth, coverageHits.get(growth)! + 1);
    }
  }
  itemResults.push({
    itemId: item.itemId,
    model: itemModelError / test * 100,
    naive: itemNaiveError / test * 100,
  });
}

const coverages = growthCandidates.map((growth) => ({
  growth,
  coverage: coverageHits.get(growth)! / observations * 100,
}));
const calibrated = coverages.reduce((best, candidate) =>
  Math.abs(candidate.coverage - 80) < Math.abs(best.coverage - 80) ? candidate : best);
const modelMape = modelError / observations * 100;
const naiveMape = naiveError / observations * 100;
const wins = itemResults.filter((result) => result.model < result.naive).length;

const summary = JSON.parse(readFileSync('dist/data/summary.json', 'utf8'));
const daily = summary.items.filter((item: { fc?: { vsNaive: number | null } }) =>
  item.fc?.vsNaive != null);
const dailyAverageImprovement = daily.length
  ? daily.reduce((sum: number, item: { fc: { vsNaive: number } }) => sum + item.fc.vsNaive, 0) / daily.length
  : null;

console.log(`시간봉 대상 ${prepared.length}종 · 홀드아웃 ${observations.toLocaleString()}봉 · 빈 시간은 결측 유지`);
console.log(`시간봉 MAPE ${modelMape.toFixed(2)}% · naive ${naiveMape.toFixed(2)}% · ${wins}/${prepared.length}종 승리`);
console.log(`80% 구간 후보 ${coverages.map((row) => `g=${row.growth.toFixed(2)} ${row.coverage.toFixed(1)}%`).join(' · ')}`);
console.log(`현재 표본 최적 후보 g=${calibrated.growth.toFixed(2)} · 커버리지 ${calibrated.coverage.toFixed(1)}%`);
console.log(`일봉 예측 ${daily.length}종 · naive 대비 평균 개선 ${dailyAverageImprovement?.toFixed(1) ?? '-'}%`);
console.log(modelMape < naiveMape
  ? '실험 결과: 시간봉 모델이 평균 MAPE에서 naive를 이겼습니다. 별도 검증 뒤 병행 표시는 검토할 수 있습니다.'
  : '실험 결과: 시간봉 모델이 naive를 이기지 못했습니다. 운영 일봉 모델은 유지합니다.');

await pool.end();
