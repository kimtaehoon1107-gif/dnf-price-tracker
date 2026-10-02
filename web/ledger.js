// 연구 원장: config/research-ledger.json(data/ledger.json)의 질문·상태·근거를 그리고,
// 전향 검증 보고서(data/forward-test.json)를 겹쳐 지금 상태를 보여 준다.
// 상태는 손으로 바꾸지 않는 값(전향 검증)과 사람이 근거를 달아 쓰는 값(후향 결과)으로 나뉜다.
import { bannerState } from './event-banner.js';

export const STATUS = {
  confirmed: { label: '확인됨', glyph: '●' },
  partial: { label: '후보·일부 확인', glyph: '◐' },
  running: { label: '검증 중', glyph: '◔' },
  negative: { label: '확인하지 못함', glyph: '✕' },
  waiting: { label: '표본 대기', glyph: '○' },
};
// 전향 검증 판정 → 원장 상태. 미확정과 표본 부족은 반증이 아니므로 문구로 구분한다.
const FORWARD = {
  waiting: ['waiting', '시작 대기'], collecting: ['running', '검증 중'], confirmed: ['confirmed', '확인됨'],
  unconfirmed: ['negative', '미확정'], insufficient: ['waiting', '표본 부족'], reported: ['partial', '결과 공개'],
};
const REPO = 'https://github.com/kimtaehoon1107-gif/dnf-price-tracker/blob/main/';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, digits = 1) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);
const MD = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

/** 항목에 전향 검증 보고서의 현재 판정을 겹친다. 보고서가 없으면 등록된 정적 상태를 그대로 쓴다. */
export function applyLive(item, report) {
  const live = item.live && report?.hypotheses?.find((h) => `ft1:${h.id}` === item.live);
  if (!live) return { ...item, label: STATUS[item.status].label };
  const [status, label] = FORWARD[live.status] ?? FORWARD.waiting;
  return { ...item, status, label, report: live };
}

export function countByStatus(items) {
  const out = Object.fromEntries(Object.keys(STATUS).map((k) => [k, 0]));
  for (const it of items) out[it.status]++;
  return out;
}

/** 근거 링크: 사이트 안 페이지는 상대 경로, 저장소 문서는 GitHub 원문으로 연다. */
export function evidenceLink(e) {
  return e.doc ? { href: REPO + e.doc, external: true, label: e.label } : { href: e.href, external: false, label: e.label };
}

function progressHTML(live) {
  if (!live || live.status === 'waiting') return '<p class="lg-progress">기록 시작 전입니다. 병합 뒤 첫 사이트 빌드부터 사전 발행이 쌓입니다.</p>';
  if (live.kind === 'block') {
    const c = live.counts, acc = Object.fromEntries(live.models.map((m) => [m.model, m.accuracy]));
    return `<p class="lg-progress"><b>채점 게임일 ${c.days}/${live.rule.window}일</b> · 채점 구간 ${c.scored}개 · 시간대 ${pct(acc.slot)} · 최빈 방향 ${pct(acc.majority)}
      · 날짜별 승 ${live.sign.wins} 패 ${live.sign.losses} 무 ${live.sign.ties}${c.missed ? ` · 누락 ${c.missed}` : ''}</p>`;
  }
  const strip = live.weeks.map((w) => {
    const label = { ok: w.success ? '성공' : '실패', insufficient: '채점 불가(공통 관측 시간 부족)', pending: '대기', unsettled: '확정 대기', upcoming: '발행 전', missed: '누락' }[w.state];
    const mark = { ok: w.success ? '●' : '✕', insufficient: '–', pending: '○', unsettled: '○', upcoming: '·', missed: '×' }[w.state];
    return `<span class="lg-week lg-${w.state}${w.state === 'ok' ? (w.success ? ' yes' : ' no') : ''}" title="${MD(w.week)} 주 · ${label}" aria-label="${MD(w.week)} 주 ${label}">${mark}</span>`;
  }).join('');
  const c = live.counts;
  return `<p class="lg-progress"><b>채점 ${c.evaluable}/${live.rule.window}주</b> · 성공 ${c.successes}주 (판정 최소 ${live.rule.minWeeks}주)</p><div class="lg-weeks" role="img" aria-label="주별 결과">${strip}</div>`;
}

function itemHTML(it) {
  const links = (it.evidence ?? []).map(evidenceLink)
    .map((l) => `<a href="${esc(l.href)}"${l.external ? ' target="_blank" rel="noopener"' : ''}>${esc(l.label)}${l.external ? ' ↗' : ' →'}</a>`).join('');
  return `<article class="panel lg-item" id="${esc(it.id)}">
    <h3><span class="st st-${it.status}"><i aria-hidden="true">${STATUS[it.status].glyph}</i>${esc(it.label)}</span>${esc(it.question)}</h3>
    <p class="lg-result">${esc(it.result)}</p>
    ${it.live ? progressHTML(it.report) : ''}
    ${it.limit ? `<p class="lg-note"><b>한계</b> ${esc(it.limit)}</p>` : ''}
    ${it.next ? `<p class="lg-note"><b>다음</b> ${esc(it.next)}</p>` : ''}
    ${links ? `<p class="lg-links">${links}</p>` : ''}
  </article>`;
}

