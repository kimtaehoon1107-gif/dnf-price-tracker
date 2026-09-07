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

  // 숲속의 유랑악단 패키지와 그 구성품 5종.
  //
  // 패키지를 뜯으면 아래 다섯 상자가 나온다. 그래서 "패키지 값"과 "구성품 합"을
  // 나란히 추적하면 해체 차익(= 시장 효율성)을 직접 관측할 수 있다.
  //
  // 2026-09-07 실측: 구성품 합 34,078,366 vs 패키지 33,000,000 → +3.27%.
  // 판매 수수료 3%를 빼면 순마진 +0.17%로 거의 0이다. 유저들이 이미 재정거래로
  // 차익을 지운 상태이며, 곧 이 시장이 효율적이라는 뜻이다.
  //
  // 연구 질문은 "마진이 얼마인가"가 아니라 "언제 깨지는가"다. 패키지 출시일과
  // 판매 종료일 전후가 유력하다(계획서 H1·H2). 그래서 events 테이블이 필요하다.
  ['e974d2eac46f0c8b23b83d4da389fa57', '숲속의 유랑악단 패키지',           '레어', '세라샵 패키지', 900, '패키지', '해체 차익의 기준. 세라샵 정가가 있어 골드 환율 기준재로도 쓸 수 있다'],
  ['702d33e99edb55d23cac4c9970ef44ee', '숲속의 유랑악단 아바타 풀세트 상자', '레어', '선택 부스터',  900, '구성품', '패키지 구성품 1/5. 100건 = 15.0시간치'],
  ['a295bdbb26984dcb946eb3a3044dcfe5', '숲속의 유랑악단 크리쳐 상자',       '레어', '부스터',      900, '구성품', '패키지 구성품 2/5. 100건 = 9.1시간치'],
  ['33776306aa3fa6fead55ced8656be444', '숲속의 유랑악단 오라 상자',         '레어', '선택 부스터',  900, '구성품', '패키지 구성품 3/5. 100건 = 16.2시간치'],
  ['329338e9ac307d34de71a48b314b19a0', '숲속의 유랑악단 칭호 상자',         '레어', '선택 부스터',  900, '구성품', '패키지 구성품 4/5. 100건 = 16.9시간치'],
  ['b971992f2529a494215fdf9368cfa0dd', '숲속의 유랑악단 세라 상자',         '레어', '선택 부스터',  900, '구성품', '패키지 구성품 5/5. 100건 = 15.2시간치'],
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
