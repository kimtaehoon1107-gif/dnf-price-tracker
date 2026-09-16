import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { legendarySeries, type LegendarySnapshot } from './legendary.ts';
import { basketSeries, kstDay, type Basket, type Observation } from './research.ts';

export const PACKAGE_ID = 'e974d2eac46f0c8b23b83d4da389fa57';
export const PART_IDS = ['702d33e99edb55d23cac4c9970ef44ee', 'a295bdbb26984dcb946eb3a3044dcfe5',
  '33776306aa3fa6fead55ced8656be444', '329338e9ac307d34de71a48b314b19a0', 'b971992f2529a494215fdf9368cfa0dd'];
export type ResearchSeries = { id: string; label: string; unit: string; daily: Observation[]; basket?: Basket };

export async function loadResearch(client: PoolClient, asOf: string, through: string) {
  const before = [kstDay(asOf), kstDay(through)].sort()[0];
  const trade = (await client.query<{ item_id: string; d: string; value: number; qty: number; n: number }>(`
    SELECT c.item_id, to_char(c.hour AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') d,
      (SUM(c.vwap*c.qty)/NULLIF(SUM(c.qty),0))::float8 value, SUM(c.qty)::float8 qty, SUM(c.n)::int n
    FROM candles_1h c JOIN items i USING(item_id)
    WHERE i.category <> '카드' AND c.hour < ($1::date::timestamp AT TIME ZONE 'Asia/Seoul')
    GROUP BY 1,2 ORDER BY 1,2`, [before])).rows;
  const card = (await client.query<{ item_id: string; basis: string; d: string; value: number | null; hours: number }>(`
    WITH h AS (
      SELECT DISTINCT ON (s.item_id, s.upgrade, date_trunc('hour',s.captured_at))
        s.item_id, s.upgrade, s.captured_at, s.min_unit_price
      FROM listing_snapshots s JOIN items i USING(item_id)
      WHERE i.category='카드' AND s.min_unit_price>0
        AND (s.upgrade=0 OR (s.upgrade>0 AND s.upgrade=s.upgrade_max))
        AND s.captured_at < ($1::date::timestamp AT TIME ZONE 'Asia/Seoul')
      ORDER BY s.item_id,s.upgrade,date_trunc('hour',s.captured_at),s.captured_at DESC,s.id DESC
    ) SELECT item_id, CASE WHEN upgrade=0 THEN 'ask0' ELSE 'askMax' END basis,
      to_char(captured_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') d,
      CASE WHEN COUNT(*)>=18 THEN AVG(min_unit_price)::float8 ELSE NULL END value, COUNT(*)::int hours
    FROM h GROUP BY 1,2,3 ORDER BY 1,2,3`, [before])).rows;
  const byBasis = new Map<string, Map<string, Observation[]>>();
  for (const basis of ['trade', 'ask0', 'askMax']) {
    const map = new Map<string, Observation[]>();
    for (const row of basis === 'trade' ? trade : card.filter((r) => r.basis === basis)) {
      if (!map.has(row.item_id)) map.set(row.item_id, []);
      map.get(row.item_id)!.push({ d: row.d, value: row.value });
    }
    byBasis.set(basis, map);
  }
  const snapshots = (await client.query<LegendarySnapshot>(`
    SELECT to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') captured_at,
      min_unit_price,min_item_name,p10,median,scanned,with_listings,total_listings
    FROM legendary_card_floor WHERE upgrade=0 AND captured_at <= $1::timestamptz ORDER BY captured_at,id`, [asOf])).rows;
  const legendary = legendarySeries(snapshots, asOf);
  const baskets: Basket[] = JSON.parse(readFileSync(new URL('../data/research-baskets.json', import.meta.url), 'utf8'));
  const series: ResearchSeries[] = [
    ...(['min', 'p10'] as const).map((key) => ({ id: `legendary-${key}`, label: key === 'min' ? '레전더리 전체 최저호가' : '레전더리 P10', unit: '골드',
      daily: legendary.daily.filter((p) => p.d < before).map((p) => ({ d: p.d, value: p.hours >= 18 ? p[key] : null, coverage: p.hours })) })),
    ...baskets.map((basket) => ({ id: basket.id, label: basket.label, unit: '지수', basket,
      daily: basketSeries(basket, byBasis.get(basket.basis)!) })),
  ];
  return { before, series, trade, byBasis, legendary };
}
