// 카탈로그에서 이름 패턴으로 아이템을 골라 화이트리스트에 넣는다.
//
// init-db.ts의 SEED에 수십 줄을 손으로 박는 대신 쓴다. 이벤트 관련 아이템처럼
// 한꺼번에 많이 추가해야 할 때를 위한 것. 카탈로그는 discover.ts가 만든다.
//
//   npm run track -- "^숲속의 유랑악단" 3600 부속품 --exclude "상자|패키지" --dry
//
// 인자: <이름 정규식> <폴링주기(초)> <역할> [--exclude <제외 정규식>] [--dry]

import { readFileSync } from 'node:fs';
import { query, pool } from '../src/db.ts';

const [pattern, intervalArg, role] = process.argv.slice(2);
if (!pattern || !intervalArg || !role) {
  console.error('사용법: track.ts <이름 정규식> <폴링주기초> <역할> [--exclude <정규식>] [--dry]');
  process.exit(1);
}
const interval = Number(intervalArg);
const exArg = process.argv.indexOf('--exclude');
const exclude = exArg > -1 ? new RegExp(process.argv[exArg + 1]) : null;
const dry = process.argv.includes('--dry');

const catalog = JSON.parse(readFileSync('data/catalog.json', 'utf8')) as Array<{
  itemId: string; itemName: string; itemRarity: string; itemTypeDetail: string;
}>;

const re = new RegExp(pattern);
const matched = catalog.filter((r) => re.test(r.itemName) && !(exclude && exclude.test(r.itemName)));
const existing = new Set((await query<{ item_id: string }>('SELECT item_id FROM items')).rows.map((r) => r.item_id));
const toAdd = matched.filter((r) => !existing.has(r.itemId));

console.log(`패턴 매칭 ${matched.length}종 · 이미 등록 ${matched.length - toAdd.length}종 · 신규 ${toAdd.length}종`);
if (dry) {
  toAdd.forEach((r) => console.log(`  ${r.itemName}  [${r.itemTypeDetail}]`));
  console.log('\n--dry 모드라 저장하지 않았습니다.');
  await pool.end();
  process.exit(0);
}

await query(`
  INSERT INTO items (item_id, item_name, item_rarity, item_type_detail, poll_interval_sec, role, note)
  SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[])
  ON CONFLICT (item_id) DO NOTHING`,
  [toAdd.map((r) => r.itemId), toAdd.map((r) => r.itemName), toAdd.map((r) => r.itemRarity),
   toAdd.map((r) => r.itemTypeDetail), toAdd.map(() => interval), toAdd.map(() => role),
   toAdd.map(() => `track.ts로 일괄 등록 (패턴: ${pattern})`)]);

const total = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM items WHERE tracked');
console.log(`${toAdd.length}종 추가. 현재 추적 대상 ${total.rows[0].n}종`);
console.log('백필하려면: npm run collect:once');
await pool.end();
