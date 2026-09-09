/** 최근 체결은 보조 정보로 남기고, 1시간 내 체결이 없으면 평균을 대체하지 않는다. */
export const representativePrice = (item) => item.price_basis === 'trade'
  ? item.vwap1h ?? null : item.last_price;

/** 현재 최저 호가가 최근 24시간 체결 VWAP보다 얼마나 위·아래인지 계산한다. */
export const askGap = (item) => item.price_basis === 'trade'
  && item.min_ask > 0
  && item.vwap24 > 0
  ? (item.min_ask / item.vwap24 - 1) * 100
  : null;
