// 전향 검증 FT1의 DB 연결부. 판단 규칙은 forward-test.ts에 있고 여기서는 읽고 쓰기만 한다.
import { D } from './activity-study.ts';
import { shiftDay } from './research.ts';
import {
  BLOCK, BLOCK_ISSUE_WINDOW, FT_START, FT_VERSION, HYPOTHESES, SERIES, SETTLE_WAIT,
  blockActual, blockIssue, blockStartAtOrBefore, forwardTestReport, gameDayOf, gameDayStart, mondayOf, toSeries, weekActual, weekPlan,
  type ActualRow, type IssueRow, type SeriesKey, type WeekSpec,
} from './forward-test.ts';

export type Queryable = { query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> };

/** 시간별 가격 계열을 읽는다. 시간봉 집계가 끝난 시간(through 이전)만 쓰며 관측 없는 시간은 비워 둔다. */
export async function loadSeries(reader: Queryable, through: number) {
  const from = new Date(through - 45 * D), to = new Date(through);
  const ids = Object.values(SERIES).flatMap((s) => (s.itemId ? [s.itemId] : []));
  // 기록기가 엉뚱한 종목에 발행하지 않도록 고정한 ID와 이름을 대조한다.
  const names = (await reader.query<{ item_id: string; item_name: string }>(
    'SELECT item_id,item_name FROM items WHERE item_id=ANY($1)', [ids])).rows;
  for (const s of Object.values(SERIES)) if (s.itemId && names.find((n) => n.item_id === s.itemId)?.item_name !== s.label)
    throw new Error('고정한 종목 ID와 이름이 다릅니다');
  const candles = (await reader.query<{ item_id: string; t: number; price: number }>(`
    SELECT item_id, (extract(epoch FROM hour)*1000)::float8 AS t, vwap::float8 AS price
    FROM candles_1h WHERE item_id=ANY($1) AND hour>=$2 AND hour<$3 AND qty>0 AND vwap>0
    ORDER BY item_id, hour`, [ids, from, to])).rows;
  // 시간 안의 마지막 기록을 먼저 고른 뒤 가격의 유무를 본다. 앞선 가격으로 채우지 않는다.
  const p10 = (await reader.query<{ t: number; price: number }>(`
    SELECT t, price FROM (
      SELECT DISTINCT ON (date_trunc('hour', captured_at)) (extract(epoch FROM date_trunc('hour', captured_at))*1000)::float8 AS t,
        p10::float8 AS price
      FROM legendary_card_floor WHERE upgrade=0 AND captured_at>=$1 AND captured_at<$2
      ORDER BY date_trunc('hour', captured_at), captured_at DESC, id DESC) last
    WHERE price>0 ORDER BY t`, [from, to])).rows;
  const out = new Map<SeriesKey, ReturnType<typeof toSeries>>();
  for (const [key, s] of Object.entries(SERIES) as [SeriesKey, (typeof SERIES)[SeriesKey]][])
    out.set(key, toSeries(key, key === 'legendary-p10' ? p10 : candles.filter((c) => c.item_id === s.itemId)));
  return out;
}

const toMs = (v: unknown) => new Date(v as string | Date).getTime();

/**
 * 발행과 실측 확정을 한 번 수행한다. 이미 있는 행은 덮어쓰지 않고, 늦은 발행은 만들지 않는다.
 * 호출자가 writer의 트랜잭션을 연다.
 */
