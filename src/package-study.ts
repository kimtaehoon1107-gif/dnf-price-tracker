// 판매 종료 사건의 사전 고정 계산. DB·현재 시각에 의존하지 않는 순수 함수.
export type Member = { id: string; name: string; group: 'treatment' | 'control' | 'spillover'; expiresAt: string | null };
export type Day = { d: string; vwap: number; n: number };
export type Input = { asOf: string; members: Member[]; series: Record<string, Day[]> };
export const VERSION = '2026-09-28-v2';
export const WINDOWS = {
  baseline: ['2026-09-10', '2026-10-21'], anticipation: ['2026-10-22', '2026-11-04'],
  before: ['2026-10-29', '2026-11-04'], event: ['2026-11-05', '2026-11-11'],
  post: ['2026-11-12', '2026-12-02'],
} as const;
type Window = readonly [string, string];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const addDay = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export function dates([a, b]: Window): string[] {
  const out: string[] = [];
  for (let d = a; d <= b; d = addDay(d, 1)) out.push(d);
  return out;
}
const pct = (delta: number) => Math.expm1(delta) * 100;
export function study(input: Input, minimumTrades = 5) {
  if (!Number.isFinite(Date.parse(input.asOf))) throw new Error('자료 기준 시각 필요');
  const today = new Date(Date.parse(input.asOf) + 9 * 3600000).toISOString().slice(0, 10);
  const through = addDay(today, -1);
  const ids = (group: Member['group']) => input.members.filter(m => m.group === group).map(m => m.id);
  if (new Set(input.members.map(m => m.id)).size !== 21 || ids('treatment').length !== 6 || ids('control').length !== 8 || ids('spillover').length !== 7) throw new Error('고정 21종 구성 불일치');
  const maps = new Map<string, Map<string, Day>>();
  for (const m of input.members) {
    if (m.group === 'treatment' && m.expiresAt !== '2026-11-05T06:00:00+09:00') throw new Error('처치군 삭제 시각 불일치');
    const rows = input.series[m.id];
    if (!Array.isArray(rows)) throw new Error(`시계열 누락: ${m.id}`);
    const map = new Map<string, Day>();
    for (const r of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.d) || addDay(r.d, 0) !== r.d || map.has(r.d) || !Number.isFinite(r.vwap) || r.vwap <= 0 || !Number.isInteger(r.n) || r.n < 0) throw new Error(`잘못된 일봉: ${m.id} ${r.d}`);
      map.set(r.d, r);
    }
    maps.set(m.id, map);
  }
  const price = (id: string, d: string): number | null => {
    const r = maps.get(id)!.get(d);
    const expires = input.members.find(m => m.id === id)!.expiresAt;
    if (expires && d >= expires.slice(0, 10)) return null; // 삭제 당일의 혼합 일봉도 제외
    return d <= through && r && r.n >= minimumTrades ? r.vwap : null;
  };
  const groupLog = (members: string[], d: string): number | null => {
    const p = members.map(id => price(id, d));
    return p.some(v => v === null) ? null : mean((p as number[]).map(Math.log));
  };
  const excess = (members: string[], controls: string[], d: string): number | null => {
    const t = groupLog(members, d), c = groupLog(controls, d);
    return t === null || c === null ? null : t - c;
  };
  const sample = (w: Window, fn: (d: string) => number | null) => {
    const ds = dates(w), observed = ds.map(d => ({ d, value: fn(d) })).filter(r => r.value !== null) as { d: string; value: number }[];
    return { expected: ds.length, required: Math.ceil(ds.length * .8), valid: observed.length, observed };
  };
  const contrast = (members: string[], controls: string[], before: Window, after: Window) => {
    const fn = (d: string) => excess(members, controls, d);
    const pre = sample(before, fn), post = sample(after, fn);
    const status = through < after[1] ? 'pending' : pre.valid < pre.required || post.valid < post.required ? 'insufficient' : 'ready';
    const logEffect = status === 'ready' ? mean(post.observed.map(r => r.value)) - mean(pre.observed.map(r => r.value)) : null;
    return { status, pre, post, logEffect, relativePercent: logEffect === null ? null : pct(logEffect) };
  };
  const treatment = ids('treatment'), control = ids('control'), spillover = ids('spillover');
  const auditDates = dates([WINDOWS.baseline[0], through < WINDOWS.baseline[1] ? through : WINDOWS.baseline[1]]);
  const audit = input.members.map(m => {
    const rows = [...maps.get(m.id)!.values()].filter(r => r.d <= through).sort((a, b) => a.d.localeCompare(b.d));
    return { ...m, firstTradeDay: rows[0]?.d ?? null, lastTradeDay: rows.at(-1)?.d ?? null,
      expected: auditDates.length, valid: auditDates.filter(d => price(m.id, d) !== null).length,
      noDailyRow: auditDates.filter(d => !maps.get(m.id)!.has(d)),
      thinDays: auditDates.filter(d => maps.get(m.id)!.has(d) && maps.get(m.id)!.get(d)!.n < minimumTrades),
      postExpiryRows: m.expiresAt ? rows.filter(r => r.d >= m.expiresAt!.slice(0, 10)).map(r => r.d) : [] };
  });
  const groupCoverage = Object.fromEntries(['treatment', 'control', 'spillover'].map(g => [g, auditDates.filter(d => groupLog(ids(g as Member['group']), d) !== null).length]));
  const unavailable = (reason: string) => ({ status: 'not_applicable', reason, relativePercent: null });
  const h1 = unavailable('패키지·구성 상자 6종이 사건 시각에 삭제되어 사후 가격이 정의되지 않음');
  const h2 = contrast(treatment, control, WINDOWS.baseline, WINDOWS.anticipation);
  const h3 = unavailable('삭제 전후 7일 가격 비교 불가. 삭제 당일 혼합 일봉도 사용하지 않음');
  const h5 = unavailable('원래 파급군에 동일 시각 삭제되는 선택 상자가 포함됨. 생존 품목만의 사후 분석은 별도 설계 필요');
  // 매일 같은 6종의 가격이 있을 때만 마진 계산. 첫 구성원은 패키지.
  const marginSample = sample(WINDOWS.anticipation, d => {
    const p = treatment.map(id => price(id, d));
    return p.some(v => v === null) ? null : ((p.slice(1) as number[]).reduce((a, b) => a + b, 0) * .97 / p[0]! - 1) * 100;
  });
  const marginStatus = through < WINDOWS.anticipation[1] ? 'pending' : marginSample.valid < marginSample.required ? 'insufficient' : 'ready';
  const ms = marginSample.observed.map(r => r.value);
  const preExpiryMargin = { status: marginStatus, sample: marginSample, meanPercent: marginStatus === 'ready' ? mean(ms) : null,
    minPercent: marginStatus === 'ready' ? Math.min(...ms) : null, maxPercent: marginStatus === 'ready' ? Math.max(...ms) : null,
    outside3PercentShare: marginStatus === 'ready' ? ms.filter(v => Math.abs(v) > 3).length / ms.length : null };
  const placebos = dates(['2026-09-17', '2026-10-15']).map(d => ({ d,
    ...contrast(treatment, control, [addDay(d, -7), addDay(d, -1)], [d, addDay(d, 6)]) }));
  const h4 = unavailable('패키지와 구성품이 삭제되어 사후 해체 마진이 정의되지 않음');
  const usable = placebos.filter(p => p.logEffect !== null);
  const thursdays = usable.filter(p => new Date(p.d + 'T00:00:00Z').getUTCDay() === 4);
  const timePlacebo = { candidates: 29, thursdayCandidates: 5, usable: usable.length, usableThursdays: thursdays.length,
    interpretation: '사건 전 7일 대 7일 변동의 기술 통계. 삭제 후 실제 사건값과 순위를 계산하지 않음', values: placebos };
  const spacePlacebo = control.map(id => ({ id, ...contrast([id], control.filter(c => c !== id), WINDOWS.baseline, WINDOWS.anticipation) }));
  const baseline = auditDates.map(d => ({ d, value: excess(treatment, control, d) })).filter(r => r.value !== null) as { d: string; value: number }[];
  const differences = baseline.slice(1).flatMap((r, i) => addDay(baseline[i].d, 1) === r.d ? [r.value - baseline[i].value] : []);
  const sigma = differences.length >= 20 ? Math.sqrt(differences.reduce((s, x) => s + (x - mean(differences)) ** 2, 0) / (differences.length - 1)) : null;
  const sensitivity = (before: Window, after: Window, z: number) => {
    if (through < WINDOWS.baseline[1] || sigma === null) return null;
    // 독립적인 일별 혁신의 랜덤워크에서 두 기간 평균 차이의 정확한 분산 계수.
    const pre = dates(before), post = dates(after), all = dates([before[0], after[1]]);
    const weights = all.map(d => (post.includes(d) ? 1 / post.length : 0) - (pre.includes(d) ? 1 / pre.length : 0));
    const factor = Math.sqrt(weights.slice(1).reduce((sum, _, i) => sum + weights.slice(i + 1).reduce((a, b) => a + b, 0) ** 2, 0));
    const logEffect = (z + .841621) * sigma * factor;
    return { logEffect, relativePercent: pct(logEffect), sigma, consecutiveDifferences: differences.length, varianceFactor: factor };
  };
  const diagnostic = (members: string[]) => {
    const ds = auditDates.flatMap(d => { const t = groupLog(members, d), c = groupLog(control, d); return t === null || c === null ? [] : [{ d, t, c, a: t - c }]; });
    if (ds.length < 7) return { valid: ds.length, excessLogSlopePerDay: null, dailyChangeCorrelation: null };
    const xs = ds.map(r => (Date.parse(r.d) - Date.parse(ds[0].d)) / 86400000), ys = ds.map(r => r.a);
    const cov = (a: number[], b: number[]) => a.reduce((s, v, i) => s + (v - mean(a)) * (b[i] - mean(b)), 0);
    const changes = ds.slice(1).flatMap((r, i) => addDay(ds[i].d, 1) === r.d ? [{ t: r.t - ds[i].t, c: r.c - ds[i].c }] : []);
    const ts = changes.map(r => r.t), cs = changes.map(r => r.c);
    const den = Math.sqrt(cov(ts, ts) * cov(cs, cs));
    return { valid: ds.length, excessLogSlopePerDay: cov(xs, ys) / cov(xs, xs), dailyChangeCorrelation: changes.length >= 3 && den > 0 ? cov(ts, cs) / den : null };
  };
  return { version: VERSION, asOf: input.asOf, through, minimumTrades, windows: WINDOWS, audit, groupCoverage,
    diagnostics: { treatment: diagnostic(treatment), spillover: diagnostic(spillover) },
    results: { h1, h2, h3, h4, h5 }, preExpiryMargin, timePlacebo, spacePlacebo,
    sensitivity: { interpretation: '독립 일별 랜덤워크 가정의 참고값. 실제 판정의 검정력·인과 효과 탐지 한계가 아님.',
      h2: sensitivity(WINDOWS.baseline, WINDOWS.anticipation, 1.959964) },
    robustness: { leaveOneAmpOut: control.slice(0, 4).map(id => ({ omitted: id, ...contrast(treatment, control.filter(c => c !== id), WINDOWS.baseline, WINDOWS.anticipation) })) },
  };
}
