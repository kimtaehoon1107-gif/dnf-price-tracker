/** 현재 최저 호가가 최근 24시간 체결 VWAP보다 얼마나 위·아래인지 계산한다. */
export const askGap = (item) => item.price_basis === 'trade'
  && item.min_ask > 0
  && item.vwap24 > 0
  ? (item.min_ask / item.vwap24 - 1) * 100
  : null;
