import type { PoolClient } from 'pg';
import { HistoryCache } from './history-cache.ts';
import { loadResearch, PACKAGE_ID, PART_IDS } from './research-data.ts';
import { RESEARCH_VERSION, eventWindow, scoreIssues, type Issue } from './research.ts';

export async function researchExport(client: PoolClient, asOf: string, through: string, cache = new HistoryCache(client)) {
  const data = await loadResearch(client, asOf, through, RESEARCH_VERSION, cache);
  const batches = (await client.query<{ origin: string; issued_at: Date; data_as_of: Date; issues: Issue[] }>(
    'SELECT origin,issued_at,data_as_of,issues FROM research_forecast_batches WHERE version=$1 ORDER BY origin', [RESEARCH_VERSION])).rows;
  const actuals = (await client.query<{ target: string; values: Record<string, number | null> }>(
    'SELECT target,values FROM research_actuals WHERE version=$1 ORDER BY target', [RESEARCH_VERSION])).rows;
  const latest = batches.at(-1);
  const series = data.series.map((s) => ({ ...s,
    issue: latest?.issues.find((i) => i.series === s.id) ?? null,
    scores: scoreIssues(batches.flatMap((b) => b.issues.filter((i) => i.series === s.id)),
      new Map(actuals.map((a) => [a.target, a.values[s.id] ?? null]))),
    settled: actuals.length, missingActuals: actuals.filter((a) => a.values[s.id] == null).length,
    members: s.basket?.members.map((m) => ({ ...m, daily: (data.byBasis.get(s.basket!.basis)?.get(m.id) ?? [])
      .map((p) => ({ d: p.d, value: p.value === null ? null : p.value / m.base * 100 })) })),
  }));
  const items = (await client.query<{ item_id: string; item_name: string }>(
    'SELECT item_id,item_name FROM items WHERE item_id=ANY($1)', [[PACKAGE_ID, ...PART_IDS]])).rows;
  const event = (await client.query<{ name: string; starts: string; ends: string; source_url: string }>(`
    SELECT name,to_char(starts_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') starts,
      to_char(ends_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') ends, source_url
    FROM events WHERE type='패키지' AND $1=ANY(related_item_ids) ORDER BY starts_at DESC LIMIT 1`, [PACKAGE_ID])).rows[0] ?? null;
  const stock = (await cache.query({ label: 'research-stock', day: 'd', order: ['d'] })<{ d: string; value: number | null; hours: number }>(`
    WITH h AS (
      SELECT DISTINCT ON (date_trunc('hour',captured_at)) captured_at,total_qty
      FROM listing_snapshots WHERE item_id=$1 AND upgrade IS NULL
        AND captured_at < ($2::date::timestamp AT TIME ZONE 'Asia/Seoul')
      ORDER BY date_trunc('hour',captured_at),captured_at DESC,id DESC
    ) SELECT to_char(captured_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') d,
      CASE WHEN COUNT(*)>=18 THEN AVG(total_qty)::float8 ELSE NULL END value, COUNT(*)::int hours
    FROM h GROUP BY 1 ORDER BY 1`, [PACKAGE_ID, data.before])).rows;
  const tradeMap = new Map(data.trade.map((p) => [`${p.item_id}/${p.d}`, p]));
  const dates = [...new Set(data.trade.filter((p) => [PACKAGE_ID, ...PART_IDS].includes(p.item_id)).map((p) => p.d))].sort();
  const benchmark = data.series.find((s) => s.id === 'soul')!;
  const daily = dates.map((d) => {
    const pkg = tradeMap.get(`${PACKAGE_ID}/${d}`);
    const parts = PART_IDS.map((id) => tradeMap.get(`${id}/${d}`));
    const sum = parts.every((p) => p?.value && p.value > 0) ? parts.reduce((s, p) => s + p!.value, 0) : null;
    return { d, price: pkg?.value ?? null, parts: sum,
      margin: sum !== null && pkg?.value ? (sum * 0.97 / pkg.value - 1) * 100 : null,
      qty: pkg?.qty ?? null, stock: stock.find((p) => p.d === d)?.value ?? null,
      benchmark: benchmark.daily.find((p) => p.d === d)?.value ?? null };
  });
  const components = PART_IDS.map((id) => ({ id, name: items.find((i) => i.item_id === id)?.item_name ?? id,
    daily: data.trade.filter((p) => p.item_id === id).map((p) => ({ d: p.d, value: p.value, qty: p.qty })) }));
  const stages = event ? [['출시', event.starts], ['판매 종료', event.ends]].filter(([, d]) => d).map(([label, d]) => ({ label, date: d,
    metrics: Object.fromEntries(['price', 'parts', 'margin', 'qty', 'stock', 'benchmark'].map((key) => [key,
      eventWindow(daily.map((p) => ({ d: p.d, value: p[key as keyof Omit<typeof p, 'd'>] })), d, data.before)])),
    components: components.map((c) => ({ id: c.id, name: c.name, ...eventWindow(c.daily, d, data.before) })),
  })) : [];
  return { version: RESEARCH_VERSION, asOf, before: data.before,
    methodNote: '9월 20일 카드의 시간별 마지막 무매물 상태를 반영하도록 집계를 수정했습니다. 수정 전 예측·평가 기록은 별도로 보존하며, 아래 성적은 수정 후 새 발행분입니다.',
    issuedAt: latest?.issued_at ?? null, origin: latest?.origin ?? null, dataAsOf: latest?.data_as_of ?? null,
    series, package: { id: PACKAGE_ID, event, daily, components, stages, fee: 0.03,
      benchmark: '소울 결정 고정 구성 지수', firstObserved: daily[0]?.d ?? null } };
}
