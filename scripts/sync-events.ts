// 공식 던파 업데이트와 세리아 상점에서 시세에 영향을 줄 만한 일정만 events에 넣는다.
// 매주 한 번만 실행하며 source_url 또는 이름+적용일로 중복을 막는다.

import { query, pool } from '../src/db.ts';

const BASE = 'https://df.nexon.com';
const dryRun = process.argv.includes('--dry-run');

type Candidate = {
  name: string;
  type: string;
  announcedAt: string | null;
  startsAt: string;
  endsAt: string | null;
  relatedItemIds: string[] | null;
  sourceUrl: string;
  note: string;
};

const clean = (html: string) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const day = (value: string) => value.replaceAll('.', '-');
const kst = (date: string, time = '00:00:00') => `${date}T${time}+09:00`;

async function html(url: string) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'dnf-price-tracker/0.1 (weekly official notice sync)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function publishedAt(detail: string, fallbackDay: string) {
  const match = detail.match(/<span class="date">\s*(\d{4}\.\d{2}\.\d{2})\s+(\d{2}:\d{2})\s*<\/span>/);
  return match ? kst(day(match[1]), `${match[2]}:00`) : kst(fallbackDay, '15:00:00');
}

function shopEndAt(detail: string, endDay: string) {
  const [year, month, date] = endDay.split('-').map(Number);
  const text = clean(detail);
  const match = text.match(new RegExp(`${year}년\\s*0?${month}월\\s*0?${date}일\\s*(\\d{1,2})시`));
  return kst(endDay, match ? `${match[1].padStart(2, '0')}:00:00` : '23:59:59');
}

