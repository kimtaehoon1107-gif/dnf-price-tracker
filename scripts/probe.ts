// 아이템 후보의 거래 빈도를 재서 폴링 주기를 정한다.
//
// 화이트리스트를 넓힐 때 감이 아니라 숫자로 정하기 위한 도구.
//   node --no-warnings scripts/probe.ts "태초 소울 결정" "무결점 조화의 결정체"
//   node --no-warnings scripts/probe.ts --search 결정
//
// 핵심 판단: 100건이 덮는 시간(span)이 짧을수록 지금 당장 등록해야 한다.
// 백필로 확보되는 히스토리가 그만큼 짧아서, 늦게 넣으면 그 구간은 영영 사라지기 때문이다.

import { searchItems, getSold, getAuction, kstToIso } from '../src/api.ts';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('사용법: probe.ts <아이템명...> | probe.ts --search <키워드>');
  process.exit(1);
}

if (args[0] === '--search') {
  const rows = await searchItems(args[1], 'full', 30);
  console.log(`"${args[1]}" 검색 결과 ${rows.length}건\n`);
  for (const r of rows) {
    console.log(`  ${r.itemId}  ${r.itemName}  [${r.itemRarity}/${r.itemTypeDetail}]`);
  }
  process.exit(0);
}

function recommend(spanMin: number | null, rows: number): string {
  if (spanMin === null) return '거래 없음 — 추적 가치 재검토';
  if (rows < 100) return `저빈도 · 3600초 — 백필로 ${(spanMin / 1440).toFixed(0)}일치 확보됨. 급하지 않음`;
  if (spanMin < 20) return `★ 초고빈도 · ${Math.max(60, Math.floor(spanMin * 60 * 0.15))}초 — 지금 등록하세요`;
  if (spanMin < 120) return `고빈도 · 300초`;
  if (spanMin < 1440) return `중빈도 · 900초`;
  return `저빈도 · 3600초`;
}

for (const name of args) {
  const found = await searchItems(name, 'match', 1);
  if (found.length === 0) {
    console.log(`\n✗ "${name}" — 그 이름의 아이템이 없습니다. --search로 실제 이름을 찾아보세요.`);
    continue;
  }
  const item = found[0];
  const sold = await getSold(item.itemId, 100);
  const listings = await getAuction(item.itemId, 400);

  const times = sold.map((r) => kstToIso(r.soldDate)).sort();
  const spanMin = times.length > 1
    ? (Date.parse(times.at(-1)!) - Date.parse(times[0])) / 60_000
    : null;
  const prices = sold.map((r) => r.unitPrice).sort((a, b) => a - b);

  console.log(`\n${item.itemName}  [${item.itemRarity}/${item.itemTypeDetail}]`);
  console.log(`  itemId    ${item.itemId}`);
  console.log(`  체결      ${sold.length}건, span ${spanMin === null ? '-' : `${spanMin.toFixed(1)}분 (${(spanMin / 1440).toFixed(1)}일)`}`);
  console.log(`  중앙가    ${prices.length ? prices[Math.floor(prices.length / 2)].toLocaleString() : '-'} 골드`);
  console.log(`  현재매물  ${listings.length}건, 최저호가 ${listings[0]?.unitPrice.toLocaleString() ?? '-'}`);
  console.log(`  → ${recommend(spanMin, sold.length)}`);
}
