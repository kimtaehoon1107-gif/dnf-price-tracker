-- 원본 매물 대신 카드별 요약을 한 실행의 JSON으로 압축 보관한다.
-- pending은 아직 저장되지 않은 결과다. 중단된 실행을 정상 무매물로 해석하지 않는다.
CREATE TABLE IF NOT EXISTS legendary_card_scans (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running','complete','partial','failed','interrupted')),
  expected INTEGER NOT NULL CHECK (expected > 0),
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  observations JSONB NOT NULL CHECK (jsonb_typeof(observations)='array'),
  CHECK (succeeded >= 0 AND failed >= 0 AND succeeded + failed <= expected)
);
CREATE INDEX IF NOT EXISTS idx_legendary_scans_started ON legendary_card_scans (started_at);
ALTER TABLE legendary_card_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON legendary_card_scans FROM anon, authenticated;
REVOKE ALL ON SEQUENCE legendary_card_scans_id_seq FROM anon, authenticated;
