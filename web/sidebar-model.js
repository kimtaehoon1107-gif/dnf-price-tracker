export function rankedItems(items, direction) {
  return items.filter(i => i.price_basis === 'trade' && Number.isFinite(i.vwap24) && i.vwap24 > 0 && Number.isFinite(i.vwap_prev) && i.vwap_prev > 0 && i.api_qty24 >= 100)
    .map(i => ({ ...i, change: (i.vwap24 / i.vwap_prev - 1) * 100 }))
    .filter(i => direction === 'up' ? i.change > 0 : i.change < 0)
    .sort((a,b) => (direction === 'up' ? b.change-a.change : a.change-b.change) || a.item_id.localeCompare(b.item_id)).slice(0,10);
}
export function calendarCells(year, month) {
  return [...Array(new Date(Date.UTC(year,month,1)).getUTCDay()).fill(null), ...Array.from({ length: new Date(Date.UTC(year,month+1,0)).getUTCDate() }, (_, i) => i+1)];
}
