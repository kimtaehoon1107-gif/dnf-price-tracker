-- 던파 경매장 시세 추적기 — SQLite 스키마
--
-- 이식성 원칙 (나중에 Supabase/Postgres로 옮김):
--   · 모든 시각은 ISO 8601 UTC 문자열. 정렬 가능하고 timestamptz로 그대로 옮겨진다.
--   · 금액·수량은 INTEGER. 골드는 정수이므로 부동소수점을 쓰지 않는다.
--   · SQLite 전용 문법(AUTOINCREMENT 등)을 쓰지 않는다.

-- 추적 대상 아이템 화이트리스트
CREATE TABLE IF NOT EXISTS items (
  item_id           TEXT PRIMARY KEY,
  item_name         TEXT    NOT NULL,
  item_rarity       TEXT,
  item_type_detail  TEXT,
  -- 폴링 주기. auction-sold가 최근 100건만 주므로, 거래가 빠른 아이템일수록 짧아야 한다.
  poll_interval_sec INTEGER NOT NULL DEFAULT 600,
  tracked           INTEGER NOT NULL DEFAULT 1,
  role              TEXT,              -- 고빈도 | 저빈도 | 대조군 | 기준재
  note              TEXT,
  backfilled_at     TEXT,
  created_at        TEXT    NOT NULL
);

-- 체결 내역 (/df/auction-sold)
--
-- 이 API는 auctionNo를 주지 않는다(실측 확인). 따라서 자연키로 중복을 제거한다.
--
-- 그런데 자연키만으로는 부족하다. 대량 매수가 여러 매물을 한 번에 쓸어가면
-- "같은 초 · 같은 개당가 · 같은 수량"인 별개의 체결이 여러 건 생긴다.
-- 실측: 레전더리 소울 결정은 응답 100건 중 15건이 이런 동일키였다(15% 손실).
--
-- 그래서 응답 안에서 동일키가 몇 번째로 나타났는지를 dup_seq로 함께 잠근다.
-- 같은 그룹은 재폴링해도 같은 순번이 매겨지므로 중복 제거는 그대로 동작하고,
-- 그 사이 그룹이 커졌다면 늘어난 만큼만 새로 들어온다.
CREATE TABLE IF NOT EXISTS trades (
  id                 INTEGER PRIMARY KEY,
  item_id            TEXT    NOT NULL REFERENCES items(item_id),
  sold_date          TEXT    NOT NULL,
  unit_price         INTEGER NOT NULL,
  count              INTEGER NOT NULL,
  price              INTEGER NOT NULL,
  reinforce          INTEGER NOT NULL DEFAULT 0,
  refine             INTEGER NOT NULL DEFAULT 0,
  amplification_name TEXT,
  dup_seq            INTEGER NOT NULL DEFAULT 0,
  ingested_at        TEXT    NOT NULL,
  UNIQUE (item_id, sold_date, unit_price, count, reinforce, dup_seq)
);
CREATE INDEX IF NOT EXISTS idx_trades_item_time ON trades (item_id, sold_date);

-- 현재 열려 있는 매물 (/df/auction) — auctionNo별 최신 상태만 유지
--
-- regCount(등록 수량)와 count(잔여 수량)가 따로 오므로 부분 판매를 추적할 수 있다.
-- 테이블 크기는 "지금 경매장에 올라와 있는 매물 수"로 유지된다.
CREATE TABLE IF NOT EXISTS listings (
  auction_no    INTEGER PRIMARY KEY,
  item_id       TEXT    NOT NULL REFERENCES items(item_id),
  reg_date      TEXT    NOT NULL,
  expire_date   TEXT    NOT NULL,
  unit_price    INTEGER NOT NULL,
  reg_count     INTEGER NOT NULL,
  cur_count     INTEGER NOT NULL,
  reinforce     INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  closed_at     TEXT               -- 목록에서 사라진 시각 (완판 또는 만료)
);
CREATE INDEX IF NOT EXISTS idx_listings_item ON listings (item_id, closed_at);

-- 매물 소진 관측 — auction-sold의 100건 한계를 보완하는 보조 거래량 신호
--
-- 같은 auction_no의 cur_count가 줄어든 순간을 기록한다.
-- auction-sold가 놓친 거래도 여기서는 잡힌다.
CREATE TABLE IF NOT EXISTS listing_deltas (
  id          INTEGER PRIMARY KEY,
  auction_no  INTEGER NOT NULL,
  item_id     TEXT    NOT NULL REFERENCES items(item_id),
  unit_price  INTEGER NOT NULL,
  qty_sold    INTEGER NOT NULL,
  prev_count  INTEGER NOT NULL,
  new_count   INTEGER NOT NULL,
  observed_at TEXT    NOT NULL,
  reason      TEXT    NOT NULL   -- partial | vanished_before_expiry | expired
);
CREATE INDEX IF NOT EXISTS idx_deltas_item_time ON listing_deltas (item_id, observed_at);

-- 호가 분포 요약 — 매물 전체를 다시 저장하지 않고 분위수만 남긴다
CREATE TABLE IF NOT EXISTS listing_snapshots (
  id             INTEGER PRIMARY KEY,
  item_id        TEXT    NOT NULL REFERENCES items(item_id),
  captured_at    TEXT    NOT NULL,
  min_unit_price INTEGER,
  p10            INTEGER,
  p25            INTEGER,
  median         INTEGER,
  listing_count  INTEGER NOT NULL,
  total_qty      INTEGER NOT NULL,
  UNIQUE (item_id, captured_at)
);

-- 수집 이력 — 시계열의 구멍을 찾는 유일한 수단
CREATE TABLE IF NOT EXISTS collection_runs (
  id            INTEGER PRIMARY KEY,
  item_id       TEXT,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT,
  sold_rows     INTEGER NOT NULL DEFAULT 0,
  sold_new      INTEGER NOT NULL DEFAULT 0,
  sold_span_min REAL,
  -- 응답이 100건으로 꽉 찼고 가장 오래된 거래가 직전 폴링 이후 → 그 사이 거래를 놓쳤다는 뜻
  saturated     INTEGER NOT NULL DEFAULT 0,
  listing_rows  INTEGER NOT NULL DEFAULT 0,
  deltas_found  INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_item_time ON collection_runs (item_id, started_at);

-- 이벤트 캘린더 — API가 주지 않는, 손으로 채우는 유일한 테이블
--
-- announced_at과 starts_at을 반드시 분리한다. 그 차이가 곧 정보 반영 속도다.
CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,   -- 이벤트 | 패키지 | 소멸 | 패치
  announced_at     TEXT,
  starts_at        TEXT,
  ends_at          TEXT,
  related_item_ids TEXT,            -- JSON 배열
  source_url       TEXT,
  note             TEXT,
  created_at       TEXT NOT NULL
);
