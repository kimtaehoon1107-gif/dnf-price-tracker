// 상주 수집 루프 — SQLite 단계의 진입점.
//
// GitHub Actions 크론은 최소 5분 간격에 지연까지 붙어서, 100건이 15분치인
// 순례의 증표를 놓친다. 그래서 이 단계에서는 아이템별 setInterval 상주 루프를 쓴다.
// Supabase로 옮긴 뒤에는 Actions에서 이 파일 대신 짧은 배치를 돌린다.

import { collectItem } from './collect.ts';
import { db } from './db.ts';

interface Item {
  item_id: string;
  item_name: string;
  poll_interval_sec: number;
}

const items = db.prepare(
  'SELECT item_id, item_name, poll_interval_sec FROM items WHERE tracked = 1 ORDER BY poll_interval_sec'
).all() as Item[];

if (items.length === 0) {
  console.error('추적 아이템이 없습니다. 먼저 `npm run init`을 실행하세요.');
  process.exit(1);
}

const stamp = () => new Date().toLocaleTimeString('ko-KR', { hour12: false });

async function tick(item: Item) {
  try {
    const r = await collectItem(item.item_id);
    if (r.soldNew > 0 || r.deltas > 0 || r.saturated) {
      console.log(
        `${stamp()}  ${item.item_name.padEnd(20)} 신규 ${String(r.soldNew).padStart(3)}건` +
        `  소진 ${String(r.qtyObserved).padStart(4)}개` +
        (r.saturated ? '  ⚠ 포화 — poll_interval_sec을 줄이세요' : ''));
    }
  } catch (e) {
    console.error(`${stamp()}  ${item.item_name} 실패: ${e instanceof Error ? e.message : e}`);
  }
}

console.log(`수집 시작 — ${items.length}종`);
for (const it of items) {
  console.log(`  ${it.item_name.padEnd(20)} ${it.poll_interval_sec}초`);
}
console.log('중지하려면 Ctrl+C\n');

// 시작 시 전부 1회 수집(= 백필). 아이템당 최대 1개월치가 딸려온다.
for (const it of items) await tick(it);

// 이후 주기 반복. 호출이 한꺼번에 몰리지 않게 아이템마다 시작을 어긋나게 둔다.
items.forEach((it, i) => {
  setTimeout(() => {
    setInterval(() => void tick(it), it.poll_interval_sec * 1000);
  }, i * 3000);
});

const shutdown = () => {
  console.log('\n수집 중지. data/dnf.db에 저장되었습니다.');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
