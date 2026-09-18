// 공식 보상 확인: 2026-09-18, https://df.nexon.com/pg/forestbandpkg
// 세라샵 구매 보상과 경매장 구성품을 중복 합산하지 않는다.
export const PACKAGE = {
  id: 'e974d2eac46f0c8b23b83d4da389fa57', sera: 39200,
  ends: '2026-11-05T06:00:00+09:00',
  source: 'https://df.nexon.com/community/news/seriashop/656',
};
export const PARTS = [
  ['avatar', '아바타 풀세트 상자', '702d33e99edb55d23cac4c9970ef44ee'],
  ['creature', '크리쳐 상자', 'a295bdbb26984dcb946eb3a3044dcfe5'],
  ['aura', '오라 상자', '33776306aa3fa6fead55ced8656be444'],
  ['title', '칭호 상자', '329338e9ac307d34de71a48b314b19a0'],
  ['sera', '세라 상자', 'b971992f2529a494215fdf9368cfa0dd'],
];
export const REWARDS = [
  { at: 1, name: '플로럴 스태그 크리쳐 확정 변경권', note: '첫 구매 1회 · 부화된 대상 크리쳐 필요, 알에는 사용 불가' },
  { at: 2, name: '찬란한 엠블렘 2개 선택 상자', note: '교환불가 아바타에만 장착 가능 · 두 개 합계 가치 입력' },
  { at: 3, name: '유랑악단 무기 아바타 상자' },
  { at: 4, name: '유랑악단 아바타 풀세트 상자 [E/F타입]' },
  { at: 5, name: '유랑악단 오라 상자', ref: PARTS[2][2] },
  { at: 6, name: '유랑악단 데미지 폰트 선택 상자' },
  { at: 7, name: '애니멀라이즈 언더웨어 아바타 세트 상자', ref: '0cd787ff2e3c980e2e1de4705797fffd' },
  { at: 8, name: '교환불가 레어 무기 클론 아바타 선택 상자', ref: '60b509f594b058a1cc9cd1eff016713f' },
  { at: 9, name: '종이달 오르골 칭호 선택 상자', ref: '41914178e78f02589b8e2760788a9da8' },
  { at: 10, name: '실반 소네트 페어리 크리쳐 선택 상자' },
];
export const MELODY = 'b62cd7a12de35f28cc1332b1ef609eb8';
export const PREMIUM_AURA = 'ae1b370972f85389d77eee716ae9f6e2';

export function initialPackageState() {
  return { previous: 0, additional: 10, sera: PACKAGE.sera, fee: 3, rate: '', mode: 'package',
    ownedCoins: 0, cardsUsed: 0, aurasUsed: 0, auraCount: 0, exchangeCards: true,
    prices: {}, keep: {}, values: {}, firstCost: '', auraValue: '' };
}

export function packagePrices(data) {
  const price = (id) => {
    const value = data.items?.find((i) => i.item_id === id)?.vwap24;
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return Object.fromEntries([['package', PACKAGE.id], ...PARTS.map(([k, , id]) => [k, id]), ['melody', MELODY]]
    .map(([key, id]) => [key, price(id)]));
}

export function premiumCoins(count) {
  return [0, 0, 1, 3, 5, 7, 9, 11, 14, 17, 20][Math.min(count, 10)] + Math.max(0, count - 10);
}

export function calculatePackage(state, observed) {
  const errors = [];
  const number = (v, name, max = 1e12, integer = false) => {
    const n = v === '' || v == null ? NaN : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isInteger(n))) {
      errors.push(`${name}: 0~${max.toLocaleString('ko-KR')}${integer ? '의 정수' : ''}를 입력하세요.`);
      return 0;
    }
    return n;
  };
  const previous = number(state.previous, '기존 구매', 1000, true);
  const additional = number(state.additional, '추가 구매', 1000 - previous, true);
  const sera = number(state.sera, '개당 구매 비용');
  const fee = number(state.fee, '판매 수수료', 100) / 100;
  const owned = number(state.ownedCoins, '보유 코인', 10000, true);
  const cardsUsed = number(state.cardsUsed, '멜로디 카드 교환 사용량', 50, true);
  const aurasUsed = number(state.aurasUsed, '열대야 오라 교환 사용량', 5, true);
  const auraCount = number(state.auraCount, '오라 교환', 5 - aurasUsed, true);
  const rate = state.rate === '' ? null : number(state.rate, '1,000세라당 골드');
  if (rate === 0) errors.push('환산 기준은 0보다 크게 입력하거나 비워 두세요.');
  if (!['package', 'parts', 'keep'].includes(state.mode)) errors.push('판매 방식을 선택하세요.');
  const addedCoins = premiumCoins(previous + additional) - premiumCoins(previous);
  const balance = owned + addedCoins;
  if (auraCount * 8 > balance) errors.push('오라 교환에 필요한 코인이 부족합니다.');
  // 기존 보유분으로도 가능한 교환을 먼저 빼야 과거 자산이 새 구매의 이익이 되지 않는다.
  const exchange = (coins) => {
    const auras = Math.min(auraCount, Math.floor(coins / 8));
    const cards = state.exchangeCards ? Math.min(50 - cardsUsed, Math.floor((coins - auras * 8) / 2)) : 0;
    return { auras, cards, left: coins - auras * 8 - cards * 2 };
  };
  const before = exchange(owned), after = exchange(balance);
  const deltaCards = after.cards - before.cards, deltaAuras = after.auras - before.auras;
  const price = (key) => {
    const custom = state.prices[key];
    if (custom !== undefined && custom !== '') return number(custom, '직접 입력 단가');
    return Number.isFinite(observed[key]) && observed[key] > 0 ? observed[key] : null;
  };
  const keys = state.mode === 'package' ? [['package', '패키지 그대로']]
    : state.mode === 'parts' ? PARTS : [];
  const sales = keys.map(([key, name]) => {
    const keep = number(state.keep[key] ?? 0, `${name} 보관 수량`, additional, true);
    const qty = additional - keep, unit = price(key);
    return { key, name, qty, unit, net: qty === 0 ? 0 : unit === null ? null : qty * unit * (1 - fee) };
  });
  const melodyPrice = price('melody');
  const coinNet = deltaCards === 0 ? 0 : melodyPrice === null ? null : deltaCards * melodyPrice * (1 - fee);
  const missing = sales.filter((s) => s.net === null).map((s) => s.name);
  if (coinNet === null) missing.push('실반 멜로디 카드');
  const salesNet = sales.every((s) => s.net !== null) ? sales.reduce((n, s) => n + s.net, 0) : null;
  const recovered = missing.length ? null : salesNet + coinNet;
  const rewards = REWARDS.filter((r) => r.at > previous && r.at <= previous + additional);
  let personal = 0, valued = 0;
  for (const r of rewards) {
    const value = state.values[r.at];
    if (value === '' || value === undefined) continue;
    let net = number(value, `${r.name} 사용 가치`);
    if (r.at === 1) net -= number(state.firstCost, '변경권 사용에 필요한 크리쳐·재료 비용');
    personal += net;
    valued++;
  }
  if (deltaAuras > 0 && state.auraValue !== '') {
    personal += deltaAuras * number(state.auraValue, '오라 1개 사용 가치');
    valued++;
  }
  const seraCost = additional * sera;
  const costGold = rate === null ? null : seraCost / 1000 * rate;
  return { errors, previous, additional, seraCost, costGold, addedCoins, before, after, deltaCards, deltaAuras,
    sales, salesNet, coinNet, recovered, missing, rewards, personal, valued,
    burden: costGold !== null && recovered !== null ? costGold - recovered : null };
}
