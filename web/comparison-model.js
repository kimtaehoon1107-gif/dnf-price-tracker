import { distributionRows } from './price-distribution.js?v=20261008-cleaned';

// 맥스업 자료가 없으면 0업 자료로 대체하지 않는다.
export function comparisonSource(item, series, stage, asOf) {
  return item.price_basis === 'ask0'
    ? { basis: 'ask', asOf, daily: (stage === 'max' ? series.max?.daily : series.daily) ?? [] }
    : series.distribution;
}

export function comparisonData(sources, period = 30) {
  const times = sources.map(s => Date.parse(s?.asOf));
  if (sources.length !== 2 || times.some(t => !Number.isFinite(t))) return { rows: [], from: null, to: null };
  const asOf = new Date(Math.min(...times)).toISOString();
  // 기간은 완료일 기준이다. 오늘의 미완성 값은 어느 쪽에도 포함하지 않는다.
  const series = sources.map(s => distributionRows({ ...s, asOf }, period === 'all' ? 'all' : period + 1).filter(r => !r.partial));
  if (series.some(rows => !rows.length)) return { rows: [], from: null, to: null };
  const fromTime = Math.max(...series.map(rows => rows[0].time));
  const maps = series.map(rows => new Map(rows.map(r => [r.time, r])));
  const rows = series[0].filter(r => r.time >= fromTime).map(r => ({ d: r.d, time: r.time,
    values: maps.map(m => { const value = m.get(r.time); return value?.state === 'ready' && value.median > 0 ? value.median : null; }) }));
  const common = rows.filter(r => r.values.every(v => v !== null));
  const from = common[0] ?? null, to = common.length > 1 ? common.at(-1) : null;
  return { rows, from, to };
}
