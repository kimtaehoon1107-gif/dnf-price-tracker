-- 전향 검증 FT1의 발행과 실측은 INSERT만 한다. 이미 있는 행은 덮어쓰지 않는다.
-- 정적 사이트에는 읽기 전용 보고서만 내보낸다.
CREATE TABLE IF NOT EXISTS forward_test_issues (
  version TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  target TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  data_as_of TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (version, hypothesis, target)
);
CREATE TABLE IF NOT EXISTS forward_test_actuals (
  version TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  target TEXT NOT NULL,
  settled_at TIMESTAMPTZ NOT NULL,
  values JSONB NOT NULL,
  PRIMARY KEY (version, hypothesis, target)
);
ALTER TABLE forward_test_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE forward_test_actuals ENABLE ROW LEVEL SECURITY;
-- 빌드용 임시 DB에는 Supabase 역할이 없으므로 있을 때만 권한을 회수한다.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON forward_test_issues, forward_test_actuals FROM anon, authenticated;
  END IF;
END $$;
