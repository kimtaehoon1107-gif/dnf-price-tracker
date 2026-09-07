// 스키마 적용 + 화이트리스트 시드. 여러 번 실행해도 안전하다.

import { readFileSync } from 'node:fs';
import { db, nowIso } from '../src/db.ts';

db.exec(readFileSync('sql/schema.sqlite.sql', 'utf8'));

// poll_interval_sec는 실측한 "100건이 덮는 시간"에서 역산했다 (2026-09-07 기준).
// 순례의 증표는 100건이 15분치라 2분 주기가 아니면 거래를 흘린다.
const SEED = [
  ['f9941d3fa0b8253bb0b2567a29b1299f', '닳아버린 순례의 증표',  '유니크',   '재료',   120, '고빈도', '광휘의 순례 입장 재료. 100건 = 15분치'],
  ['27a5877768a40a3a0eccc493d0a53b9b', '광휘의 소울 결정',      '레전더리', '부스터', 300, '대조군', '100건 = 29분치'],
  ['c7d845c65ab9dbcff6e55dc910fbea87', '에픽 소울 결정',        '에픽',     '부스터', 300, '대조군', '100건 = 45분치'],
  ['c6947ff630cc59aebdcbabfb449258d1', '레전더리 소울 결정',    '레전더리', '부스터', 300, '대조군', '100건 = 98분치'],
  ['0620c107b1aae1f3a6cf9eee3aaf43d7', '유니크 소울 결정',      '유니크',   '부스터', 300, '대조군', '100건 = 105분치'],
  ['d288ebf406a65f4ec23d1f9c33227888', '태초 소울 결정',        '태초',     '부스터', 300, '대조군', '100건 = 113분치. 최고가군'],
  ['c4816db14d145416921f0210063cb014', '레어 소울 결정',        '레어',     '부스터', 300, '대조군', '100건 = 116분치. 최저가군'],
] as const;

const ins = db.prepare(`
  INSERT INTO items (item_id, item_name, item_rarity, item_type_detail, poll_interval_sec, role, note, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_id) DO UPDATE SET
    poll_interval_sec = excluded.poll_interval_sec,
    role = excluded.role,
    note = excluded.note`);

const now = nowIso();
for (const [id, name, rarity, type, interval, role, note] of SEED) {
  ins.run(id, name, rarity, type, interval, role, note, now);
}

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as Array<{ name: string }>;
const count = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;

console.log(`테이블 ${tables.length}개: ${tables.map((t) => t.name).join(', ')}`);
console.log(`추적 아이템 ${count}종 시드 완료`);
