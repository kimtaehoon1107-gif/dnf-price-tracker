import assert from 'node:assert/strict';

// 기존 v1 모델 해시는 보존하고, 공개 입력의 정제 규칙을 별도로 고정한다.
export const FORECAST_PREPROCESSING = { version: 'daily-median-10x-v1', timezone: 'Asia/Seoul' };

export function checkForecastPreprocessing(cleaning: any) {
  assert(cleaning, '예측 입력 정제 규칙 누락');
  assert.deepEqual({ version: cleaning.version, timezone: cleaning.timezone }, FORECAST_PREPROCESSING,
    '예측 입력 정제 규칙 변경: 새 실험 VERSION 필요');
}
