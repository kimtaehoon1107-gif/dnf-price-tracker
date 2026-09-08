-- 던파 경매장 시세 추적기 — Postgres(Supabase) 스키마
--
-- SQLite판(sql/schema.sqlite.sql)에서 옮겨온 것. 설계 근거는 그쪽 주석 참고.
-- 여러 번 실행해도 안전하다.
--
-- 금액은 BIGINT다. 총액(price)은 수량이 곱해지므로 int4 상한을 넘길 수 있다
--   (예: 200개 × 4,890,000골드 = 978,000,000. 여유를 둔다)

CREATE TABLE IF NOT EXISTS items (
  item_id           TEXT PRIMARY KEY,
  item_name         TEXT        NOT NULL,
  item_rarity       TEXT,
  item_type_detail  TEXT,
  poll_interval_sec INTEGER     NOT NULL DEFAULT 600,
  tracked           BOOLEAN     NOT NULL DEFAULT TRUE,
  role              TEXT,
  note              TEXT,
  -- 화면 분류와 "종결"(현재 기준 최상위) 메타데이터.
  -- 종결은 패치로 교체되므로 final_since에 언제 바뀌었는지를 남긴다.
  category          TEXT,
  slot              TEXT,          -- 무기 / 상의 / 하의 … (인챈트 카드)
  job_role          TEXT,          -- 딜러 / 버퍼
  is_final          BOOLEAN     NOT NULL DEFAULT FALSE,
  key_stat          TEXT,          -- 종결 안에서 성능이 갈릴 때의 핵심 옵션 (예: 최종뎀 9.6%)
  final_since       DATE,
  backfilled_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- auction-sold에는 auctionNo가 없어 자연키로 중복을 제거한다.
-- 대량 매수가 "같은 초·같은 개당가·같은 수량"인 별개 체결을 여러 건 만들기 때문에
-- 응답 안의 등장 순번(dup_seq)까지 키에 포함해야 한다. 실측상 이게 없으면 15% 손실.
CREATE TABLE IF NOT EXISTS trades (
  id                 BIGSERIAL PRIMARY KEY,
  item_id            TEXT        NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  sold_date          TIMESTAMPTZ NOT NULL,
  unit_price         BIGINT      NOT NULL,
  count              INTEGER     NOT NULL,
  price              BIGINT      NOT NULL,
  reinforce          INTEGER     NOT NULL DEFAULT 0,
  refine             INTEGER     NOT NULL DEFAULT 0,
  amplification_name TEXT,
  dup_seq            INTEGER     NOT NULL DEFAULT 0,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, sold_date, unit_price, count, reinforce, dup_seq)
);
CREATE INDEX IF NOT EXISTS idx_trades_item_time ON trades (item_id, sold_date);

-- 경매장 전체 후보를 하루 한 번 훑은 거래대금 순위. 연속수집 대상과 분리해
-- 분석용 시계열을 불필요하게 늘리지 않는다.
CREATE TABLE IF NOT EXISTS market_rankings (
  captured_at      TIMESTAMPTZ NOT NULL,
  rank             INTEGER     NOT NULL,
  item_id          TEXT        NOT NULL,
  item_name        TEXT        NOT NULL,
  item_rarity      TEXT,
  item_type_detail TEXT,
  turnover_24h     BIGINT      NOT NULL,
  observed_qty     BIGINT      NOT NULL,
  trade_count      INTEGER     NOT NULL,
  last_price       BIGINT      NOT NULL,
  basis            TEXT        NOT NULL CHECK (basis IN ('collected', 'api_complete', 'estimated')),
  span_minutes     DOUBLE PRECISION,
  PRIMARY KEY (captured_at, item_id)
);
CREATE INDEX IF NOT EXISTS idx_market_rankings_latest ON market_rankings (captured_at DESC, rank);

-- regCount는 스태커블 매물에만 온다. 아바타·장비 단품에는 없으므로
-- 수집기에서 `regCount ?? count`로 채워 넣는다.
CREATE TABLE IF NOT EXISTS listings (
  auction_no    BIGINT PRIMARY KEY,
  item_id       TEXT        NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  reg_date      TIMESTAMPTZ NOT NULL,
  expire_date   TIMESTAMPTZ NOT NULL,
  unit_price    BIGINT      NOT NULL,
  reg_count     INTEGER     NOT NULL,
  cur_count     INTEGER     NOT NULL,
  reinforce     INTEGER     NOT NULL DEFAULT 0,
  fame          INTEGER,
  upgrade       INTEGER,
  upgrade_max   INTEGER,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL,
  closed_at     TIMESTAMPTZ
);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS fame INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS upgrade INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS upgrade_max INTEGER;
CREATE INDEX IF NOT EXISTS idx_listings_open ON listings (item_id) WHERE closed_at IS NULL;

