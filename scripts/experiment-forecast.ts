// 운영 모델은 변경하지 않고 같은 완료 일봉·평가 날짜로 요일 보정의 기여를 비교한다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkCandles } from '../src/candle-check.ts';
import { compareForecasts, summarizeComparison, MODELS } from '../src/forecast-comparison.ts';
import type { Point } from '../src/forecast.ts';

interface Snapshot {
  quality: Awaited<ReturnType<typeof checkCandles>>;
  before: string;
  items: { item_id: string; item_name: string; category: string }[];
  daily: (Point & { item_id: string })[];
}

async function capture(): Promise<Snapshot> {
  const { pool } = await import('../src/db.ts');
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const quality = await checkCandles(client);
      if (quality.mismatches || quality.stale) throw new Error('시간봉 정합성·최신성 검사를 통과하지 못했습니다.');
      const kstDay = (date: string) => new Date(date).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const before = [kstDay(quality.checkedAt), kstDay(quality.through)].sort()[0];
      const items = (await client.query<Snapshot['items'][number]>(`
        SELECT item_id,item_name,category FROM items
        WHERE tracked AND category <> '카드' ORDER BY item_id`)).rows;
      const daily = (await client.query<Snapshot['daily'][number]>(`
        SELECT b.item_id,to_char(hour AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS d,
               (SUM(vwap*qty)/SUM(qty))::float8 AS vwap,SUM(n)::int AS n
        FROM candles_1h b JOIN items i USING(item_id)
        WHERE i.tracked AND i.category <> '카드'
          AND (hour AT TIME ZONE 'Asia/Seoul')::date < $1::date
        GROUP BY 1,2 ORDER BY 1,2`, [before])).rows;
      await client.query('COMMIT');
      return { quality, before, items, daily };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}

