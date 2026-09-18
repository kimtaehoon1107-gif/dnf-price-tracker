import assert from 'node:assert/strict';
import { PACKAGE, PARTS, MELODY, initialPackageState, packagePrices, premiumCoins, calculatePackage } from '../web/package-calc.js';
import { packagePanelHTML } from '../web/package.js';

const prices = { package: 30e6, avatar: 9e6, creature: 8e6, aura: 6e6, title: 6e6, sera: 4e6, melody: 4e6 };
const run = (change = {}, p = prices) => calculatePackage({ ...initialPackageState(), ...change }, p);
assert.deepEqual(Array.from({ length: 13 }, (_, n) => premiumCoins(n)), [0, 0, 1, 3, 5, 7, 9, 11, 14, 17, 20, 21, 22]);
const ten = run();
assert.deepEqual(ten.errors, []);
assert.equal(ten.seraCost, 392000);
assert.equal(ten.addedCoins, 20);
assert.equal(ten.after.cards, 10);
assert.equal(ten.rewards.length, 10, '첫 구매 변경권도 한 번 포함');
assert.equal(ten.salesNet, 291e6);
assert.equal(ten.coinNet, 38.8e6);
assert.equal(ten.recovered, 329.8e6);
assert.equal(ten.costGold, null, '세라·골드를 환산 없이 빼지 않음');
assert.equal(ten.personal, 0, '귀속 보상 시세를 판매액·개인 가치에 자동 합산하지 않음');
assert.equal(run({ rate: 800000 }).burden, -16.2e6);

const sevenToNine = run({ previous: 7, additional: 2 });
assert.deepEqual(sevenToNine.rewards.map((r) => r.at), [8, 9]);
assert.equal(sevenToNine.addedCoins, 6);
assert.equal(sevenToNine.seraCost, 78400);
assert.equal(run({ previous: 10, additional: 2 }).addedCoins, 2);
assert.equal(run({ previous: 10, additional: 2 }).rewards.length, 0);
assert.equal(run({ ownedCoins: 20 }).deltaCards, 10, '기존 코인으로도 얻는 카드 10개는 추가 회수액에 중복 반영하지 않음');
assert.equal(run({ ownedCoins: 4, cardsUsed: 48 }).deltaCards, 0, '남은 교환 한도는 기존 보유분에서도 동일하게 반영');
assert.equal(run({ previous: 1, additional: 1, ownedCoins: 1 }).deltaCards, 1, '1코인 잔여분과 새 1코인이 만나 실제 카드 1개 교환');
assert.equal(run({ previous: 1, additional: 1 }).after.cards, 0, '코인 반 개분의 카드를 팔았다고 계산하지 않음');
assert.equal(run({ previous: 1, additional: 1 }).after.left, 1);
const aura = run({ previous: 1, additional: 1, ownedCoins: 7, auraCount: 1, auraValue: 50e6 });
assert.equal(aura.deltaAuras, 1);
assert.equal(aura.deltaCards, -3, '오라 선택으로 포기하는 기존 카드 교환도 차이로 표시');
assert.equal(aura.coinNet, -11.64e6);
assert.equal(aura.personal, 50e6);
assert(run({ auraCount: 3 }).errors.some((s) => s.includes('코인이 부족')));
assert(run({ aurasUsed: 5, auraCount: 1 }).errors.length);
assert.equal(run({ exchangeCards: false }).coinNet, 0);
assert.equal(run({ exchangeCards: false }).after.left, 20);

assert.equal(run({ mode: 'parts' }).salesNet, 320.1e6, '패키지 가격은 구성품 판매에 더하지 않음');
assert.equal(run({ mode: 'parts', keep: { avatar: 10 } }).salesNet, 232.8e6);
assert.equal(run({ mode: 'keep' }).salesNet, 0);
assert.equal(run({ mode: 'keep', exchangeCards: false }).recovered, 0);
assert.equal(run({ prices: { package: 20e6 } }).salesNet, 194e6);
assert.equal(run({ prices: { package: '' } }).salesNet, ten.salesNet, '비우면 자동 VWAP 복원');
assert.equal(run({}, { ...prices, package: null }).recovered, null, '판매 단가 누락을 0으로 채우지 않음');
assert.equal(run({ keep: { package: 10 } }, { ...prices, package: null }).salesNet, 0, '팔지 않는 물건의 가격 누락은 판매 합계를 막지 않음');
assert.equal(run({ mode: 'parts' }, { ...prices, aura: null }).recovered, null);
assert.equal(run({}, { ...prices, melody: null }).recovered, null);
assert.equal(run({ additional: 0 }).recovered, 0);
assert.equal(run({ additional: 0 }).rewards.length, 0);
assert.equal(run({ additional: 0, ownedCoins: 20 }).coinNet, 0);

assert.equal(run({ values: { 1: 20e6 }, firstCost: 10e6 }).personal, 10e6, '변경 후 완성품 가치에서 투입 크리쳐 비용 차감');
assert(run({ values: { 1: 20e6 } }).errors.some((s) => s.includes('크리쳐·재료 비용')));
assert.equal(run({ previous: 7, additional: 2, values: { 1: 20e6, 9: 30e6 } }).personal, 30e6);
assert.equal(run({ values: { 9: 30e6 } }).recovered, ten.recovered, '개인 평가는 판매 회수액에 섞지 않음');
for (const change of [{ previous: -1 }, { additional: 1.5 }, { additional: '' }, { fee: 101 }, { rate: 0 },
  { prices: { package: Infinity } }, { keep: { package: 11 } }, { previous: 1000, additional: 1 }]) {
  assert(run(change).errors.length, `잘못된 입력을 거부: ${JSON.stringify(change)}`);
}

const data = { priceAsOf: '2026-09-18T00:00:00Z', items: [
  { item_id: PACKAGE.id, vwap24: prices.package }, { item_id: MELODY, vwap24: prices.melody },
  ...PARTS.map(([key, , id]) => ({ item_id: id, vwap24: prices[key] })),
] };
assert.deepEqual(packagePrices(data), prices);
assert.equal(packagePrices({ items: [{ item_id: PACKAGE.id, vwap24: 0 }] }).package, null);
const html = packagePanelHTML(data, initialPackageState());
assert.match(html, /주또주 가치 계산기/);
assert.match(html, /329,800,000 골드/);
assert.match(html, /현재 코인만 사용/);
assert.match(html, /골드 환산 기준 미입력/);
assert.doesNotMatch(html, /NaN|undefined|Infinity/);
const errorHtml = packagePanelHTML(data, { ...initialPackageState(), additional: '' });
assert.match(errorHtml, /role="alert"/);
assert.doesNotMatch(errorHtml, /추가 판매 회수액/);
console.log('패키지 회차·코인 한도/기존 잔액·판매 중복·귀속 가치·결측·입력 검증 테스트 통과');
