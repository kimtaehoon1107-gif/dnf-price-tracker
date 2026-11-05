-- B/C 실측 후 적용하는 일회성 변경. 트랜잭션 블록 밖에서 실행한다.
-- 원본 행, PK, idx_snapshots_item_time_upgrade 고유 인덱스는 변경하지 않는다.
-- 호출 세션에서 lock_timeout=3s, statement_timeout=25s를 별도 설정한다.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_snapshots_item_upgrade_time;

-- 복구가 필요한 경우 트랜잭션 블록 밖에서 실행:
-- CREATE INDEX CONCURRENTLY idx_snapshots_item_upgrade_time
--   ON public.listing_snapshots (item_id, upgrade, captured_at DESC);