try {
  const snapshot: Snapshot = process.argv[2]
    ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : await capture();
  const input = JSON.stringify(snapshot);
  const market = new Map(snapshot.items.map((item) => [item.item_id,
    snapshot.daily.filter((day) => day.item_id === item.item_id)]));
  const cases = compareForecasts(market, snapshot.before);
  const horizons = [1, 7].map((horizonDays) => ({ horizonDays,
    ...summarizeComparison(cases.filter((c) => c.horizonDays === horizonDays)) }));
  const result = {
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    implementationHash: createHash('sha256').update(Buffer.concat([
      readFileSync('src/forecast.ts'), readFileSync('src/forecast-comparison.ts'),
      readFileSync('scripts/experiment-forecast.ts'),
    ])).digest('hex'),
    inputSha256: createHash('sha256').update(input).digest('hex'),
    asOf: snapshot.quality.checkedAt, before: snapshot.before,
    candidates: snapshot.items.length, dailyPoints: snapshot.daily.length, horizons, cases,
    unscored: snapshot.items.filter((i) => !cases.some((c) => c.itemId === i.item_id)).map((i) => ({
      ...i, days: market.get(i.item_id)!.length,
      reason: market.get(i.item_id)!.length < 10 ? '완료 일봉 10개 미만' : '과거 학습 자격·목표일 관측을 함께 충족한 사례 없음',
    })),
  };
  const labels = { naive: '마지막 가격 유지', trend: '추세만', weekday: '추세+요일' };
  const fmt = (n: number | null) => n === null ? '평가 없음' : `${n.toFixed(3)}%`;
  const names = new Map(snapshot.items.map((i) => [i.item_id, i.item_name]));
  const report = [
    '# 일봉 예측 비교 실험', '',
    `- 데이터 스냅샷: ${result.asOf} · KST ${result.before} 이전 완료 일봉`,
    `- 현재 추적 중인 체결가 종목 ${result.candidates}종 · 일봉 ${result.dailyPoints}개 · 카드 호가는 제외`,
    `- 시간봉 원본 대조: ${snapshot.quality.bars}봉 · 불일치 ${snapshot.quality.mismatches}봉 · 집계 대기 원본 ${snapshot.quality.pendingTrades}건`,
    `- 입력 SHA-256: \`${result.inputSha256}\``,
    `- 비교 코드 SHA-256: \`${result.implementationHash}\``, '',
    '## 비교 조건', '',
    '- 세 모델은 동일한 종목·예측 기준일·목표일을 평가합니다. 현재 예측 제공 여부로 과거 평가 대상을 거르지 않습니다.',
    '- 각 기준일 전날까지의 완료 일봉 10개 이상, 학습 기간 일평균 체결 5건 이상을 적용합니다. 무거래일은 채우지 않습니다.',
    '- 마지막 가격 유지는 그 기준일에 알려진 마지막 완료 일봉 VWAP입니다. 추세만 모델은 운영 코드의 요일 계수를 0으로 둡니다.',
    '- 추세+요일은 운영 모델 그대로입니다. 공통 요일 계수도 매 기준일 이전 자료와 당시 자격으로 다시 계산합니다. 조정할 매개변수를 이번 결과에서 고르지 않았습니다.',
    '- 1일·7일은 예측 기준일 이후 달력 일수입니다. 당일 값을 학습하지 않으므로 마지막 관측일로부터는 최소 2일·8일 뒤입니다.',
    '- MAPE는 절대 백분율 오차의 평균이며 작을수록 좋습니다. 사례 가중은 모든 평가를 동일하게, 종목 동일 비중은 종목별 MAPE를 동일하게 평균합니다.', '',
    '## 전체 결과', '',
    '| 거리 | 종목 | 평가 건수 | 서로 다른 기준일 | 방식 | 사례 가중 MAPE | 종목 동일 비중 MAPE |',
    '|---|---:|---:|---:|---|---:|---:|',
    ...horizons.flatMap((h) => MODELS.map((m) =>
      `| ${h.horizonDays}일 | ${h.items} | ${h.count} | ${h.origins.length} | ${labels[m]} | ${fmt(h.caseWeightedMape[m])} | ${fmt(h.itemWeightedMape[m])} |`)), '',
    ...horizons.flatMap((h) => [
      `## ${h.horizonDays}일 뒤 · 종목별 결과`, '',
      `기준일 ${h.origins[0] ?? '-'}~${h.origins.at(-1) ?? '-'} · 목표일 ${h.targets[0] ?? '-'}~${h.targets.at(-1) ?? '-'} (${h.targets.length}일).`,
      `요일 추가 후 종목별 오차: 개선 ${h.weekdayVsTrend.better}종 · 동일 ${h.weekdayVsTrend.tied}종 · 악화 ${h.weekdayVsTrend.worse}종.`, '',
      '| 아이템 | 평가 건수 | 마지막 가격 유지 | 추세만 | 추세+요일 | 요일 추가에 따른 오차 변화(%p) |',
      '|---|---:|---:|---:|---:|---:|',
      ...h.perItem.map((i) => `| ${names.get(i.itemId)} | ${i.count} | ${fmt(i.mape.naive)} | ${fmt(i.mape.trend)} | ${fmt(i.mape.weekday)} | ${(i.mape.weekday - i.mape.trend).toFixed(3)} |`), '',
    ]),
    `## 평가 사례가 없는 종목 ${result.unscored.length}종`, '',
    '학습 조건을 충족한 시점 이후에 실제 목표일 가격까지 있어야 평가할 수 있습니다. 가격 이력이 있다고 모두 평가 대상이 되는 것은 아닙니다.', '',
    '| 아이템 | 완료 일봉 | 사유 |', '|---|---:|---|',
    ...result.unscored.map((i) => `| ${i.item_name} | ${i.days} | ${i.reason} |`), '',
    '## 해석 범위', '',
    '- 요일 추가에 따른 오차 변화는 음수면 개선, 양수면 악화입니다. 이번 표본의 기술적 비교이며 통계적 유의성 검정 결과가 아닙니다.',
    '- 겹치는 학습 기간·공통 목표일·종목 간 상관이 있어 평가 건수를 독립 표본 수로 해석하지 않습니다.',
    '- 백필을 포함한 체결 시각 기준 재구성입니다. 당시 수집기가 보유한 자료의 재현이나 실제로 저장했던 미래 예측의 평가는 아닙니다.',
    '- 현재 추적 목록 기준이므로 과거 전체 시장을 대표하지 않습니다. API 누락과 표본 부족, 현재 예측 페이지와의 대상 차이가 있습니다.',
    '- 이번 결과만으로 운영 모델을 자동 교체하지 않습니다. 별도 미래 기간에 예측을 고정해 평가해야 합니다.', '',
    '## 재실행', '',
    '`npm run experiment:forecast`로 새 DB 스냅샷을 읽습니다. DB는 읽기 전용으로 접근합니다.',
    '`node --no-warnings scripts/experiment-forecast.ts <input.json 경로>`로 저장한 입력을 재평가합니다.',
    '입력과 상세 사례는 공개 저장소에서 제외된 `data/experiments/`에 저장합니다.', '',
  ].join('\n');
  const out = resolve('data/experiments', `forecast-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/input.json`, input);
  writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${out}/report.md`, report);
  console.log(report.split('## 1일 뒤')[0]);
  console.log(`상세 보고서: ${out}/report.md`);
} catch (error) {
  // 연결 오류에 포함될 수 있는 자격증명을 실행 로그에 남기지 않는다.
  console.error('예측 비교 실험 실패:', (error as { code?: string }).code ?? (error as Error).name);
  process.exitCode = 1;
}