export function liveHTML(report) {
  const primary = report?.hypotheses?.filter((h) => h.primary) ?? [];
  const forward = primary.length ? `<ul class="lg-live-list">${primary.map((h) => {
    const [status, label] = FORWARD[h.status] ?? FORWARD.waiting;
    const detail = h.kind === 'block' ? `${h.counts?.days ?? 0}/${h.rule.window}게임일` : `${h.counts?.evaluable ?? 0}/${h.rule.window}주`;
    return `<li><span class="st st-${status}"><i aria-hidden="true">${STATUS[status].glyph}</i>${esc(label)}</span><a href="#ft1-${esc(h.id)}">${esc(h.id)} ${esc(h.title)}</a><small>${esc(detail)}</small></li>`;
  }).join('')}</ul>` : '<p class="lg-progress">기록은 사이트 빌드에서 시작하며 아직 발행된 표본이 없습니다.</p>';
  const b = bannerState(Date.now());
  const pkg = b.show ? `<p class="lg-dday"><b>${esc(b.lead)}</b> ${esc(b.text)}</p>` : '<p class="lg-progress">판매 종료 뒤 비교 구간이 끝났습니다.</p>';
  return `<div class="panel"><h3>전향 검증 FT1</h3><p class="desc">후향 후보 4개를 새 기간에서 확인하는 중입니다.</p>${forward}
      <p class="lg-links"><a href="${REPO}docs/forward-test-protocol-2026-10-02.md" target="_blank" rel="noopener">사전 등록 ↗</a>${report ? '<a href="data/forward-test.json">보고서 JSON →</a>' : ''}</p></div>
    <div class="panel"><h3>유랑악단 패키지 판매 종료</h3><p class="desc">2026-11-05 06:00 KST 삭제. 삭제 전 분석과 삭제 뒤 생존 품목 분석의 규칙을 미리 등록했습니다.</p>${pkg}
      <p class="lg-links"><a href="package-study.html">자료 점검 →</a><a href="#pkg-end">삭제 전 연구 →</a><a href="#pkg-survivors">생존 품목 연구 →</a></p></div>`;
}

async function fetchJson(url, optional = false) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) { if (optional) return null; throw new Error(`HTTP ${response.status}`); }
  return response.json();
}

export const buildSections = (ledger, report) => ledger.sections.map((s) => ({ ...s, items: s.items.map((it) => applyLive(it, report)) }));

/** 상태 필터가 감춘 항목·절로 가는 링크인지. 그렇다면 필터를 풀어야 닻이 움직인다. */
export function needsFilterReset(sections, filter, id) {
  if (!id || filter === 'all') return false;
  const hidden = new Set();
  for (const s of sections) {
    if (!s.items.some((it) => it.status === filter)) hidden.add(s.id);
    for (const it of s.items) if (it.status !== filter) hidden.add(it.id);
  }
  return hidden.has(id);
}

function render(root, sections, ledger, report, filter) {
  const all = sections.flatMap((s) => s.items), counts = countByStatus(all);
  document.getElementById('lg-live').innerHTML = liveHTML(report);
  document.getElementById('lg-filter').innerHTML = [['all', `전체 ${all.length}`], ...Object.entries(STATUS).map(([k, v]) => [k, `${v.label} ${counts[k]}`])]
    .map(([k, label]) => `<button type="button" data-filter="${k}" aria-pressed="${filter === k}">${esc(label)}</button>`).join('');
  root.innerHTML = sections.map((s) => {
    const items = s.items.filter((it) => filter === 'all' || it.status === filter);
    return items.length ? `<section class="lg-section" id="${esc(s.id)}"><h2>${esc(s.title)}</h2>${s.intro ? `<p class="lg-intro">${esc(s.intro)}</p>` : ''}${items.map(itemHTML).join('')}</section>` : '';
  }).join('') || '<div class="panel">이 상태의 항목이 없습니다.</div>';
  document.getElementById('lg-updated').textContent = `원장 갱신 ${ledger.updated}${report ? ` · 전향 검증 자료 ${new Date(report.asOf).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST` : ''}`;
}

if (typeof document !== 'undefined' && document.getElementById('ledger')) {
  const root = document.getElementById('ledger');
  let filter = 'all', ledger, report, sections;
  const draw = () => {
    sections = buildSections(ledger, report);
    render(root, sections, ledger, report, filter);
    const target = location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target && !draw.scrolled) { draw.scrolled = true; target.scrollIntoView(); }
  };
  document.getElementById('lg-filter').addEventListener('click', (e) => {
    const k = e.target.closest('button')?.dataset.filter;
    if (k) { filter = k; draw(); }
  });
  // 필터가 감춘 항목으로 가는 요약 링크를 눌렀을 때 아무 일도 없던 문제: 필터를 풀고 그 항목으로 이동한다.
  addEventListener('hashchange', () => {
    if (ledger && needsFilterReset(sections, filter, decodeURIComponent(location.hash.slice(1)))) { filter = 'all'; draw.scrolled = false; draw(); }
  });
  Promise.all([fetchJson('data/ledger.json'), fetchJson('data/forward-test.json', true).catch(() => null)])
    .then(([l, r]) => { ledger = l; report = r; draw(); })
    .catch(() => { root.innerHTML = '<div class="panel"><h3>연구 원장을 불러오지 못했습니다</h3><p class="desc">잠시 뒤 새로고침해 주세요.</p></div>'; });
}
