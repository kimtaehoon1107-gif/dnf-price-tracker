# 스냅샷 보조 인덱스 정리 — 2026-11-06

사용자 승인 범위: B/C의 저사용 보조 인덱스를 먼저 검증하고 조회 성능에 문제가 없으면 제거한다. 원본 데이터는 유지한다.
기준 코드: main `44b9e11c55f9ea7558ee85e45824075e57a5fa0e`.

## 적용 결과

2026-11-06 00:31 KST에 B/C의 `public.idx_snapshots_item_upgrade_time`만
`DROP INDEX CONCURRENTLY`로 제거했다. 원본 행에 대한 INSERT/UPDATE/DELETE는 실행하지 않았다.
`idx_snapshots_item_time_upgrade` 고유 인덱스와 스냅샷 PK는 정의·valid·ready 상태가 전후 동일하다.
체결 테이블·자연키·보존 기간·수집 예약·R2·연구 규칙은 변경하지 않았다.

| 항목 | B | C |
|---|---:|---:|
| 제거한 인덱스 크기 (bytes) | 21,823,488 | 12,115,968 |
| 스냅샷 전체 관계 크기 전 → 후 (bytes) | 66,936,832 → 45,088,768 | 35,405,824 → 23,265,280 |
| 서비스 DB 크기 전 → 후 (bytes) | 338,717,843 → 316,869,779 | 352,349,331 → 340,208,787 |
| 전후 SHA-256이 같은 최근 7일 원본 행 | 58,284 | 32,857 |

인덱스 합계 **33,939,456 bytes (33.94 MB / 32.37 MiB)**를 제거했다.
관계·DB 크기는 동시 운영 및 임시 파일 정리에 따라 다른 변화도 포함하므로 인덱스 크기와 구분한다.
Supabase 대시보드의 청구/프로비저닝 디스크 감소량을 측정한 수치는 아니다.

## 성능과 결과 검증

먼저 각 DB의 세션 임시 테이블로 원본 스냅샷 전체를 복사했다(B 119,026행, C 65,420행).
동일 REPEATABLE READ에서 행 수·전체 행 MD5 지문을 확인하고, PK·고유 인덱스와 후보 보조 인덱스를 만들었다.
후보 있음 → 없음 → 재생성 순서로 비교했으며 세션 종료 시 모두 ROLLBACK했다.
임시 복사본이므로 운영 인덱스의 팽창과 디스크 캐시 상태까지 재현하지는 않는다.

`scripts/verify-snapshot-index.ts`는 실제 소스의 카드 연구·패키지 재고·계절성 SQL을 읽고,
보관 일별 서명 집계 및 106개 품목/강화 단계 조합의 최신 행 조회도 검사한다.
각 주요 조회는 결과 해시 일치와 EXPLAIN ANALYZE 5회 중앙값을 비교했다.
보조 인덱스 유무·재생성 후 모든 결과가 같았고 최신 행 조회 최대 시간은 2.384ms였다.
B 계절성 중앙값은 있음 402ms / 없음 432ms / 재생성 439ms여서 제거에 따른 일관된 성능 저하로 판단하지 않았다.

운영 제거 직전·직후에는 최대 id를 고정해 수집 중 추가된 행을 제외하고 다시 검증했다.
다음은 각 5회 중앙값(ms)이며 네트워크 왕복 시간은 제외한다.

| 운영 조회 | B 전 → 후 | C 전 → 후 |
|---|---:|---:|
| 카드 연구 | 150.246 → 149.578 | 26.948 → 26.676 |
| 패키지 재고 | 0.067 → 0.066 | 3.814 → 3.859 |
| 계절성 | 350.370 → 340.301 | 381.029 → 381.887 |

B에는 패키지 재고 대상 행이 없어 해당 조회는 빈 결과다. C의 실제 대상 행으로도 검증했다.
운영 전후 조회 결과 해시가 모두 같았으며, 실행 전 정한 회귀 기준(25% 초과이면서 20ms 초과 증가)에 해당하지 않았다.
짧은 측정이므로 미래의 모든 쿼리와 부하에 대한 보장은 아니다.
사이트는 별도 통합 임시 DB에 `(item_id,captured_at)` 인덱스를 생성하므로 사이트용 인덱스는 바뀌지 않는다.

최근 7일 원본은 cutoff와 최대 id를 고정해 SHA-256을 확인했다. 전체 이력 해시 검증으로 확대 해석하지 않는다.

- B: `de24025899376e79d2a2c6ce0fff166fd5ef403e5bee4a205b072cc0b97173cf`
- C: `36f16212cfccab0df3a637f1e282e17f831c99e0c1c175e3523edfc54a57de75`

## 적용 및 복구

새 DB 초기화 시 후보 인덱스를 다시 만들지 않도록 `sql/schema.postgres.sql`의 생성 선언을 제거했다.
기존 DB에는 `sql/remove-snapshot-aux-index.sql`을 **트랜잭션 블록 밖에서 단독 실행**한다.
호출 세션에서 lock_timeout=3s, statement_timeout=25s를 별도 설정했다.
초기 사전 검사에서 SQL 문법·다중 명령의 트랜잭션 제한을 수정했으며, 실제 제거 전 단계의 실패로 원본 변경은 없었다.

필요하면 다음 문장을 트랜잭션 블록 밖에서 단독 실행해 복구할 수 있다.

```sql
CREATE INDEX CONCURRENTLY idx_snapshots_item_upgrade_time
  ON public.listing_snapshots (item_id, upgrade, captured_at DESC);
```

수동 재검증은 새 결과 폴더를 지정한다. 운영 원본에는 SELECT만 하고 세션 임시 복사본만 변경한다.

```powershell
node --env-file=<로컬-env-파일> scripts/verify-snapshot-index.ts data/snapshot-index-recheck
```

## 보존 증거

`docs/evidence/snapshot-index-20261106/`에 자격증명과 원본 행 없이 계획·시간·해시·작업 기록을 보존했다.
`applied-command.mjs.txt`는 당시 data 폴더에서 실행한 명령의 기록이며 재실행용 도구가 아니다.

| 파일 | SHA-256 |
|---|---|
| benchmark.json.gz | a161070e0378fd272ce9b7534365542e39353a7e9abbde9c45b57eb3f72b37dc |
| operation.json | ac68a817a327b5c8878b8525f69bdb7ebc6a5a10aada9d0fbe16245be83eca23 |
| applied-command.mjs.txt | f53c304220970f2373f4c3f0b6d323ccaf03c48bf9e75ca1eee2ef95c6dfedd5 |

로컬 `npm test` 통과. 운영 적용 이후 수집 상태는 별도 읽기 전용으로 확인했다.
