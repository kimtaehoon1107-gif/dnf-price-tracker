-- 공식 공지의 방송 예정 시각. 20:00 퍼스트 서버 오픈과 구분한다.
-- https://df.nexon.com/community/news/notice/2928724 (2026-10-23 15:00 KST 게시)
BEGIN;
SELECT pg_advisory_xact_lock(20261027, 19);
INSERT INTO events (name, type, announced_at, starts_at, ends_at, related_item_ids, source_url, note)
SELECT '퍼스트 서버 D-NOTE 라이브', '방송',
  '2026-10-23T15:00:00+09:00'::timestamptz, '2026-10-27T19:00:00+09:00'::timestamptz,
  NULL, NULL, 'https://df.nexon.com/community/news/notice/2928724',
  '공식 공지의 방송 시작 예정 시각 19:00 KST. 실제 시작·종료 시각은 별도 확인하지 않았으며 종료 시각은 미등록. 같은 날 20:00 퍼스트 서버 오픈과 구분.'
WHERE NOT EXISTS (
  SELECT 1 FROM events WHERE type='방송' AND source_url='https://df.nexon.com/community/news/notice/2928724'
);
COMMIT;
