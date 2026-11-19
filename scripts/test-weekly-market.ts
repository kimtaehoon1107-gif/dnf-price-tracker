import assert from 'node:assert/strict';
import { buildWeeklyMarket } from '../web/weekly-market.ts';

const items = ['weighted', 'down', 'sparse'].map((id) => ({ item_id: id, item_name: id, category: '재료' }));
const days = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const prices = days.map((day) => ({
  d: `2026-11-${String(day).padStart(2, '0')}`,
  vwap: day === 9 ? 200 : day === 16 ? 1_000_000 : 100,
  qty: day === 9 ? 8 : 1,
}));
const dailyBy = new Map([
  ['weighted', prices],
  ['down', prices.map((day) => ({ ...day, qty: 1, vwap: day.d >= '2026-11-09' ? 90 : 100 }))],
  ['sparse', prices.filter((day) => day.d < '2026-11-13')],
]);
const beforeMonday = buildWeeklyMarket('2026-11-15T14:59:59Z', items, dailyBy);
assert.deepEqual(beforeMonday.latestWeek, { start: '2026-11-02', end: '2026-11-08' });
assert.equal(beforeMonday.medianChangePct, null);

const report = buildWeeklyMarket('2026-11-15T15:00:00Z', items, dailyBy);
assert.deepEqual(report.latestWeek, { start: '2026-11-09', end: '2026-11-15' });
assert.deepEqual(report.previousWeek, { start: '2026-11-02', end: '2026-11-08' });
assert.equal(report.totalItems, 3);
assert.deepEqual(report.comparisons.map(({ id, changePct }) => [id, changePct]), [['weighted', 57.1], ['down', -10]]);
assert.deepEqual(report.comparisons[0].latest, { days: 7, qty: 14, price: 2200 / 14 });
assert.equal(report.medianChangePct, 23.55);
