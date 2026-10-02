// 읽기 전용 재현: 전향 검증 기록기가 만드는 시간별 계열과 발행 함수가 후향 연구(6시간 구간 방향)의
// 예측과 같은지 보관 입력으로 대조한다. DB·API·R2에 접근하지 않는다.
//   node --max-old-space-size=4096 scripts/replay-forward-test.ts [activity-input.json] [block-direction-evidence.json]
import { readFileSync } from 'node:fs';
import { H } from '../src/activity-study.ts';
import { blockIssue, SERIES, toSeries, type SeriesKey } from '../src/forward-test.ts';

const input = JSON.parse(readFileSync(process.argv[2] ?? 'data/intraday-study/activity-input.json', 'utf8'));
const evidence = JSON.parse(readFileSync(process.argv[3] ?? 'docs/evidence/block-direction-20261002.json', 'utf8'));
const cutoff = Date.parse(input.asOf);
const hourOf = (t: string) => Math.floor(Date.parse(t) / H) * H;

// loadSeries와 같은 정의: 체결이 있었던 시간봉의 VWAP, 시간 안의 마지막 레전더리 스캔의 0업 P10.
function series(key: SeriesKey) {
  const byHour = new Map<number, number>();
  if (key === 'legendary-p10') {
    const last = new Map<number, { stamp: number; id: number; p10: number | null }>();
    for (const { table, row: r } of input.rows) if (table === 'legendary_card_floor' && r.upgrade === 0) {
      const t = hourOf(r.captured_at), stamp = Date.parse(r.captured_at), old = last.get(t);
      if (!old || stamp > old.stamp || (stamp === old.stamp && Number(r.id) > old.id)) last.set(t, { stamp, id: Number(r.id), p10: r.p10 == null ? null : Number(r.p10) });
    }
    for (const [t, v] of last) if (v.p10 != null && v.p10 > 0 && t + H <= cutoff) byHour.set(t, v.p10);
  } else {
    for (const { table, row: r } of input.rows) if (table === 'candles_1h' && r.item_id === SERIES[key].itemId && r.qty > 0 && Number(r.vwap) > 0 && Date.parse(r.hour) + H <= cutoff)
      byHour.set(Date.parse(r.hour), Number(r.vwap));
  }
  return toSeries(key, [...byHour].map(([t, price]) => ({ t, price })).sort((a, b) => a.t - b.t));
}

const result = (name: string) => evidence.results.find((r: any) => r.name === name && r.threshold === 0.5);
for (const [key, name] of [['soul-legendary', '레전더리 소울 결정'], ['legendary-p10', '레전더리 P10']] as const) {
  const s = series(key), rows = result(name).rows as { start: number; predictions: Record<string, number> }[];
  let same = 0; const diff: string[] = [];
  for (const row of rows) {
    const issue = blockIssue(s, row.start);
    if (issue.status === 'issued' && JSON.stringify(issue.predictions) === JSON.stringify(row.predictions)) same++;
    else diff.push(`${new Date(row.start).toISOString()} ${issue.status === 'issued' ? JSON.stringify(issue.predictions) : issue.reason} ≠ ${JSON.stringify(row.predictions)}`);
  }
  console.log(`${name}: 후향 연구 발행 ${rows.length}건 중 예측 일치 ${same}건 (시간별 ${s.points.length}개)`);
  for (const d of diff) console.log('  불일치', d);
}
