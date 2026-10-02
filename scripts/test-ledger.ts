import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { HYPOTHESES } from '../src/forward-test.ts';
import { STATUS, applyLive, buildSections, countByStatus, evidenceLink, liveHTML, needsFilterReset } from '../web/ledger.js';

// ── 등록부: 근거 링크가 실제로 있고, 상태·참조가 올바른가 ───────────────────
const ledger = JSON.parse(readFileSync('config/research-ledger.json', 'utf8'));
const items = ledger.sections.flatMap((s: any) => s.items);
assert(items.length >= 15);
assert.equal(new Set(items.map((i: any) => i.id)).size, items.length, '항목 id 중복');
assert.equal(new Set(ledger.sections.map((s: any) => s.id)).size, ledger.sections.length, '절 id 중복');
assert(/^\d{4}-\d{2}-\d{2}$/.test(ledger.updated), '갱신일 형식');
// 생성되는 화면(package-study.html)은 저장소에 없으므로 따로 허용한다.
const generated = new Set(['package-study.html']);
for (const it of items) {
  assert(it.question && it.result, `${it.id}: 질문·결과 필요`);
  assert(it.status in STATUS, `${it.id}: 알 수 없는 상태 ${it.status}`);
  assert(it.evidence?.length, `${it.id}: 근거가 있어야 한다`);
  for (const e of it.evidence) {
    assert(e.label, `${it.id}: 근거 이름`);
    assert(Boolean(e.doc) !== Boolean(e.href), `${it.id}: 근거는 doc 또는 href 하나`);
    if (e.doc) assert(existsSync(e.doc), `${it.id}: 문서가 없다 ${e.doc}`);
    else assert(existsSync(`web/${e.href.split('#')[0]}`) || generated.has(e.href.split('#')[0]), `${it.id}: 화면이 없다 ${e.href}`);
  }
  if (it.live) {
    const id = it.live.replace('ft1:', '');
    const spec = HYPOTHESES.find((h) => h.id === id);
    assert(spec?.primary, `${it.id}: 전향 검증 1차 가설만 연결한다`);
    assert.equal(it.id, `ft1-${id}`, `${it.id}: 화면의 #ft1-ID 링크와 같아야 한다`);
  }
}
// 1차 가설 4개가 모두 원장에 있다.
for (const h of HYPOTHESES.filter((h) => h.primary)) assert(items.some((i: any) => i.live === `ft1:${h.id}`), `${h.id} 누락`);
// 화면·띠가 가리키는 닻이 있다.
const html = readFileSync('web/index.html', 'utf8');
const banner = html.match(/id="event-banner" href="ledger\.html#([^"]+)"/)?.[1];
assert(banner && items.some((i: any) => i.id === banner), '판매 종료 띠가 가리키는 항목');
for (const id of ['pkg-end', 'pkg-survivors']) assert(items.some((i: any) => i.id === id));
assert(items.every((i: any) => i.status !== 'confirmed' || !i.live), '확인됨 상태를 손으로 쓰지 않는다: 전향 검증 항목은 보고서가 정한다');

// ── 근거 링크 ──────────────────────────────────────────────────────────
assert.deepEqual(evidenceLink({ label: 'a', doc: 'docs/x.md' }),
  { href: 'https://github.com/kimtaehoon1107-gif/dnf-price-tracker/blob/main/docs/x.md', external: true, label: 'a' });
assert.deepEqual(evidenceLink({ label: 'b', href: 'analysis.html' }), { href: 'analysis.html', external: false, label: 'b' });

// ── 전향 검증 판정을 상태로 옮기는 규칙 ───────────────────────────────────
const item = { id: 'ft1-H1', live: 'ft1:H1', status: 'waiting' };
const report = (status: string) => ({ hypotheses: [{ id: 'H1', status, kind: 'block' }] });
assert.deepEqual(['collecting', 'confirmed', 'unconfirmed', 'insufficient', 'waiting'].map((s) => {
  const r = applyLive(item, report(s));
  return [r.status, r.label];
}), [['running', '검증 중'], ['confirmed', '확인됨'], ['negative', '미확정'], ['waiting', '표본 부족'], ['waiting', '시작 대기']]);
assert.equal(applyLive(item, null).status, 'waiting', '보고서가 없으면 등록된 상태를 쓴다');
assert.equal(applyLive(item, null).label, STATUS.waiting.label);
assert.equal(applyLive({ id: 'x', status: 'negative' }, report('confirmed')).status, 'negative', '전향 검증과 연결되지 않은 항목은 바뀌지 않는다');
assert.equal(applyLive(item, { hypotheses: [{ id: 'H2', status: 'confirmed' }] }).status, 'waiting', '다른 가설의 판정은 섞이지 않는다');
const counts = countByStatus([{ status: 'confirmed' }, { status: 'confirmed' }, { status: 'negative' }]);
assert.deepEqual([counts.confirmed, counts.negative, counts.partial, counts.running, counts.waiting], [2, 1, 0, 0, 0]);
// ── 필터와 요약 링크, 보고서 링크 ─────────────────────────────────────────
const sections = buildSections(ledger, null);
assert.equal(needsFilterReset(sections, 'all', 'pkg-end'), false, '필터가 없으면 풀 필요가 없다');
assert.equal(needsFilterReset(sections, 'confirmed', 'pkg-end'), true, '확인됨만 보는 중에 검증 중 항목으로 가는 링크');
assert.equal(needsFilterReset(sections, 'confirmed', 'pkg-efficiency'), false, '필터에 맞는 항목은 그대로');
assert.equal(needsFilterReset(sections, 'confirmed', 'package'), false, '필터에 맞는 항목이 있는 절은 그대로');
assert.equal(needsFilterReset(sections, 'confirmed', 'forward'), true, '필터에 맞는 항목이 없는 절');
assert.equal(needsFilterReset(sections, 'waiting', 'ft1-H1'), false, '표본 대기 필터에서 전향 검증 항목');
assert.equal(needsFilterReset(sections, 'confirmed', ''), false);
assert.equal(needsFilterReset(sections, 'confirmed', 'no-such-id'), false, '없는 닻은 건드리지 않는다');
assert(!liveHTML(null).includes('forward-test.json'), '보고서가 없으면 404가 될 링크를 보이지 않는다');
assert(liveHTML({ hypotheses: [] }).includes('forward-test.json'), '보고서가 있으면 링크를 보인다');
console.log(`연구 원장: 항목 ${items.length}개의 근거 링크·상태·닻과 전향 검증 판정 연결 통과`);
