import assert from 'node:assert/strict';
import { day, shift } from './daily-forecast-ledger.ts';

// 자정 직후 최신 집계에 아직 당일 완료 시간봉이 없는 경우만 정상 대기한다.
// 오래된 자료·정합성 오류·02시 이후 지연은 기존 checkSnapshot에서 계속 실패한다.
export function dailySnapshotPending(summary: any, now: string) {
  const age = Date.parse(now) - Date.parse(summary.priceAsOf);
  const hour = new Date(Date.parse(now) + 9 * 3600000).getUTCHours();
  return hour < 2 && age >= 0 && age <= 3 * 3600000
    && summary.quality?.stale === false && summary.quality.mismatches === 0
    && day(summary.priceAsOf) === day(now) && day(summary.quality.through) === shift(day(now), -1);
}

// 기존 v1 모델 해시는 보존하고, 공개 입력의 정제 규칙을 별도로 고정한다.
export const FORECAST_PREPROCESSING = { version: 'daily-median-10x-v1', timezone: 'Asia/Seoul' };

export function checkForecastPreprocessing(cleaning: any) {
  assert(cleaning, '예측 입력 정제 규칙 누락');
  assert.deepEqual({ version: cleaning.version, timezone: cleaning.timezone }, FORECAST_PREPROCESSING,
    '예측 입력 정제 규칙 변경: 새 실험 VERSION 필요');
}

export function dailyWorkComplete(origin: string, hour: number, issues: { origin: string }[], targets: string[], actuals: { target: string }[]) {
  return hour >= 2 && issues.some(i => i.origin === origin) && targets.every(d => actuals.some(a => a.target === d));
}
