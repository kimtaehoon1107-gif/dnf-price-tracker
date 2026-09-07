// 거래가 활발한 아이템을 찾아낸다.
//
// probe.ts가 "이 아이템의 거래 빈도는?"이라면, scan.ts는 "어떤 아이템이 활발한가?"다.
// /df/items에 전체 목록 API가 없어서, 재료·소모품 이름에 흔한 키워드로 후보를 긁고
// 전부 span을 재는 방식으로 찾는다.
//
//   node --env-file=.env --no-warnings scripts/scan.ts
//   node --env-file=.env --no-warnings scripts/scan.ts 증표 조각 정수
//
// 판단 기준은 "건당 소요 시간"(span ÷ 체결건수)이다. 이 값이 작을수록 거래가 빠르고,
// 곧 100건 상한에 빨리 걸리므로 폴링 주기를 짧게 잡아야 한다.

import { searchItems, getSold, kstToIso, type ItemRow } from '../src/api.ts';

const DEFAULT_KEYWORDS = [
  '증표', '조각', '정수', '파편', '결정', '원소', '마력', '영혼', '에너지', '기운',
  '보주', '큐브', '주머니', '성물', '흔적', '가루', '티끌', '열쇠', '초대장', '물약',
  '스크롤', '무색', '재련', '봉인', '순례', '광휘', '비약', '부여', '도면', '해방',
];

// 경매장에서 실제로 유통되는 소비재 계열만 본다. 장비는 강화·증폭 수치가 가격을
// 지배해서 같은 itemId라도 서로 다른 상품이므로 1단계 대상에서 제외한다.
const TYPES = new Set(['재료', '전문직업 재료', '소모품', '부스터', '마법석']);

const keywords = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_KEYWORDS;

const candidates = new Map<string, ItemRow>();
for (const k of keywords) {
  try {
    for (const r of await searchItems(k, 'full', 30)) {
      if (TYPES.has(r.itemTypeDetail)) candidates.set(r.itemId, r);
    }
  } catch (e) {
    console.error(`  "${k}" 검색 실패: ${e instanceof Error ? e.message : e}`);
  }
}
console.error(`후보 ${candidates.size}종. 거래 빈도 측정 중…`);

interface Scanned { row: ItemRow; trades: number; spanMin: number; median: number; perTrade: number }
const found: Scanned[] = [];
const list = [...candidates.values()];

for (let i = 0; i < list.length; i += 8) {
  await Promise.all(list.slice(i, i + 8).map(async (row) => {
    try {
      const sold = await getSold(row.itemId, 100);
      if (sold.length < 30) return;                  // 거래가 희박하면 시계열이 안 나온다
      const t = sold.map((x) => Date.parse(kstToIso(x.soldDate))).sort((a, b) => a - b);
      const spanMin = (t.at(-1)! - t[0]) / 60_000;
      const p = sold.map((x) => x.unitPrice).sort((a, b) => a - b);
      found.push({ row, trades: sold.length, spanMin,
        median: p[Math.floor(p.length / 2)], perTrade: spanMin / sold.length });
    } catch { /* 개별 아이템 실패는 무시 */ }
  }));
}

found.sort((a, b) => a.perTrade - b.perTrade);

const fmtSpan = (m: number) =>
  m < 60 ? `${m.toFixed(0)}분` : m < 1440 ? `${(m / 60).toFixed(1)}시간` : `${(m / 1440).toFixed(1)}일`;

const suggest = (perTrade: number) =>
  perTrade < 0.2 ? '  60초' : perTrade < 0.5 ? ' 120초' : perTrade < 2 ? ' 300초' : perTrade < 10 ? ' 900초' : '3600초';

console.log('\n순위 아이템'.padEnd(32) + '분류'.padStart(13) + '체결'.padStart(6) +
  'span'.padStart(9) + '건당'.padStart(8) + '중앙가'.padStart(13) + '  권장주기');
console.log('─'.repeat(97));

found.slice(0, 30).forEach((x, i) => {
  console.log(
    `${String(i + 1).padStart(3)}. ${x.row.itemName}`.padEnd(32) +
    x.row.itemTypeDetail.padStart(13) +
    String(x.trades).padStart(6) +
    fmtSpan(x.spanMin).padStart(9) +
    `${x.perTrade.toFixed(2)}분`.padStart(8) +
    x.median.toLocaleString().padStart(13) +
    '  ' + suggest(x.perTrade));
});

console.log(`\n${found.length}종이 거래 30건 이상. "건당"이 짧을수록 시장이 뜨겁습니다.`);
console.log('추가하려면 scripts/init-db.ts의 SEED에 itemId와 함께 넣고 `npm run init`을 실행하세요.');
console.log('itemId는 `npm run probe -- "<아이템명>"`으로 확인할 수 있습니다.');
