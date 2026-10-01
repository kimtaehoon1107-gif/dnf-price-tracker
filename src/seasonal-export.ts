import {seasonalExport,type SeasonalItem} from './seasonal-profile.ts';
import type {PoolClient} from 'pg';
export async function exportSeasonal(client:PoolClient,asOf:string) {
  const items=(await client.query("SELECT item_id,item_name,category FROM items WHERE tracked ORDER BY item_name")).rows;
  const rows=(await client.query(`
    SELECT item_id,extract(epoch FROM hour)::float8*1000 t,vwap::float8 price
    FROM candles_1h JOIN items USING(item_id)
    WHERE tracked AND category<>'카드' AND hour >= $1::timestamptz-interval '57 days' AND hour<$1::timestamptz`,[asOf])).rows;
  const snaps=(await client.query(`
    SELECT DISTINCT ON (s.item_id,date_trunc('hour',s.captured_at)) s.item_id,
      extract(epoch FROM date_trunc('hour',s.captured_at))::float8*1000 t,
      s.min_unit_price::float8 price,s.listing_count::float8 listings
    FROM listing_snapshots s JOIN items i USING(item_id)
    WHERE i.tracked AND (s.upgrade=0 OR s.upgrade IS NULL)
      AND s.captured_at >= $1::timestamptz-interval '57 days' AND s.captured_at<$1::timestamptz
    ORDER BY s.item_id,date_trunc('hour',s.captured_at),s.captured_at DESC,s.id DESC`,[asOf])).rows;
  const data:SeasonalItem[]=items.map(i=>({id:i.item_id,name:i.item_name,category:i.category,
    price:(i.category==='카드'?snaps:rows).filter(r=>r.item_id===i.item_id).map(r=>({t:r.t,price:r.price>0?r.price:null})),
    listings:snaps.filter(r=>r.item_id===i.item_id).map(r=>({t:r.t,price:r.listings}))}));
  const legendary=(await client.query(`SELECT DISTINCT ON (date_trunc('hour',captured_at))
    extract(epoch FROM date_trunc('hour',captured_at))::float8*1000 t,
    p10::float8 p10,min_unit_price::float8 min,total_listings::float8 listings
    FROM legendary_card_floor WHERE upgrade=0 AND captured_at >= $1::timestamptz-interval '57 days' AND captured_at<$1::timestamptz
    ORDER BY date_trunc('hour',captured_at),captured_at DESC,id DESC`,[asOf])).rows;
  for(const field of ['p10','min'])data.push({id:'legendary:'+field,name:'레전더리 카드 '+(field==='p10'?'P10':'최저가'),category:'레전더리 지표',
    price:legendary.map(r=>({t:r.t,price:r[field]>0?r[field]:null})),listings:legendary.map(r=>({t:r.t,price:r.listings}))});
  return seasonalExport(data,asOf);
}
