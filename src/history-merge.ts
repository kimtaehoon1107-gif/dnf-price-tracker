// 전환 전 검증용: R2에서 복원한 출처별 테이블을 임시 테이블로 합친다.
// 운영 연결/수집 전환/보존 정책을 변경하지 않는다. 출처별 id를 전역 키로 쓰지 않는다.
import assert from 'node:assert/strict';
import type { Client, PoolClient } from 'pg';
import { quote } from './archive.ts';

type DB = Client | PoolClient;
export type HistoryOwner = { itemId: string; source: string; from: string | null; to: string | null };
const tradeKey = 'item_id,sold_date,unit_price,count,reinforce,dup_seq';
const tradeColumns = 'item_id,sold_date,unit_price,count,price,reinforce,refine,amplification_name,dup_seq,ingested_at';
const snapshotColumns = 'item_id,captured_at,min_unit_price,p10,p25,median,listing_count,total_qty,upgrade,upgrade_max';

function sourcesSql(sources: string[], table: string, columns: string) {
  assert(sources.length > 0 && new Set(sources).size === sources.length, '출처가 비었거나 중복됐습니다');
  return sources.map((schema, rank) => {
    quote(schema); // 식별자 이외의 입력을 SQL에 넣지 않는다.
    return `SELECT ${rank}::int AS source_rank, '${schema}'::text AS source_schema,
      id AS source_id, ${columns} FROM ${quote(schema)}.${quote(table)}`;
  }).join(' UNION ALL ');
}

