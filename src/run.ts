// 수집 진입점. 세 가지 모드를 한 파일로 처리한다.
//
//   node src/run.ts               상주 (로컬에서 켜두는 용도)
//   node src/run.ts --once        전체 1회 (백필 겸용)
//   node src/run.ts --minutes 55  지정 시간만큼 (GitHub Actions용)
//   node src/run.ts --group hot   5분 이하 고빈도 아이템만
//   node src/run.ts --group rest  나머지 아이템만
//
// Actions는 15분마다 실행을 시도하고, 각 실행이 55분간 내부 루프를 돈다.
// GitHub 스케줄이 지연되더라도 실행 중에는 아이템별 주기를 지킨다.

import { collectItem, type CollectionSource } from './collect.ts';
import { query, pool } from './db.ts';

interface Item {
  item_id: string;
  item_name: string;
  poll_interval_sec: number;
  last_success: Date | null;
}

const args = process.argv.slice(2);
const once = args.includes('--once');
const minIdx = args.indexOf('--minutes');
const runMinutes = minIdx > -1 ? Number(args[minIdx + 1]) : null;
const groupIdx = args.indexOf('--group');
const group = groupIdx > -1 ? args[groupIdx + 1] : 'all';
if (!['all', 'hot', 'rest'].includes(group)) {
  throw new Error('--group은 hot 또는 rest여야 합니다.');
}

const configuredSource = process.env.COLLECT_SOURCE;
if (configuredSource && !['local', 'manual', 'actions'].includes(configuredSource)) {
  throw new Error('COLLECT_SOURCE는 local, manual, actions 중 하나여야 합니다.');
}
const source = (configuredSource ?? (once ? 'manual' : 'local')) as CollectionSource;

const { rows: items } = await query<Item>(`
  SELECT
    i.item_id,
    i.item_name,
    i.poll_interval_sec,
    (
      SELECT r.started_at
      FROM collection_runs r
      WHERE r.item_id = i.item_id
        AND r.error IS NULL
        AND r.finished_at IS NOT NULL
      ORDER BY r.started_at DESC
      LIMIT 1
    ) AS last_success
  FROM items i
  WHERE i.tracked = TRUE
    AND ($1 = 'all'
      OR ($1 = 'hot' AND i.poll_interval_sec <= 300)
      OR ($1 = 'rest' AND i.poll_interval_sec > 300))
  ORDER BY i.poll_interval_sec`, [group]);

if (items.length === 0) {
  console.error('추적 아이템이 없습니다. 먼저 `npm run init`을 실행하세요.');
  process.exit(1);
}

const stamp = () => new Date().toLocaleTimeString('ko-KR', { hour12: false });
const pad = (s: string, n: number) => s.length > n ? s.slice(0, n) : s.padEnd(n);
const pollSteps = [60, 120, 300, 900, 1800, 3600];
const shorterPoll = (current: number) => pollSteps.filter((seconds) => seconds < current).at(-1) ?? current;

async function tick(item: Item, verbose = false): Promise<boolean> {
  try {
    const r = await collectItem(item.item_id, 100, source);
    let saturationNote = '';
    // 포화 자체는 수집 공백 뒤에도 켜진다. 100건이 현재 폴링 주기의 1.5배도
    // 덮지 못할 때만 정상 주기가 실제 거래 속도보다 느리다고 판단한다.
    const tooFast = r.saturated && r.spanMin > 0
      && r.spanMin < item.poll_interval_sec / 60 * 1.5;
    if (tooFast) {
      const shorter = shorterPoll(item.poll_interval_sec);
      if (shorter < item.poll_interval_sec) {
        try {
          const updated = await query(
            'UPDATE items SET poll_interval_sec = $1 WHERE item_id = $2 AND poll_interval_sec > $1',
            [shorter, item.item_id],
          );
          if (updated.rowCount) {
            saturationNote = `  ⚠ 포화 — 주기 ${item.poll_interval_sec}s → ${shorter}s`;
            item.poll_interval_sec = shorter;
          }
        } catch (e) {
          console.error(`${stamp()}  ${item.item_name} 주기 자동 단축 실패: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    if (verbose || r.soldNew > 0 || r.deltas > 0 || r.saturated) {
      console.log(
        `${stamp()}  ${pad(item.item_name, 24)} 체결 ${String(r.soldRows).padStart(3)}건` +
        `(신규 ${String(r.soldNew).padStart(3)})  소진 ${String(r.qtyObserved).padStart(4)}개` +
        (r.saturated
          ? saturationNote || (tooFast ? '  ⚠ 포화 — 이미 최소 60s 주기' : '  ⚠ 포화 — 수집 공백 영향, 주기 유지')
          : ''));
    }
    return true;
  } catch (e) {
    console.error(`${stamp()}  ${item.item_name} 실패: ${e instanceof Error ? e.message : e}`);
    return false;
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
console.log(`수집 시작 — ${items.length}종 · ${group} · ${source}` +
  (runMinutes ? ` · ${runMinutes}분간` : ' · 상주(Ctrl+C로 중지)'));

// 프로세스가 다시 시작되어도 DB의 마지막 성공 시각을 이어받는다.
// 수집 이력이 없는 아이템만 즉시 실행 대상으로 둔다.
const nextAt = new Map(
  items.map((it) => [
    it.item_id,
    it.last_success
      ? it.last_success.getTime() + it.poll_interval_sec * 1_000
      : 0,
  ]),
);

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
  // 한 번에 하나씩 처리하고 매번 "지금 가장 급한 게 뭔지"를 다시 판단한다.
  // due를 통째로 훑으면 68종을 도는 2~3분 동안 2분 주기 아이템이 계속 밀린다.
  const item = items.reduce((earliest, candidate) => {
    const earliestAt = nextAt.get(earliest.item_id) ?? 0;
    const candidateAt = nextAt.get(candidate.item_id) ?? 0;
    if (candidateAt !== earliestAt) return candidateAt < earliestAt ? candidate : earliest;
    return candidate.poll_interval_sec < earliest.poll_interval_sec ? candidate : earliest;
  });
  const scheduledAt = nextAt.get(item.item_id) ?? 0;

  // 만료 임박 시에는 새 폴링을 시작하지 않는다. 중간에 잘리면 그 실행은
  // collection_runs에 finished_at 없이 남아 갭 분석을 흐린다.
  if (scheduledAt <= Date.now() && Date.now() + 15_000 < deadline) {
    const succeeded = await tick(item);
    nextAt.set(
      item.item_id,
      Date.now() + (succeeded ? item.poll_interval_sec * 1_000 : 60_000),
    );
    continue;
  }

  const sleepMs = Math.min(
    5_000,
    Math.max(200, scheduledAt - Date.now()),
  );
  await new Promise((r) => setTimeout(r, sleepMs));
}

console.log(`수집 종료 (${runMinutes}분 경과).`);
await pool.end();