-- 매물 소진 관측 — auction-sold와 별개인 보조 활동량 신호다.
-- 만료 전 사라진 매물은 판매와 취소를 구분할 수 없어 체결량과 합산하지 않는다.
CREATE TABLE IF NOT EXISTS listing_deltas (
  id          BIGSERIAL PRIMARY KEY,
  auction_no  BIGINT      NOT NULL,
  item_id     TEXT        NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  unit_price  BIGINT      NOT NULL,
  qty_sold    INTEGER     NOT NULL,
  prev_count  INTEGER     NOT NULL,
  new_count   INTEGER     NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  reason      TEXT        NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deltas_item_time ON listing_deltas (item_id, observed_at);

CREATE TABLE IF NOT EXISTS listing_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  item_id        TEXT        NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  captured_at    TIMESTAMPTZ NOT NULL,
  min_unit_price BIGINT,
  p10            BIGINT,
  p25            BIGINT,
  median         BIGINT,
  listing_count  INTEGER     NOT NULL,
  total_qty      INTEGER     NOT NULL,
  upgrade        INTEGER,
  upgrade_max    INTEGER
);
ALTER TABLE listing_snapshots ADD COLUMN IF NOT EXISTS upgrade INTEGER;
ALTER TABLE listing_snapshots ADD COLUMN IF NOT EXISTS upgrade_max INTEGER;
ALTER TABLE listing_snapshots DROP CONSTRAINT IF EXISTS listing_snapshots_item_id_captured_at_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_item_time_upgrade
  ON listing_snapshots (item_id, captured_at, COALESCE(upgrade, -1));
CREATE INDEX IF NOT EXISTS idx_snapshots_item_upgrade_time
  ON listing_snapshots (item_id, upgrade, captured_at DESC);

-- 시계열의 구멍을 찾는 유일한 수단
CREATE TABLE IF NOT EXISTS collection_runs (
  id            BIGSERIAL PRIMARY KEY,
  item_id       TEXT,
  source        TEXT CHECK (source IN ('local', 'manual', 'actions')),
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  sold_rows     INTEGER     NOT NULL DEFAULT 0,
  sold_new      INTEGER     NOT NULL DEFAULT 0,
  sold_span_min REAL,
  saturated     BOOLEAN     NOT NULL DEFAULT FALSE,
  listing_rows  INTEGER     NOT NULL DEFAULT 0,
  deltas_found  INTEGER     NOT NULL DEFAULT 0,
  error         TEXT
);
-- 기존 DB에도 출처 컬럼을 안전하게 추가한다. 과거 행은 추측하지 않고 NULL로 둔다.
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS source TEXT;
DO $$
BEGIN
  ALTER TABLE collection_runs
    ADD CONSTRAINT collection_runs_source_check
    CHECK (source IN ('local', 'manual', 'actions'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_runs_item_time ON collection_runs (item_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_finished ON collection_runs (finished_at DESC) WHERE error IS NULL;

-- API가 주지 않는, 손으로 채우는 유일한 테이블.
-- announced_at과 starts_at을 반드시 분리한다 — 그 차이가 정보 반영 속도다.
CREATE TABLE IF NOT EXISTS events (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,
  announced_at     TIMESTAMPTZ,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  related_item_ids TEXT[],
  source_url       TEXT,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 레전더리 카드 최저가 지수.
-- 레전더리 카드는 합성·강화 재료로 들어가므로 "가장 싼 게 얼마냐"가 곧 재료비 하한선이다.
-- 어느 카드가 최저가인지는 수시로 바뀌므로 전종을 훑어 바닥을 찾는다 (scripts/legendary-floor.ts).
CREATE TABLE IF NOT EXISTS legendary_card_floor (
  id             BIGSERIAL PRIMARY KEY,
  captured_at    TIMESTAMPTZ NOT NULL,
  min_unit_price BIGINT      NOT NULL,
  min_item_id    TEXT        NOT NULL,
  min_item_name  TEXT        NOT NULL,
  p10            BIGINT,
  median         BIGINT,
  scanned        INTEGER     NOT NULL,
  with_listings  INTEGER     NOT NULL,
  total_listings INTEGER     NOT NULL,
  upgrade        INTEGER
);
ALTER TABLE legendary_card_floor ADD COLUMN IF NOT EXISTS upgrade INTEGER;
CREATE INDEX IF NOT EXISTS idx_lcf_time ON legendary_card_floor (captured_at);

-- 이 컬럼이 생기기 전에 수집한 카드 매물은 업그레이드 단계를 알 수 없다.
-- 새 0업 수집과 섞이지 않도록 열린 상태만 닫고, 과거 행 자체는 보존한다.
UPDATE listings l SET closed_at = COALESCE(l.closed_at, now())
FROM items i
WHERE l.item_id = i.item_id AND i.category = '카드'
  AND l.closed_at IS NULL AND l.upgrade IS NULL;