async function requireTransaction(client: DB) {
  // 결과를 소비하기 전에 입력 집합이 바뀌지 않도록 호출자가 스냅샷을 고정한다.
  const isolation = (await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
  assert.equal(isolation, 'repeatable read', 'REPEATABLE READ 트랜잭션이 필요합니다');
}

export async function mergeTradeHistory(client: DB, sources: string[], asOf: string) {
  await requireTransaction(client);
  assert(Number.isFinite(Date.parse(asOf)), '기준 시각 필요');
  await client.query(`CREATE TEMP TABLE history_trade_input ON COMMIT DROP AS
    SELECT * FROM (${sourcesSql(sources, 'trades', tradeColumns)}) t
    WHERE ingested_at <= $1::timestamptz AND sold_date <= $1::timestamptz`, [asOf]);
  // 한 출처 안의 중복은 잘못된 복원일 수 있다. 합치면서 숨기지 않는다.
  const duplicates = (await client.query(`SELECT 1 FROM history_trade_input
    GROUP BY source_schema,${tradeKey} HAVING COUNT(*)>1 LIMIT 1`)).rowCount;
  assert.equal(duplicates, 0, '한 출처 안에 자연키 중복 체결이 있습니다');
  const conflicts = (await client.query(`SELECT 1 FROM history_trade_input
    GROUP BY ${tradeKey}
    HAVING COUNT(DISTINCT jsonb_build_array(price,refine,amplification_name))>1 LIMIT 1`)).rowCount;
  assert.equal(conflicts, 0, '같은 체결 자연키의 내용이 출처별로 다릅니다');
  // 기존 출처 순서와 그 안의 id 순서를 보존한다. 동일 초 OHLC의 순서가 바뀌지 않게 한다.
  // 새 id는 이 임시 분석 DB 안에서만 유효하다. 운영 raw_max_id로 재사용하지 않는다.
  await client.query(`CREATE TEMP TABLE merged_trades ON COMMIT DROP AS
    WITH ranked AS (
      SELECT *,row_number() OVER (PARTITION BY ${tradeKey} ORDER BY source_rank,source_id) AS copy
      FROM history_trade_input
    ) SELECT row_number() OVER (ORDER BY source_rank,source_id)::bigint AS id,
      source_schema,source_id,${tradeColumns} FROM ranked WHERE copy=1`);
  await client.query('CREATE UNIQUE INDEX ON merged_trades (item_id,sold_date,unit_price,count,reinforce,dup_seq)');
  return (await client.query(`SELECT
    (SELECT COUNT(*)::int FROM history_trade_input) AS observations,
    COUNT(*)::int AS trades,COALESCE(SUM(count),0)::text AS qty,
    COALESCE(SUM(price::numeric),0)::text AS amount FROM merged_trades`)).rows[0];
}

export async function mergeSnapshotHistory(client: DB, sources: string[], owners: HistoryOwner[], asOf: string) {
  await requireTransaction(client);
  assert(Number.isFinite(Date.parse(asOf)), '기준 시각 필요');
  assert(owners.length > 0 && owners.every(o => sources.includes(o.source)), '관측 담당 출처를 명시해야 합니다');
  await client.query(`CREATE TEMP TABLE history_owners (
    item_id text NOT NULL,source_schema text NOT NULL,from_at timestamptz,to_at timestamptz,
    CHECK(from_at IS NULL OR to_at IS NULL OR from_at<to_at)) ON COMMIT DROP`);
  for (const owner of owners) await client.query('INSERT INTO history_owners VALUES ($1,$2,$3,$4)',
    [owner.itemId, owner.source, owner.from, owner.to]);
  const overlap = (await client.query(`SELECT 1 FROM history_owners a JOIN history_owners b
    ON a.item_id=b.item_id AND a.ctid<b.ctid
    AND tstzrange(a.from_at,a.to_at,'[)') && tstzrange(b.from_at,b.to_at,'[)') LIMIT 1`)).rowCount;
  assert.equal(overlap, 0, '같은 시각의 관측 담당이 겹칩니다');
  // 빈 구간은 실제 관측이 없더라도 놓치지 않는다.
  const gaps = (await client.query(`WITH ordered AS (
    SELECT *,row_number() OVER w AS n,lag(to_at) OVER w AS previous_end
    FROM history_owners WINDOW w AS (PARTITION BY item_id ORDER BY from_at NULLS FIRST)
  ) SELECT 1 FROM ordered WHERE n>1 AND previous_end IS DISTINCT FROM from_at LIMIT 1`)).rowCount;
  assert.equal(gaps, 0, '관측 담당 전환에 공백이 있습니다');
  await client.query(`CREATE TEMP TABLE history_snapshot_input ON COMMIT DROP AS
    SELECT * FROM (${sourcesSql(sources, 'listing_snapshots', snapshotColumns)}) s
    WHERE captured_at <= $1::timestamptz`, [asOf]);
  const missingOwner = (await client.query(`SELECT 1 FROM history_snapshot_input s WHERE NOT EXISTS (
    SELECT 1 FROM history_owners o WHERE o.item_id=s.item_id
      AND tstzrange(o.from_at,o.to_at,'[)') @> s.captured_at) LIMIT 1`)).rowCount;
  assert.equal(missingOwner, 0, '담당 출처가 없는 관측 구간입니다');
  await client.query(`CREATE TEMP TABLE history_owned_snapshots ON COMMIT DROP AS
    SELECT s.* FROM history_snapshot_input s JOIN history_owners o
      ON o.item_id=s.item_id AND o.source_schema=s.source_schema
      AND tstzrange(o.from_at,o.to_at,'[)') @> s.captured_at`);
  const conflicts = (await client.query(`SELECT 1 FROM history_owned_snapshots
    GROUP BY item_id,captured_at,COALESCE(upgrade,-1)
    HAVING COUNT(*)>1 LIMIT 1`)).rowCount;
  assert.equal(conflicts, 0, '관측 담당 출처에 같은 시각·단계의 중복 스냅샷이 있습니다');
  await client.query(`CREATE TEMP TABLE merged_listing_snapshots ON COMMIT DROP AS
    SELECT row_number() OVER (ORDER BY source_rank,source_id)::bigint AS id,
      source_schema,source_id,${snapshotColumns} FROM history_owned_snapshots`);
  return (await client.query(`SELECT
    (SELECT COUNT(*)::int FROM history_snapshot_input) AS observations,
    COUNT(*)::int AS snapshots FROM merged_listing_snapshots`)).rows[0];
}
