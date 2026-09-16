import assert from 'node:assert/strict';
import { weekdayTrend } from '../src/weekday-trend.ts';
import * as metrics from '../web/metrics.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const history = (scale = 1, weeks = 4, thursday = 1) => Array.from({ length: weeks * 7 }, (_, i) => ({
  d: new Date(Date.parse('2026-08-03') + i * 86400000).toISOString().slice(0, 10),
  price: scale * (1 + Math.floor(i / 7)) * (i % 7 === 3 ? thursday : 1),
}));
const before = '2026-09-08';
const flat = weekdayTrend(history(), before);
assert(flat.ready && flat.points.every((p) => p.price === 100));
assert.equal(flat.points[0].changeN, 3, '첫 월요일 전날은 임의로 채우지 않음');
assert(flat.points[0].change! > 0, '주평균 대비 가격 수준과 전날 대비 변화는 다른 지표');
assert(flat.points.slice(1).every((p) => p.change === 0));
assert.equal(weekdayTrend(history().slice(1), before).ready, false, '월요일 없는 주는 제외');
assert.equal(weekdayTrend(history(), '2026-08-30').weeks, 3, '진행 중인 일요일 제외');
assert.equal(weekdayTrend([...history(), ...history().slice(0, 7)], before).weeks, 4, '중복 날짜로 완료 주를 늘리지 않음');
assert.deepEqual(weekdayTrend([...history(), { d: before, price: 1e9 }], before), flat, '당일 가격은 자격·정규화에도 넣지 않음');
const gap = weekdayTrend(history(1, 5).filter((p) => p.d !== '2026-08-16'), before);
assert.equal(gap.points[0].changeN, 2, '첫 주·불완전 주·전날 일요일 결측의 월요일 변화를 제외');

const profiles = [
  { item_id: 'cheap', basis: 'trade', ...weekdayTrend(history(1, 4, 1.1), before) },
  { item_id: 'expensive', basis: 'trade', ...weekdayTrend(history(1e6, 5), before) },
  { item_id: 'card', basis: 'ask0', ...weekdayTrend(history(100, 4, .9), before) },
  { item_id: 'card', basis: 'askMax', ...weekdayTrend(history(1000, 4, 1.1), before) },
];
const all = metrics.summarizeWeekdays(profiles, ['cheap', 'expensive', 'card'], 'trade');
assert.equal(all.candidates, 2, '체결가와 카드 호가는 혼합하지 않음');
assert(Math.abs(all.points[3].price! - (profiles[0].points[3].price + 100) / 2) < 1e-9,
  '고가·관측 주가 긴 종목에도 같은 비중');
assert.equal(all.points[3].n, 9, '계산 표본은 4주+5주의 종목·일 수');
assert(metrics.summarizeWeekdays(profiles, ['card'], 'ask0').points[3].change! < 0);
assert(metrics.summarizeWeekdays(profiles, ['card'], 'askMax').points[3].change! > 0);

const context = vm.createContext({ console, fetch: () => new Promise(() => {}) });
const module = new vm.SourceTextModule(readFileSync('web/app.js', 'utf8') + `
export function renderFixture(data, category, role, basis) {
 DATA=data; tab=category; job=role; weekdayBasis=basis;
 return summaryCards()+weekdayTrendHTML();
}`, { context });
await module.link(() => new vm.SyntheticModule(Object.keys(metrics), function () {
  for (const [key, value] of Object.entries(metrics)) this.setExport(key, value);
}, { context }));
await module.evaluate();
const data = { meta: { items: 3, trades: 100, lo: '2026-08-03', hi: before }, weekdayTrends: { items: profiles },
  items: [{ item_id: 'cheap', category: '소울 결정' }, { item_id: 'expensive', category: '강화·증폭' },
    { item_id: 'card', category: '카드', job_role: '딜러' }] };
const render = (category = '전체', role = '전체', basis = 'trade', d = data) => module.namespace.renderFixture(d, category, role, basis);
const html = render();
assert.match(html, /요일별 가격 트렌드/);
assert.doesNotMatch(html, /목요일 가격 흐름|undefined|NaN/);
assert.match(html, /전날 대비 변화율/);
assert.match(html, /조건 충족 2\/2종/);
assert.equal((html.match(/<th>[월화수목금토일]<\/th>/g) ?? []).length, 7, '7개 요일을 모두 표시');
assert.match(render('소울 결정'), /조건 충족 1\/1종/);
assert.match(render('카드', '딜러', 'askMax'), /카드 맥스업 호가/);
assert.match(render('카드', '버퍼'), /0\/0종/, '역할 필터 반영');
const pending = render('소울 결정', '전체', 'trade', { ...data, weekdayTrends: { items: [
  { item_id: 'cheap', basis: 'trade', ...weekdayTrend(history(1, 1), before) },
] } });
assert.match(pending, /표본 수집 중/);
assert.doesNotMatch(pending, /<svg|NaN|undefined/, '1주 관측으로 요일 그래프를 확정하지 않음');
assert.match(pending, /<b>1<\/b>/, '표본 부족이어도 요일별 유효 관측 수 공개');
console.log('7요일 정규화·전날 결측·동일 종목 비중·품목 및 역할 필터·표본 대기 테스트 통과');
