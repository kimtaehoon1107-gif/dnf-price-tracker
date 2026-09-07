// 수집 진입점. 세 가지 모드를 한 파일로 처리한다.
//
//   node src/run.ts               상주 (로컬에서 켜두는 용도)
//   node src/run.ts --once        전체 1회 (백필 겸용)
//   node src/run.ts --minutes 9   지정 시간만큼 (GitHub Actions용)
//
// Actions 크론은 최소 5분 간격에 지연까지 붙어서, 100건이 13분치인
// 닳아버린 순례의 증표를 놓친다. 그래서 10분마다 띄우되 각 실행이 9분간
// 내부 루프를 돌게 한다. 공개 레포는 Actions 시간이 무제한이라 비용은 0이다.

import { collectItem } from './collect.ts';
import { query, pool } from './db.ts';

interface Item { item_id: string; item_name: string; poll_interval_sec: number }

const args = process.argv.slice(2);
const once = args.includes('--once');
const minIdx = args.indexOf('--minutes');
const runMinutes = minIdx > -1 ? Number(args[minIdx + 1]) : null;

const { rows: items } = await query<Item>(
  'SELECT item_id, item_name, poll_interval_sec FROM items WHERE tracked = TRUE ORDER BY poll_interval_sec');

if (items.length === 0) {
  console.error('추적 아이템이 없습니다. 먼저 `npm run init`을 실행하세요.');
  process.exit(1);
}

const stamp = () => new Date().toLocaleTimeString('ko-KR', { hour12: false });
const pad = (s: string, n: number) => s.length > n ? s.slice(0, n) : s.padEnd(n);

async function tick(item: Item, verbose = false) {
  try {
    const r = await collectItem(item.item_id);
    if (verbose || r.soldNew > 0 || r.deltas > 0 || r.saturated) {
      console.log(
        `${stamp()}  ${pad(item.item_name, 24)} 체결 ${String(r.soldRows).padStart(3)}건` +
        `(신규 ${String(r.soldNew).padStart(3)})  소진 ${String(r.qtyObserved).padStart(4)}개` +
        (r.saturated ? '  ⚠ 포화 — poll_interval_sec을 줄이세요' : ''));
    }
  } catch (e) {
    console.error(`${stamp()}  ${item.item_name} 실패: ${e instanceof Error ? e.message : e}`);
  }
}

// ── 1회 모드 ──────────────────────────────────────────────────
if (once) {
  for (const it of items) await tick(it, true);
  await pool.end();
  process.exit(0);
}

// ── 상주 / 시간제한 모드 ───────────────────────────────────────
const deadline = runMinutes ? Date.now() + runMinutes * 60_000 : Infinity;
console.log(`수집 시작 — ${items.length}종` + (runMinutes ? ` · ${runMinutes}분간` : ' · 상주(Ctrl+C로 중지)'));

// 아이템별 다음 실행 시각. 시작 시 전부 한 번 돌린다(= 백필).
const nextAt = new Map(items.map((it) => [it.item_id, 0]));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log('\n수집 중지.');
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

while (Date.now() < deadline && !stopping) {
  const now = Date.now();
  const due = items.filter((it) => (nextAt.get(it.item_id) ?? 0) <= now);

  // 만료 임박 시에는 새 폴링을 시작하지 않는다. 중간에 잘리면 그 실행은
  // collection_runs에 finished_at 없이 남아 갭 분석을 흐린다.
  if (due.length && Date.now() + 15_000 < deadline) {
    for (const it of due) {
      await tick(it);
      nextAt.set(it.item_id, Date.now() + it.poll_interval_sec * 1000);
    }
  }

  const sleepMs = Math.min(
    5_000,
    Math.max(500, Math.min(...items.map((it) => (nextAt.get(it.item_id) ?? 0) - Date.now()))),
  );
  await new Promise((r) => setTimeout(r, sleepMs));
}

console.log(`수집 종료 (${runMinutes}분 경과).`);
await pool.end();
