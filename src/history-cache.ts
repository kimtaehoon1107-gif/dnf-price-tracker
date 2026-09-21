import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { hash, quote, type Store } from './archive.ts';

type Options = { label: string; day: string; order: string[] };
type Signature = { day: string; hash: string; bytes: number; rows: number };

// 장기 보관본과 달리 현재 쿼리 결과만 재사용한다. 삭제·백필·분류 변경도 해시에 반영된다.
// 호출자는 해시 확인과 다운로드를 같은 REPEATABLE READ 트랜잭션에서 실행해야 한다.
export class HistoryCache {
  stats = { queries: 0, reusedDays: 0, fetchedDays: 0, reusedBytes: 0, fetchedBytes: 0 };
  private client: PoolClient;
  private store?: Store;
  constructor(client: PoolClient, store?: Store) { this.client = client; this.store = store; }

  query = (options: Options) => async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> => {
    if (!this.store) return this.client.query<T>(sql, params);
    const { rows: settings } = await this.client.query('SHOW transaction_isolation');
    assert.equal(settings[0].transaction_isolation, 'repeatable read', '이력 재사용은 동일 DB 스냅샷이 필요합니다');
    const fields = (await this.client.query(`SELECT * FROM (${sql}) history_fields LIMIT 0`, params)).fields;
    const names = fields.map(f => f.name);
    assert.equal(new Set(names).size, names.length);
    assert(names.includes(options.day) && options.order.every(name => names.includes(name)));
    // PG의 텍스트 표현과 기존 파서를 함께 사용해 numeric 문자열·bigint·NULL을 보존한다.
    const columns = fields.map(f => `q.${quote(f.name)}::text`).join(',');
    const grouped = `WITH history_source AS (${sql}), history_numbered AS (
      SELECT q.*, row_number() OVER () AS history_position FROM history_source q
    ) SELECT left(q.${quote(options.day)}::text,10) AS day,
      jsonb_agg(jsonb_build_array(${columns}) ORDER BY history_position)::text AS payload
      FROM history_numbered q GROUP BY 1`;
    const signatures: Signature[] = (await this.client.query(`SELECT day,
      encode(sha256(convert_to(payload,'UTF8')),'hex') AS hash,
      octet_length(payload)::int AS bytes, jsonb_array_length(payload::jsonb)::int AS rows
      FROM (${grouped}) history_days ORDER BY day`, params)).rows;
    const namespace = hash(JSON.stringify({ sql, fields: fields.map(f => [f.name, f.dataTypeID]), day: options.day }));
    const key = (day: string) => `build-cache/v1/${namespace}/${day}.json.gz`;
    const payloads = new Map<string, string>();
    const missing: string[] = [];
    let reusedBytes = 0, fetchedBytes = 0;
    // R2 장애 때 전체 이력을 Supabase에서 다시 받지 않는다. 배포를 멈추고 기존 사이트를 남긴다.
    for (let i = 0; i < signatures.length; i += 8) {
      await Promise.all(signatures.slice(i, i + 8).map(async sig => {
        assert(/^\d{4}-\d{2}-\d{2}$/.test(sig.day));
        const bytes = await this.store!.get(key(sig.day));
        if (bytes) {
          const payload = gunzipSync(bytes).toString('utf8');
          if (hash(payload) === sig.hash) { payloads.set(sig.day, payload); reusedBytes += sig.bytes; return; }
        }
        missing.push(sig.day);
      }));
    }
    if (missing.length) {
      const fresh = await this.client.query(`SELECT day,payload FROM (${grouped}) history_days
        WHERE day=ANY($${params.length + 1}::text[]) ORDER BY day`, [...params, missing]);
      assert.equal(fresh.rows.length, missing.length);
      for (const { day, payload } of fresh.rows) {
        const sig = signatures.find(s => s.day === day)!;
        assert.equal(hash(payload), sig.hash, '이력 해시와 내려받은 내용 불일치');
        assert.equal(Buffer.byteLength(payload), sig.bytes);
        payloads.set(day, payload); fetchedBytes += sig.bytes;
        // 같은 날짜의 최신 계산 결과로 교체해 캐시가 시간별 사본으로 불어나지 않게 한다.
        await this.store.put(key(day), gzipSync(payload));
      }
    }
    const rows = signatures.flatMap(sig => {
      const values: (string | null)[][] = JSON.parse(payloads.get(sig.day)!);
      assert.equal(values.length, sig.rows);
      return values.map(row => {
        assert.equal(row.length, fields.length);
        return Object.fromEntries(fields.map((field, i) => [field.name,
          row[i] === null ? null : pg.types.getTypeParser(field.dataTypeID)(row[i]!)])) as T;
      });
    });
    // 날짜 파일을 합친 뒤 원래 소비 코드가 기대하는 아이템/시각 순서를 복원한다.
    rows.sort((a, b) => {
      for (const name of options.order) {
        if (a[name] === b[name]) continue;
        if (a[name] === null) return 1;
        if (b[name] === null) return -1;
        return a[name] < b[name] ? -1 : 1;
      }
      return 0;
    });
    this.stats.queries++;
    this.stats.reusedDays += signatures.length - missing.length;
    this.stats.fetchedDays += missing.length;
    this.stats.reusedBytes += reusedBytes;
    this.stats.fetchedBytes += fetchedBytes;
    console.log(`[history-cache] ${options.label}: R2 ${signatures.length - missing.length}일 / DB ${missing.length}일, ` +
      `재사용 ${reusedBytes} bytes / 다운로드 ${fetchedBytes} bytes (쿼리 결과 본문 기준)`);
    return { rows };
  };
}
