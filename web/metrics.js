/** 최근 체결은 보조 정보로 남기고, 1시간 내 체결이 없으면 평균을 대체하지 않는다.
 *  카드는 열린 매물이 없으면 빌드가 최저호가를 0으로 채우므로 가격이 없는 것으로 본다. */
export const representativePrice = (item) => item.price_basis === 'trade'
  ? item.vwap1h ?? null : item.last_price > 0 ? item.last_price : null;

/** 현재 최저 호가가 최근 24시간 체결 VWAP보다 얼마나 위·아래인지 계산한다. */
export const askGap = (item) => item.price_basis === 'trade'
  && item.min_ask > 0
  && item.vwap24 > 0
  ? (item.min_ask / item.vwap24 - 1) * 100
  : null;

/** 24시간 평균가가 체결이 있었던 최근 완료일의 VWAP 사이에서 어디쯤인지 계산한다.
 *  같은 "하루 평균" 단위끼리 비교한다. 위치일 뿐이며 앞으로 오르거나 내린다는 뜻은 아니다.
 *  관측일 기준이라 중간에 공백이 있으면 달력상 기간이 길어지므로 실제 비교 기간을 함께 돌려준다. */
export function pricePosition(days, price, today, window = 30, min = 14) {
  const complete = days.filter((x) => x.d < today && x.vwap > 0).slice(-window);
  if (!(price > 0) || complete.length < min) return { ready: false, days: complete.length, min };
  const below = complete.filter((x) => x.vwap < price).length;
  const same = complete.filter((x) => x.vwap === price).length;
  const prices = complete.map((x) => x.vwap);
  return { ready: true, days: complete.length, percentile: (below + same / 2) / complete.length * 100,
    low: Math.min(...prices), high: Math.max(...prices), from: complete[0].d, to: complete.at(-1).d };
}

/** 종이달 상자의 기존 칭호 분류·이력은 유지하고 실반 탭에서도 같은 행을 보여준다. */
export const matchesCategory = (item, category) => category === '전체' || item.category === category
  || (category === '실반 하모니 박스' && item.item_id === '41914178e78f02589b8e2760788a9da8');

/** 종목별 요일 평균에 같은 비중을 준다. 관측 주가 긴 종목의 영향이 커지지 않게 한다. */
export function summarizeWeekdays(profiles, ids, basis) {
  const selected = profiles.filter((p) => ids.includes(p.item_id) && p.basis === basis);
  const ready = selected.filter((p) => p.ready);
  const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return { basis, candidates: selected.length, eligibleItems: ready.length,
    observedItems: selected.filter((p) => p.days > 0).length,
    maxWeeks: Math.max(0, ...selected.map((p) => p.weeks)),
    from: ready.map((p) => p.from).sort()[0] ?? null,
    to: ready.map((p) => p.to).sort().at(-1) ?? null,
    points: ['월', '화', '수', '목', '금', '토', '일'].map((label, k) => {
      const points = ready.map((p) => p.points[k]);
      const changes = points.filter((p) => p.change !== null);
      return { k: k + 1, label, price: mean(points.map((p) => p.price)),
        change: mean(changes.map((p) => p.change)),
        n: points.reduce((s, p) => s + p.n, 0),
        changeN: changes.reduce((s, p) => s + p.changeN, 0), changeItems: changes.length,
        availableN: selected.reduce((s, p) => s + p.counts[k], 0) };
    }) };
}
