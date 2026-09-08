-- 수집 트리거 — Supabase pg_cron
--
-- 왜 여기 있나: GitHub Actions의 schedule 트리거가 실행을 만들어주지 않는다.
-- 실측(2026-09-07) 하루 동안 40회 넘는 기회에서 단 1회만 떴고, 크론 시각을
-- 어긋내도 동일했다. 취소·건너뜀 기록조차 없이 신호 자체가 오지 않는다.
-- GitHub 문서도 schedule은 best-effort이며 누락될 수 있다고 명시한다.
--
-- 반면 workflow_dispatch는 명시적 API 요청이라 큐에 바로 들어간다(실측 6/6).
-- 그래서 수집 코드와 워크플로는 그대로 두고 시계만 Supabase로 옮겼다.
--
-- 사전 준비:
--   1) CREATE EXTENSION pg_cron; CREATE EXTENSION pg_net;
--   2) GitHub Fine-grained PAT (해당 레포 · Actions: Read and write)를
--      Vault에 gh_dispatch_token 이름으로 저장:
--        SELECT vault.create_secret('<PAT>', 'gh_dispatch_token', '용도 설명');

SELECT cron.unschedule('dnf-collect-dispatch')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dnf-collect-dispatch');

-- 15분마다 깨운다. 워크플로의 concurrency 그룹이 겹침을 막으므로,
-- 이미 돌고 있으면 새 요청은 대기했다가 앞 실행이 끝나는 즉시 이어받는다.
SELECT cron.schedule('dnf-collect-dispatch', '*/15 * * * *', $$
  SELECT net.http_post(
    url := 'https://api.github.com/repos/kimtaehoon1107-gif/dnf-price-tracker/actions/workflows/collect.yml/dispatches',
    body := '{"ref":"main"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'gh_dispatch_token'),
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'dnf-price-tracker-cron'
    )
  );
$$);

SELECT cron.unschedule('dnf-events-dispatch')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dnf-events-dispatch');

-- 수요일 공지가 나온 뒤 목요일 점검 종료 무렵에 공식 이벤트를 한 번 반영한다.
-- 주 1회라 누락을 오래 알아채기 어려우므로 수집과 같은 명시적 dispatch를 쓴다.
SELECT cron.schedule('dnf-events-dispatch', '30 1 * * 4', $$
  SELECT net.http_post(
    url := 'https://api.github.com/repos/kimtaehoon1107-gif/dnf-price-tracker/actions/workflows/events.yml/dispatches',
    body := '{"ref":"main"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'gh_dispatch_token'),
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'dnf-price-tracker-cron'
    )
  );
$$);

SELECT cron.unschedule('dnf-pages-dispatch')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dnf-pages-dispatch');

-- 정적 페이지는 매시간 한 번 최신 DB로 다시 굽는다. GitHub schedule 대신
-- 수집·이벤트와 같은 명시적 dispatch 경로를 사용한다.
SELECT cron.schedule('dnf-pages-dispatch', '5 * * * *', $$
  SELECT net.http_post(
    url := 'https://api.github.com/repos/kimtaehoon1107-gif/dnf-price-tracker/actions/workflows/pages.yml/dispatches',
    body := '{"ref":"main"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'gh_dispatch_token'),
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'dnf-price-tracker-cron'
    )
  );
$$);

-- 수집 실행 이력은 재시작 스케줄 복원과 최근 상태 진단에만 쓴다.
-- 원본 체결 이력은 건드리지 않고 30일이 지난 운영 로그만 정리한다.
SELECT cron.unschedule('dnf-runs-prune')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dnf-runs-prune');

SELECT cron.schedule('dnf-runs-prune', '23 4 * * *', $$
  DELETE FROM collection_runs WHERE started_at < now() - interval '30 days';
$$);

-- 매물 소진 화면은 최근 7일만 사용한다. 여유 있게 90일을 보존하되,
-- 카드 호가 시계열 원본인 listing_snapshots는 정리하지 않는다.
SELECT cron.unschedule('dnf-deltas-prune')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dnf-deltas-prune');

SELECT cron.schedule('dnf-deltas-prune', '29 4 * * *', $$
  DELETE FROM listing_deltas WHERE observed_at < now() - interval '90 days';
$$);

-- 점검용
--   SELECT jobid, jobname, schedule, active FROM cron.job;
--   SELECT status, return_message, start_time FROM cron.job_run_details
--     WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='dnf-collect-dispatch')
--     ORDER BY start_time DESC LIMIT 10;
--   SELECT id, status_code, created FROM net._http_response ORDER BY id DESC LIMIT 10;