export async function recordForwardTest(writer: Queryable, reader: Queryable, quality: { checkedAt: string; through: string }, clockMs?: number) {
  const asOf = toMs(quality.checkedAt), through = toMs(quality.through);
  const result = { issued: 0, skipped: 0, settled: 0, idle: false };
  if (asOf < FT_START) return { ...result, idle: true };
  // 발행 시각의 기준은 DB 시계다(clockMs는 시계를 고정해야 하는 테스트용). 시간 안에 못 낸 발행은 소급해서 만들지 않으며, 보고서가 누락으로 센다.
  const clock = clockMs ?? toMs((await writer.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now);
  const series = await loadSeries(reader, through);
  const insertIssue = async (hypothesis: string, target: string, payload: unknown) =>
    ((await writer.query(`INSERT INTO forward_test_issues(version,hypothesis,target,issued_at,data_as_of,payload)
      VALUES($1,$2,$3,clock_timestamp(),$4,$5) ON CONFLICT DO NOTHING`,
    [FT_VERSION, hypothesis, target, quality.checkedAt, JSON.stringify(payload)])).rowCount ?? 0) > 0;

  // 6시간 구간: 가장 최근 경계 τ의 다음 구간을 τ 이전에 끝난 자료로만 예측한다.
  const tau = blockStartAtOrBefore(asOf);
  if (tau >= FT_START && through >= tau) {
    for (const h of HYPOTHESES) if (h.kind === 'block') {
      if (clock >= tau + BLOCK_ISSUE_WINDOW) continue;
      const issue = blockIssue(series.get(h.series)!, tau);
      if (await insertIssue(h.id, new Date(tau).toISOString(), issue)) result[issue.status === 'issued' ? 'issued' : 'skipped']++;
    }
  }
  // 주간 비교: 비교할 첫 날이 시작하기 전에 그 주 몫을 한 번 발행한다.
  const monday = mondayOf(gameDayOf(asOf));
  for (const h of HYPOTHESES) if (h.kind === 'week') {
    const plan = weekPlan(h, monday);
    if (plan.issueFrom < FT_START || clock >= plan.issueUntil) continue;
    if (await insertIssue(h.id, monday, { status: 'issued', hypothesis: h.id, series: h.series, expect: h.expect,
      baseDay: plan.baseDay, targetDay: plan.targetDay })) result.issued++;
  }
  // 실측: 대상이 끝나고 24시간이 지난 발행분을 그 시점의 자료로 한 번만 확정한다.
  const open = (await writer.query<{ hypothesis: string; target: string }>(`
    SELECT i.hypothesis,i.target FROM forward_test_issues i
    WHERE i.version=$1 AND i.payload->>'status'='issued' AND NOT EXISTS (
      SELECT 1 FROM forward_test_actuals a WHERE a.version=i.version AND a.hypothesis=i.hypothesis AND a.target=i.target)
    ORDER BY i.target`, [FT_VERSION])).rows;
  for (const row of open) {
    const spec = HYPOTHESES.find((h) => h.id === row.hypothesis);
    if (!spec) continue;
    let values;
    if (spec.kind === 'block') {
      const start = Date.parse(row.target);
      if (asOf < start + BLOCK + SETTLE_WAIT || through < start + BLOCK) continue;
      values = blockActual(series.get(spec.series)!, start);
    } else {
      const plan = weekPlan(spec as WeekSpec, row.target);
      if (asOf < plan.settleAt || through < gameDayStart(shiftDay(plan.targetDay, 1))) continue;
      values = weekActual(spec as WeekSpec, series.get(spec.series)!, plan);
    }
    result.settled += (await writer.query(`INSERT INTO forward_test_actuals(version,hypothesis,target,settled_at,values)
      VALUES($1,$2,$3,clock_timestamp(),$4) ON CONFLICT DO NOTHING`,
    [FT_VERSION, row.hypothesis, row.target, JSON.stringify(values)])).rowCount ?? 0;
  }
  return result;
}

/** 정적 사이트용 보고서. 테이블이 아직 없으면 null이며 빌드는 계속한다. */
export async function readForwardTestReport(client: Queryable, asOf: number) {
  if (!(await client.query<{ t: string | null }>(`SELECT to_regclass('forward_test_issues') AS t`)).rows[0].t) return null;
  const issues = (await client.query<IssueRow>(
    'SELECT hypothesis,target,issued_at,payload FROM forward_test_issues WHERE version=$1 ORDER BY hypothesis,target', [FT_VERSION])).rows;
  const actuals = (await client.query<ActualRow>(
    'SELECT hypothesis,target,settled_at,values FROM forward_test_actuals WHERE version=$1 ORDER BY hypothesis,target', [FT_VERSION])).rows;
  return forwardTestReport(issues, actuals, asOf);
}
