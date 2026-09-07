// 스키마 적용 + 화이트리스트 시드. 여러 번 실행해도 안전하다.

import { readFileSync } from 'node:fs';
import { query, pool } from '../src/db.ts';

await query(readFileSync('sql/schema.postgres.sql', 'utf8'));

// poll_interval_sec는 실측한 "100건이 덮는 시간"에서 역산했다 (2026-09-07 기준).
// 순례의 증표는 100건이 13분치라 2분 주기가 아니면 거래를 흘린다.
const SEED = [
  ['f9941d3fa0b8253bb0b2567a29b1299f', '닳아버린 순례의 증표',  '유니크',   '재료',   120, '고빈도', '광휘의 순례 입장 재료. 100건 = 13분치'],
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
  // 2026-09-07 실측(체결 600건 VWAP): 구성품 합 33,971,352 vs 패키지 32,961,496.
  // 수수료 3%를 빼면 순마진 -0.03%로 거의 0이다. 유저들이 이미 재정거래로
  // 차익을 지운 상태이며, 곧 이 시장이 효율적이라는 뜻이다.
  //
  // 연구 질문은 "마진이 얼마인가"가 아니라 "언제 깨지는가"다.
  // 판매 기간 2026-08-27 ~ 11-05 (events 참고).
  ['e974d2eac46f0c8b23b83d4da389fa57', '숲속의 유랑악단 패키지',           '레어', '세라샵 패키지', 900, '패키지', '해체 차익의 기준. 세라샵 정가가 있어 골드 환율 기준재로도 쓸 수 있다'],
  ['702d33e99edb55d23cac4c9970ef44ee', '숲속의 유랑악단 아바타 풀세트 상자', '레어', '선택 부스터',  900, '구성품', '패키지 구성품 1/5. 100건 = 15.0시간치'],
  ['a295bdbb26984dcb946eb3a3044dcfe5', '숲속의 유랑악단 크리쳐 상자',       '레어', '부스터',      900, '구성품', '패키지 구성품 2/5. 100건 = 9.1시간치'],
  ['33776306aa3fa6fead55ced8656be444', '숲속의 유랑악단 오라 상자',         '레어', '선택 부스터',  900, '구성품', '패키지 구성품 3/5. 100건 = 16.2시간치'],
  ['329338e9ac307d34de71a48b314b19a0', '숲속의 유랑악단 칭호 상자',         '레어', '선택 부스터',  900, '구성품', '패키지 구성품 4/5. 100건 = 16.9시간치'],
  ['b971992f2529a494215fdf9368cfa0dd', '숲속의 유랑악단 세라 상자',         '레어', '선택 부스터',  900, '구성품', '패키지 구성품 5/5. 100건 = 15.2시간치'],

  // 인챈트 카드 3종. 거래가 드문 대신 단가가 높아, 백필만으로 반나절~하루치가 들어온다.
  // 각 카드에 대응하는 "보주"가 따로 있고 보주가 카드보다 20~85% 비싸다.
  // 카드를 보주로 만드는 관계이므로 그 차액이 또 하나의 제작 마진이 된다(미추적).
  ['d764ad320566b4ecff5931574a148bb7', '거짓의 베리디쿠스 카드',     '레전더리', '전문직업 재료', 3600, '고가 저빈도', '100건 = 17.1시간치. 대응 보주 44ec407d…d8e8 (16,500,000)'],
  ['7483aac25864738f6fe621612cedda2a', '마법 같은 행운 엘리브 카드', '레전더리', '전문직업 재료', 3600, '고가 저빈도', '100건 = 1.1일치. 최고가군. 대응 보주 166c50ea…a70c (47,900,000)'],
  ['2abf4a1103ef88fde63cf9b0a110422d', '마법을 품은 배니부 카드',   '레전더리', '전문직업 재료', 3600, '고가 저빈도', '100건 = 1.1일치. 대응 보주 c0109c0f…86d8 (15,099,999)'],
] as const;

for (const [id, name, rarity, type, interval, role, note] of SEED) {
  await query(`
    INSERT INTO items (item_id, item_name, item_rarity, item_type_detail, poll_interval_sec, role, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (item_id) DO UPDATE SET
      poll_interval_sec = EXCLUDED.poll_interval_sec,
      role = EXCLUDED.role,
      note = EXCLUDED.note`,
    [id, name, rarity, type, interval, role, note]);
}

const tables = await query<{ table_name: string }>(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
const n = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM items WHERE tracked = TRUE');

console.log(`테이블 ${tables.rows.length}개: ${tables.rows.map((t) => t.table_name).join(', ')}`);
console.log(`추적 아이템 ${n.rows[0].n}종 시드 완료`);
await pool.end();
