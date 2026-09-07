// 아이템 카탈로그를 눈덩이식으로 수집한다.
//
// 왜 필요한가:
//   /df/items는 이름 검색만 되고 전체 열거가 안 된다(q 조건만 주면 400).
//   그래서 "무엇을 검색할지"를 정해야 하는데, 사람이 키워드를 고르면
//   고른 사람의 어휘가 곧 결과의 한계가 된다. 떠올리지 못한 아이템은
//   순위에 등장조차 못 하므로, 그렇게 만든 "트래픽 순위"는 신뢰할 수 없다.
//
// 방법:
//   검색으로 나온 아이템 이름에서 두 글자씩 잘라내 다시 검색어로 쓴다.
//   새 이름이 새 검색어를 낳고, 그 검색어가 또 새 이름을 찾는다.
//   더 이상 새 아이템이 안 나올 때까지 반복하면 사람의 어휘가 개입하지 않는다.
//
// 한계 (정직하게):
//   찾은 어떤 이름과도 두 글자를 공유하지 않는 아이템은 끝내 도달할 수 없다.
//   또 한 검색어가 100건에서 잘리면 그 뒤는 못 본다. 완전한 목록이 아니라
//   "도달 가능한 범위"이며, 결과에 미도달 지표를 함께 출력한다.
//
//   node --env-file=.env --no-warnings scripts/discover.ts [최대_검색수]

import { writeFileSync, mkdirSync } from 'node:fs';
import { searchItems, type ItemRow } from '../src/api.ts';

const MAX_QUERIES = Number(process.argv[2] ?? 4000);
const CONCURRENCY = 10;

// 시드는 결과를 좌우하지 않는다. 첫 이름 몇 개를 얻기 위한 발화점일 뿐이고,
// 그 뒤로는 게임 데이터에서 뽑은 조각들이 검색어를 만든다.
const SEED = ['조각', '결정', '주머니', '상자', '스크롤'];

const items = new Map<string, ItemRow>();
const tried = new Set<string>();
const queue: string[] = [...SEED];
let capped = 0;

/** 아이템 이름에서 검색어로 쓸 두 글자 조각을 뽑는다. */
function bigrams(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < name.length - 1; i++) {
    const g = name.slice(i, i + 2);
    // 한글이 한 글자라도 있어야 검색어로 의미가 있다
    if (/[가-힣]/.test(g) && !/[\[\]():]/.test(g)) out.push(g);
  }
  return out;
}

console.error(`시드 ${SEED.length}개로 시작 (최대 검색 ${MAX_QUERIES}회)`);
let round = 0;

while (queue.length > 0 && tried.size < MAX_QUERIES) {
  round++;
  const batch: string[] = [];
  while (batch.length < 200 && queue.length > 0 && tried.size + batch.length < MAX_QUERIES) {
    const q = queue.shift()!;
    if (!tried.has(q)) batch.push(q);
  }
  if (batch.length === 0) break;

  const before = items.size;
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    await Promise.all(batch.slice(i, i + CONCURRENCY).map(async (q) => {
      tried.add(q);
      let rows: ItemRow[];
      try {
        rows = await searchItems(q, 'full', 100);
      } catch { return; }
      if (rows.length >= 100) capped++;
      for (const r of rows) {
        if (items.has(r.itemId)) continue;
        items.set(r.itemId, r);
        for (const g of bigrams(r.itemName)) {
          if (!tried.has(g)) queue.push(g);
        }
      }
    }));
  }
  console.error(`  ${round}회차: 검색 ${tried.size}회 · 아이템 ${items.size}종 (+${items.size - before}) · 대기 ${queue.length}`);
}

mkdirSync('data', { recursive: true });
writeFileSync('data/catalog.json', JSON.stringify([...items.values()], null, 0));

const byType = new Map<string, number>();
for (const r of items.values()) byType.set(r.itemTypeDetail, (byType.get(r.itemTypeDetail) ?? 0) + 1);

console.log(`\n아이템 ${items.size}종 · 검색 ${tried.size}회 · data/catalog.json 저장`);
console.log(`100건에서 잘린 검색어 ${capped}개, 아직 안 써본 검색어 ${queue.length}개`);
if (queue.length > 0) {
  console.log('→ 대기가 남았다는 건 아직 도달 못 한 아이템이 있다는 뜻입니다. 최대 검색수를 늘려 다시 돌리세요.');
}
console.log('\n분류별 (상위 15):');
[...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([t, n]) => console.log(`  ${t.padEnd(16)} ${String(n).padStart(5)}종`));
