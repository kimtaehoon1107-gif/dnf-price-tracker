-- 수집 감시견 — Supabase pg_cron
--
-- 하는 일 세 가지:
--   ① 기록    5분마다 "마지막 수집이 몇 분 전인지"를 남긴다 → 가동률 계산의 근거
--   ② 자가복구 공백이 임계치를 넘으면 정규 주기를 기다리지 않고 즉시 GitHub을 깨운다
--   ③ 알림    복구를 두 번 시도해도 공백이 이어지면 사람이 봐야 할 문제다 → GitHub Issue
--
-- 알고 쓸 한계: 감시견이 pg_cron 위에 있으므로 **pg_cron이나 Supabase가 죽으면
-- 감시견도 같이 죽는다.** 감시 대상과 운명을 공유한다. 그 경우까지 잡으려면
-- 인프라 밖에 별도 관찰자가 있어야 한다(현재는 Codex 예약 작업이 그 역할).
--
-- 임계치 근거: 정규 dispatch가 15분 주기이고 워크플로는 55분을 돈다.
-- 실행 중이면 새 dispatch는 대기했다가 이어받으므로 공백은 보통 몇 분 이내다.
-- 20분을 넘겼다면 dispatch 한 사이클이 통째로 유실된 것이므로 비정상이다.

CREATE TABLE IF NOT EXISTS collection_health (
  id              BIGSERIAL PRIMARY KEY,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_collect_at TIMESTAMPTZ,
  gap_min         NUMERIC,
  -- ok | recover | recover_cooldown | alert | alert_cooldown
  action          TEXT NOT NULL,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_health_time ON collection_health (checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_action ON collection_health (action, checked_at DESC);

CREATE OR REPLACE FUNCTION check_collection_health() RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_last        TIMESTAMPTZ;
  v_gap         NUMERIC;
  v_token       TEXT;
  v_recovers    INT;
  v_action      TEXT := 'ok';
  v_note        TEXT := NULL;
  v_threshold   CONSTANT NUMERIC := 20;   -- 분. 이보다 벌어지면 비정상
BEGIN
  -- 시작만 찍힌 채 멈췄거나 실패한 실행은 생존 신호가 아니다.
  -- CLI health와 같은 기준인 "마지막 성공 완료"만 본다.
  SELECT MAX(finished_at) INTO v_last
  FROM collection_runs
  WHERE error IS NULL AND finished_at IS NOT NULL;
  v_gap := ROUND(EXTRACT(EPOCH FROM (now() - COALESCE(v_last, now() - interval '1 day'))) / 60, 1);

  IF v_gap <= v_threshold THEN
    INSERT INTO collection_health (last_collect_at, gap_min, action) VALUES (v_last, v_gap, 'ok');
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets WHERE name = 'gh_dispatch_token';

  -- ── ② 자가복구 ──────────────────────────────────────────────
  -- 쿨다운 10분. 없으면 워크플로가 계속 죽는 상황에서 5분마다 무한 dispatch를 쏜다.
  IF EXISTS (SELECT 1 FROM collection_health
             WHERE action = 'recover' AND checked_at > now() - interval '10 minutes') THEN
    v_action := 'recover_cooldown';
  ELSE
    PERFORM net.http_post(
      url := 'https://api.github.com/repos/kimtaehoon1107-gif/dnf-price-tracker/actions/workflows/collect.yml/dispatches',
      body := '{"ref":"main"}'::jsonb,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_token,
        'Accept', 'application/vnd.github+json',
        'Content-Type', 'application/json',
        'User-Agent', 'dnf-price-tracker-watchdog'
      )
    );
    v_action := 'recover';
    v_note := '공백 ' || v_gap || '분 — 즉시 dispatch';
  END IF;

  -- ── ③ 알림 ─────────────────────────────────────────────────
  -- 40분 안에 두 번 복구를 시도했는데도 공백이면 일시적 문제가 아니다.
  SELECT COUNT(*) INTO v_recovers FROM collection_health
  WHERE action = 'recover' AND checked_at > now() - interval '40 minutes';

  IF v_recovers >= 2 THEN
    IF EXISTS (SELECT 1 FROM collection_health
               WHERE action = 'alert' AND checked_at > now() - interval '6 hours') THEN
      v_action := 'alert_cooldown';
    ELSE
      PERFORM net.http_post(
        url := 'https://api.github.com/repos/kimtaehoon1107-gif/dnf-price-tracker/issues',
        body := jsonb_build_object(
          'title', '[감시견] 수집이 ' || v_gap || '분째 멈춰 있습니다',
          'body',
            '자동 복구를 ' || v_recovers || '회 시도했는데도 수집이 재개되지 않았습니다.' || E'\n' ||
            '일시적 문제가 아니라 사람이 손대야 하는 상황으로 보입니다.' || E'\n\n' ||
            '- 마지막 수집: ' || COALESCE(v_last::text, '없음') || E'\n' ||
            '- 공백: ' || v_gap || '분' || E'\n' ||
            '- 감지 시각: ' || now()::text || E'\n\n' ||
            '### 확인 순서' || E'\n' ||
            '1. PAT 만료 — `SELECT status_code FROM net._http_response ORDER BY id DESC LIMIT 5;` 가 401/403이면 토큰 문제' || E'\n' ||
            '2. 워크플로 실패 — Actions 탭에서 최근 실행 로그' || E'\n' ||
            '3. pg_cron 정지 — `SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;`' || E'\n' ||
            '4. Supabase 일시정지 — 무료 티어는 7일 무활동 시 정지' || E'\n\n' ||
            '복구되면 이 이슈는 수동으로 닫아 주세요. 알림은 6시간에 한 번만 발생합니다.',
          'labels', jsonb_build_array('watchdog')
        ),
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_token,
          'Accept', 'application/vnd.github+json',
          'Content-Type', 'application/json',
          'User-Agent', 'dnf-price-tracker-watchdog'
        )
      );
      v_action := 'alert';
      v_note := COALESCE(v_note || ' · ', '') || '복구 ' || v_recovers || '회 실패 → 이슈 생성';
    END IF;
  END IF;

  INSERT INTO collection_health (last_collect_at, gap_min, action, note)
  VALUES (v_last, v_gap, v_action, v_note);
END;
$fn$;

SELECT cron.unschedule('dnf-collect-watchdog')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dnf-collect-watchdog');

SELECT cron.schedule('dnf-collect-watchdog', '*/5 * * * *', $$SELECT check_collection_health()$$);

-- 오래된 기록 정리 (90일). 가동률 계산에는 그 정도면 충분하다.
SELECT cron.unschedule('dnf-health-prune')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dnf-health-prune');

SELECT cron.schedule('dnf-health-prune', '17 4 * * *',
  $$DELETE FROM collection_health WHERE checked_at < now() - interval '90 days'$$);

-- 점검용
--   SELECT action, COUNT(*) FROM collection_health
--     WHERE checked_at > now() - interval '24 hours' GROUP BY 1;
--   SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE action='ok') / COUNT(*), 2) AS uptime_pct
--     FROM collection_health WHERE checked_at > now() - interval '24 hours';
