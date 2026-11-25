type TradeItem = { item_id: string; item_name: string; category: string };
type TradeDay = { d: string; vwap: number; qty: number };
type Week = { start: string; end: string };
const DAY = 86_400_000;
const MIN_DAYS = 5;

function summarizeWeek(days: readonly TradeDay[], week: Week) {
  const observed = days.filter(({ d, vwap, qty }) =>
    d >= week.start && d <= week.end && vwap > 0 && qty > 0);
  if (observed.length < MIN_DAYS) return null;
  const qty = observed.reduce((sum, day) => sum + day.qty, 0);
  const gold = observed.reduce((sum, day) => sum + day.vwap * day.qty, 0);
  return { days: observed.length, qty, price: gold / qty };
}

export function buildWeeklyMarket(
  dataThrough: string,
  items: readonly TradeItem[],
  dailyBy: ReadonlyMap<string, readonly TradeDay[]>,
  weeksBack = 0,
) {
  // Represent KST calendar dates at UTC midnight for date arithmetic only.
  const dayKst = new Date(dataThrough).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const date = new Date(`${dayKst}T00:00:00Z`);
  const monday = +date - (((date.getUTCDay() + 6) % 7) + 7 * weeksBack) * DAY;
  const dateAt = (days: number) => new Date(monday + days * DAY).toISOString().slice(0, 10);
  const previousWeek = { start: dateAt(-14), end: dateAt(-8) };
  const latestWeek = { start: dateAt(-7), end: dateAt(-1) };

  const observed = items.filter(({ item_id }) => dailyBy.get(item_id)?.some(({ d, vwap, qty }) =>
    d >= previousWeek.start && d <= latestWeek.end && vwap > 0 && qty > 0));
  const comparisons = observed.flatMap(({ item_id, item_name, category }) => {
    const days = dailyBy.get(item_id) ?? [];
    const previous = summarizeWeek(days, previousWeek);
    const latest = summarizeWeek(days, latestWeek);
    if (!previous || !latest) return [];
    const change = (latest.price / previous.price - 1) * 100;
    const changePct = Number(change.toFixed(1));
    return [{ id: item_id, name: item_name, category, previous, latest, changePct }];
  }).sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  const changes = comparisons.map((row) => row.changePct).sort((a, b) => a - b);
  const middle = Math.floor(changes.length / 2);
  const medianChangePct = changes.length === 0 ? null
    : changes.length % 2 === 1 ? changes[middle]
    : (changes[middle - 1] + changes[middle]) / 2;

  return {
    dataThrough, previousWeek, latestWeek, minDays: MIN_DAYS, totalItems: items.length, observedItems: observed.length,
    medianChangePct, comparisons,
  };
}

export function buildWeeklyHistory(
  latest: ReturnType<typeof buildWeeklyMarket>,
  items: readonly TradeItem[],
  dailyBy: ReadonlyMap<string, readonly TradeDay[]>,
) {
  const offset = (date: string, days: number) => new Date(Date.parse(date) - days * DAY).toISOString();
  const past = [1, 2, 3].map((weeksBack) => buildWeeklyMarket(latest.dataThrough, items, dailyBy, weeksBack));
  // Four completed weeks for each issue, with no observations from later weeks.
  const weeks = Array.from({ length: 7 }, (_, i) => {
    const week = {
      start: offset(latest.latestWeek.start, i * 7).slice(0, 10),
      end: offset(latest.latestWeek.end, i * 7).slice(0, 10),
    };
    const prices = Object.fromEntries(items.flatMap(({ item_id }) => {
      const price = summarizeWeek(dailyBy.get(item_id) ?? [], week);
      return price ? [[item_id, price]] : [];
    }));
    return { ...week, prices };
  });
  return { dataThrough: latest.dataThrough, past, weeks };
}