function nextDay(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function appliedDay(title: string, announcedDay: string) {
  const match = title.match(/(\d{1,2})\/(\d{1,2})\(목\)/);
  if (match) return `${announcedDay.slice(0, 4)}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  // 대규모 업데이트는 통상 수요일 공지, 목요일 적용이다.
  return nextDay(announcedDay);
}

function updateType(title: string, content: string) {
  if (/레이드/.test(title) || /레이드[^.!?]{0,50}(?:추가|업데이트)됩니다/.test(content)) return '레이드';
  if (/패키지|아바타/.test(title)) return '패키지';
  if (/보상|드롭|드랍|상점|거래|교환|아이템/.test(content)) return '아이템';
  return '패치';
}

function hasMarketImpact(content: string) {
  // 버그 수정의 단순 키워드 일치는 제외하고, 공급·수요 구조가 바뀌는 문장만 통과시킨다.
  const main = content.split('버그 수정')[0];
  return [
    /(?:신규\s*)?(?:레이드|던전|콘텐츠)[^.!?]{0,40}(?:추가|업데이트)됩니다/,
    /(?:보상|드롭|드랍|상점|거래|교환)[^.!?]{0,50}(?:추가|개편|변경)됩니다/,
    /(?:강화|증폭|성장|제작)[^.!?]{0,50}(?:추가|개편|변경)됩니다/,
    /신규[^.!?]{0,30}(?:아이템|재료|카드|소울)/,
  ].some((pattern) => pattern.test(main));
}

async function updateCandidates() {
  const list = await html(`${BASE}/community/news/update/list`);
  const rows = [...list.matchAll(
    /<ul[^>]*>[\s\S]*?<li class="category">([\s\S]*?)<\/li>[\s\S]*?<li class="title"[^>]*data-no="(\d+)"[^>]*>([\s\S]*?)<div class="iconset">[\s\S]*?<\/li>[\s\S]*?<li class="date">\s*(\d{4}\.\d{2}\.\d{2})\s*<\/li>[\s\S]*?<\/ul>/g,
  )];
  const candidates: Candidate[] = [];
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 45);
  const cutoffDay = cutoff.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

  for (const row of rows) {
    const category = clean(row[1]);
    if (['퍼스트서버', '던파ON'].includes(category)) continue;
    const no = row[2];
    const title = clean(row[3]);
    const announcedDay = day(row[4]);
    if (announcedDay < cutoffDay) continue;
    const sourceUrl = `${BASE}/community/news/update/${no}`;
    const detail = await html(sourceUrl);
    const start = detail.indexOf('<div class="bd_viewcont">');
    const end = detail.indexOf('<article class="bdview_btnarea', start);
    const content = clean(start >= 0 ? detail.slice(start, end > start ? end : undefined) : detail);
    if (!['대규모', '주요'].includes(category) && !hasMarketImpact(content)) continue;

    candidates.push({
      name: title,
      type: ['대규모', '주요'].includes(category) ? category : updateType(title, content),
      announcedAt: publishedAt(detail, announcedDay),
      startsAt: kst(appliedDay(title, announcedDay)),
      endsAt: null,
      relatedItemIds: null,
      sourceUrl,
      note: `던파 공식 업데이트 자동 수집 · 공식 분류 ${category}`,
    });
  }
  return candidates;
}

const GENERIC_PRODUCT_WORDS = new Set(['패키지', '아바타', '콤보', '상자', '시즌', '한정', '세트']);

function productTerms(title: string) {
  return title.replace(/20\d{2}/g, '').split(/[^0-9A-Za-z가-힣]+/)
    .filter((word) => word.length >= 2 && !GENERIC_PRODUCT_WORDS.has(word));
}

function relatedItems(title: string, items: Array<{ item_id: string; item_name: string }>) {
  const terms = productTerms(title);
  if (!terms.length) return [];
  const needed = Math.min(2, terms.length);
  return items.filter((item) => terms.filter((term) => item.item_name.includes(term)).length >= needed)
    .map((item) => item.item_id);
}

async function shopCandidates() {
  const list = await html(`${BASE}/community/news/seriashop/list`);
  const items = (await query<{ item_id: string; item_name: string }>(
    'SELECT item_id, item_name FROM items WHERE tracked',
  )).rows;
  const candidates: Candidate[] = [];

  for (const row of list.matchAll(/<ul[^>]*data-id="(\d+)"[^>]*>([\s\S]*?)<\/ul>/g)) {
    const no = row[1];
    const body = row[2];
    const titleMatch = body.match(/<b>([\s\S]*?)<\/b>/);
    const range = body.match(/(\d{4}\.\d{2}\.\d{2})\s*~\s*(\d{4}\.\d{2}\.\d{2})/);
    if (!titleMatch || !range) continue;
    const title = clean(titleMatch[1]);
    if (!/패키지|아바타|패스/.test(title)) continue;
    const itemIds = relatedItems(title, items);
    if (!itemIds.length) continue;

    const sourceUrl = `${BASE}/community/news/seriashop/${no}`;
    const detail = await html(sourceUrl);
    const startsAt = day(range[1]);
    const endsAt = day(range[2]);
    candidates.push({
      name: title,
      type: /패키지/.test(title) ? '패키지' : '아바타',
      announcedAt: publishedAt(detail, startsAt),
      startsAt: kst(startsAt),
      endsAt: shopEndAt(detail, endsAt),
      relatedItemIds: itemIds,
      sourceUrl,
      note: '던파 공식 세리아 상점 자동 수집',
    });
  }
  return candidates;
}

async function save(candidate: Candidate) {
  const startDay = candidate.startsAt.slice(0, 10);
  const found = await query<{ id: string }>(`
    SELECT id::text FROM events
    WHERE source_url = $1
       OR (name = $2 AND (starts_at AT TIME ZONE 'Asia/Seoul')::date = $3::date)
    ORDER BY id LIMIT 1`, [candidate.sourceUrl, candidate.name, startDay]);
  const existing = found.rows[0];
  if (dryRun) {
    console.log(`${existing ? '갱신' : '추가'} 예정 · [${candidate.type}] ${candidate.name} · ${startDay}`);
    return existing ? 'updated' : 'inserted';
  }

  if (existing) {
    await query(`UPDATE events SET
      type = $2, announced_at = COALESCE($3::timestamptz, announced_at),
      starts_at = $4::timestamptz, ends_at = COALESCE($5::timestamptz, ends_at),
      related_item_ids = CASE WHEN $6::text[] IS NULL THEN related_item_ids ELSE $6::text[] END,
      source_url = $7, note = $8
      WHERE id = $1::bigint`, [existing.id, candidate.type, candidate.announcedAt, candidate.startsAt,
        candidate.endsAt, candidate.relatedItemIds, candidate.sourceUrl, candidate.note]);
    return 'updated';
  }

  await query(`INSERT INTO events
    (name, type, announced_at, starts_at, ends_at, related_item_ids, source_url, note)
    VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$5::timestamptz,$6::text[],$7,$8)`,
  [candidate.name, candidate.type, candidate.announcedAt, candidate.startsAt, candidate.endsAt,
    candidate.relatedItemIds, candidate.sourceUrl, candidate.note]);
  return 'inserted';
}

try {
  const candidates = [...await updateCandidates(), ...await shopCandidates()];
  const unique = [...new Map(candidates.map((candidate) => [candidate.sourceUrl, candidate])).values()];
  const counts = { inserted: 0, updated: 0 };
  for (const candidate of unique) counts[await save(candidate)]++;
  console.log(`${dryRun ? '검토' : '동기화'} 완료 · 후보 ${unique.length}건 · 추가 ${counts.inserted} · 갱신 ${counts.updated}`);
} finally {
  await pool.end();
}
