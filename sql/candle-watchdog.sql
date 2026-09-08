-- 수집이 살아 있어도 시간봉 집계는 따로 멈출 수 있다.
CREATE TABLE IF NOT EXISTS candle_health (
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at TIMESTAMPTZ,
  gap_min NUMERIC,
  stale BOOLEAN NOT NULL,
  alert_request_id BIGINT
);
CREATE INDEX IF NOT EXISTS idx_candle_health_time ON candle_health (checked_at DESC);

CREATE OR REPLACE FUNCTION check_candle_health() RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  v_last TIMESTAMPTZ;
  v_gap NUMERIC;
  v_stale BOOLEAN;
  v_token TEXT;
  v_request BIGINT;
  v_threshold CONSTANT NUMERIC := 90; -- 매시 집계 + 30분 여유
BEGIN
  SELECT refreshed_at INTO v_last FROM candle_pipeline_state WHERE singleton;
  v_gap := EXTRACT(EPOCH FROM now()-v_last)/60;
  v_stale := v_last IS NULL OR v_gap > v_threshold;
  IF v_stale AND NOT EXISTS (
    SELECT 1 FROM candle_health WHERE alert_request_id IS NOT NULL
      AND checked_at > now()-interval '6 hours'
  ) THEN
    SELECT decrypted_secret INTO v_token
      FROM vault.decrypted_secrets WHERE name='gh_dispatch_token';
    SELECT net.http_post(
      url := 'https://api.github.com/repos/kimtaehoon1107-gif/dnf-price-tracker/issues',
      body := jsonb_build_object(
        'title', '[감시견] 시간봉 집계가 지연되고 있습니다',
        'body', '마지막 성공 집계: ' || COALESCE(v_last::text,'기록 없음') || E'\n' ||
          '마지막 집계로부터 90분을 초과했습니다. 새 분석 배포는 차단됩니다.' || E'\n' ||
          'dnf-candles-refresh의 cron 실행 결과와 refresh_candles_1h() 오류를 확인해 주세요.',
        'labels', jsonb_build_array('watchdog')),
      headers := jsonb_build_object('Authorization','Bearer '||v_token,
        'Accept','application/vnd.github+json','Content-Type','application/json',
        'User-Agent','dnf-price-tracker-watchdog')
    ) INTO v_request;
  END IF;
  -- 요청 ID는 발송 시도를 뜻하며 HTTP 성공을 뜻하지 않는다.
  INSERT INTO candle_health (refreshed_at,gap_min,stale,alert_request_id)
    VALUES(v_last,v_gap,v_stale,v_request);
  DELETE FROM candle_health WHERE checked_at < now()-interval '90 days';
END;
$fn$;

SELECT cron.unschedule('dnf-candles-watchdog')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='dnf-candles-watchdog');
SELECT cron.schedule('dnf-candles-watchdog','*/5 * * * *',$$SELECT check_candle_health()$$);
