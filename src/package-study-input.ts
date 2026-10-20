import assert from 'node:assert/strict';
import type { Client } from 'pg';
import type { Input, Member, Day } from './package-study.ts';

export const PACKAGE_PRICE_BASIS = 'raw-candles-1h-v1';
export type PackageStudyInput = Input & { priceBasis: typeof PACKAGE_PRICE_BASIS };

// 사전 등록 연구는 화면용 극단값 필터와 분리한 원본 시간봉으로 계산한다.
export async function loadPackageStudyInput(client: Pick<Client, 'query'>, members: Member[], asOf: string): Promise<PackageStudyInput> {
  const { rows } = await client.query<{ item_id: string } & Day>(`
    SELECT item_id, to_char((hour AT TIME ZONE 'Asia/Seoul')::date,'YYYY-MM-DD') AS d,
      (SUM(vwap*qty)/SUM(qty))::float8 AS vwap, SUM(n)::int AS n
    FROM public.candles_1h
    WHERE item_id=ANY($1::text[])
    GROUP BY 1,2 ORDER BY 1,2`, [members.map(m => m.id)]);
  const series: Input['series'] = Object.fromEntries(members.map(m => [m.id, []]));
  for (const { item_id, d, vwap, n } of rows) series[item_id].push({ d, vwap, n });
  return { priceBasis: PACKAGE_PRICE_BASIS, asOf, members, series };
}

export function checkPackageStudyInput(input: PackageStudyInput, members: Member[], asOf: string) {
  assert.equal(input.priceBasis, PACKAGE_PRICE_BASIS, '패키지 연구는 원본 시간봉 입력만 사용합니다');
  assert.equal(input.asOf, asOf, '패키지 연구 입력과 사이트 기준 시각 불일치');
  assert.deepEqual(input.members, members, '패키지 연구 고정 구성 불일치');
}
