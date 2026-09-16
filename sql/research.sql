-- 발행일별 입력과 예측은 INSERT만 한다. 정적 사이트에는 읽기 전용 결과를 내보낸다.
CREATE TABLE IF NOT EXISTS research_forecast_batches (
  version TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin ~ '^\d{4}-\d{2}-\d{2}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  data_as_of TIMESTAMPTZ NOT NULL,
  issues JSONB NOT NULL,
  PRIMARY KEY (version, origin)
);
CREATE TABLE IF NOT EXISTS research_actuals (
  version TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target ~ '^\d{4}-\d{2}-\d{2}$'),
  settled_at TIMESTAMPTZ NOT NULL,
  values JSONB NOT NULL,
  PRIMARY KEY (version, target)
);
ALTER TABLE research_forecast_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_actuals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON research_forecast_batches, research_actuals FROM anon, authenticated;
