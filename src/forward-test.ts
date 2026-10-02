// 전향 검증 FT1의 규칙 구현. 사양은 docs/forward-test-protocol-2026-10-02.md에 고정했다.
// 규칙을 바꾸려면 FT_VERSION을 올려 새 실험으로 시작한다. 이미 발행·확정한 값은 다시 쓰지 않는다.
import { createHash } from 'node:crypto';
import { H, D, avg, type Series } from './activity-study.ts';
import { blockDirectionStudy } from './block-direction-study.ts';
import { direction } from './intraday-joint-forecast.ts';
import { shiftDay } from './research.ts';

export const FT_VERSION = '2026-10-02-ft1';
/** 2026-10-03 06:00 KST. 이보다 이른 구간·주는 표본에 넣지 않는다. */
export const FT_START = Date.parse('2026-10-02T21:00:00Z');
/** 후향 연구와 같은 ±0.5% 보합 범위. 결과를 보고 바꾸지 않는다. */
export const THRESHOLD = 0.5;
export const BLOCK = 6 * H;
/** 구간 시작 뒤 1시간 안에만 발행한다. 첫 시간봉이 끝나기 전의 입력만 쓰는 사전 발행임을 보장한다. */
export const BLOCK_ISSUE_WINDOW = H;
/** 대상이 끝난 뒤 24시간 기다린 첫 정상 집계에서 실측을 고정한다. */
export const SETTLE_WAIT = D;
/** 두 날에 모두 관측된 시간 칸이 이 수 이상일 때만 주간 비교를 채점한다. */
export const COMMON_SLOTS_MIN = 16;
export const ALPHA = 0.05;
/** 1차 가설 4개에 Bonferroni를 적용한다. */
export const PRIMARY_COUNT = 4;
export const ALPHA_EACH = ALPHA / PRIMARY_COUNT;
export const BLOCK_WINDOW_DAYS = 28;
export const BLOCK_MIN_DAYS = 20;
export const WEEK_WINDOW = 10;
export const WEEK_MIN = 8;

export type SeriesKey = 'soul-legendary' | 'soul-epic' | 'soul-primordial' | 'soul-unique' | 'soul-rare' | 'soul-radiant' | 'legendary-p10';
export const SERIES: Record<SeriesKey, { label: string; itemId?: string }> = {
  'soul-legendary': { label: '레전더리 소울 결정', itemId: 'c6947ff630cc59aebdcbabfb449258d1' },
  'soul-epic': { label: '에픽 소울 결정', itemId: 'c7d845c65ab9dbcff6e55dc910fbea87' },
  'soul-primordial': { label: '태초 소울 결정', itemId: 'd288ebf406a65f4ec23d1f9c33227888' },
  'soul-unique': { label: '유니크 소울 결정', itemId: '0620c107b1aae1f3a6cf9eee3aaf43d7' },
  'soul-rare': { label: '레어 소울 결정', itemId: 'c4816db14d145416921f0210063cb014' },
  'soul-radiant': { label: '광휘의 소울 결정', itemId: '27a5877768a40a3a0eccc493d0a53b9b' },
  'legendary-p10': { label: '레전더리 카드 P10' },
};

type Spec = { id: string; primary: boolean; series: SeriesKey; title: string };
export type BlockSpec = Spec & { kind: 'block' };
/** 요일은 월요일=0부터 센 게임 주의 오프셋이다. */
export type WeekSpec = Spec & { kind: 'week'; base: number; target: number; expect: 'up' | 'down' };
const week = (id: string, primary: boolean, series: SeriesKey, title: string, base: number, target: number, expect: 'up' | 'down'): WeekSpec =>
  ({ id, primary, kind: 'week', series, title, base, target, expect });
export const HYPOTHESES: (BlockSpec | WeekSpec)[] = [
  { id: 'H1', primary: true, kind: 'block', series: 'soul-legendary', title: '레전더리 소울 결정 6시간 구간 방향' },
  week('H2', true, 'soul-legendary', '레전더리 소울 결정 토요일 > 금요일', 4, 5, 'up'),
  week('H3', true, 'soul-epic', '에픽 소울 결정 토요일 > 금요일', 4, 5, 'up'),
  week('H4', true, 'legendary-p10', '레전더리 카드 P10 목요일 < 수요일', 2, 3, 'down'),
  { id: 'S1', primary: false, kind: 'block', series: 'soul-epic', title: '에픽 소울 결정 6시간 구간 방향' },
  { id: 'S2', primary: false, kind: 'block', series: 'legendary-p10', title: '레전더리 카드 P10 6시간 구간 방향 (음성 대조)' },
  week('S3a', false, 'soul-primordial', '태초 소울 결정 토요일 > 금요일', 4, 5, 'up'),
  week('S3b', false, 'soul-unique', '유니크 소울 결정 토요일 > 금요일', 4, 5, 'up'),
  week('S3c', false, 'soul-rare', '레어 소울 결정 토요일 > 금요일', 4, 5, 'up'),
  week('S3d', false, 'soul-radiant', '광휘의 소울 결정 토요일 > 금요일', 4, 5, 'up'),
];

// ── 게임 하루(KST 06:00 → 다음 날 06:00)와 6시간 구간 ──────────────────
/** 게임일 시작 시각(KST 06:00) = 그 날짜 UTC 00:00 − 3시간. */
export const gameDayStart = (day: string) => Date.parse(day + 'T00:00:00Z') - 3 * H;
/** 시각 t가 속한 게임일. 날짜는 시작일이며 화요일 00~06시는 월요일 게임일이다. */
export const gameDayOf = (t: number) => new Date(t + 3 * H).toISOString().slice(0, 10);
export const mondayOf = (day: string) => shiftDay(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7));
/** KST 06·12·18·00시 정각. */
export const isBlockBoundary = (t: number) => t % H === 0 && (t / H) % 6 === 3;
export const blockStartAtOrBefore = (t: number) => Math.floor((t + 3 * H) / BLOCK) * BLOCK - 3 * H;

export const toSeries = (key: SeriesKey, points: { t: number; price: number }[]): Series => ({
  id: key, name: SERIES[key].label, category: 'ft1',
  // 구간 방향 모델은 시각과 가격만 쓴다.
  points: points.map((p) => ({ t: p.t, price: p.price, stock: 0, known: false, clean: false })),
});

// ── H1·S1·S2: 6시간 구간 방향 ───────────────────────────────────────
export type BlockIssue =
  | { status: 'issued'; start: number; slot: number; predictions: Record<string, number>; trainN: number; slotN: number; baseHours: number; inputHash: string }
  | { status: 'skipped'; start: number; reason: string };

/** τ 이전에 끝난 시간봉만으로 구간 [τ, τ+6h)의 방향을 예측한다. 후향 연구와 같은 함수를 쓴다. */
export function blockIssue(series: Series, tau: number): BlockIssue {
  if (!isBlockBoundary(tau)) throw new Error('구간 경계가 아닙니다');
  const study = blockDirectionStudy(series, tau, THRESHOLD, 6, false);
  const row = study.rows.find((r) => r.start === tau);
  if (!row) return { status: 'skipped', start: tau, reason: study.skipped.find((s) => s.start === tau)?.reason ?? 'no_data' };
  const used = series.points.filter((p) => p.t + H <= tau).map((p) => [p.t, p.price]);
  return { status: 'issued', start: tau, slot: row.slot, predictions: row.predictions, trainN: row.trainN, slotN: row.slotN,
    baseHours: row.baseHours, inputHash: createHash('sha256').update(JSON.stringify(used)).digest('hex') };
}

export type BlockActual =
  | { status: 'ok'; change: number; label: number; baseHours: number; targetHours: number }
  | { status: 'missing'; baseHours: number; targetHours: number };

/** 직전 구간 평균 대비 대상 구간 평균의 변화율. 각 구간은 4시간 이상 관측돼야 하며 보간하지 않는다. */
export function blockActual(series: Series, start: number): BlockActual {
  const byHour = new Map(series.points.map((p) => [p.t, p.price]));
  const mean = (from: number) => {
    const v = Array.from({ length: 6 }, (_, i) => byHour.get(from + i * H)).filter((x): x is number => x != null);
    return { hours: v.length, price: v.length >= 4 ? avg(v)! : null };
  };
  const base = mean(start - BLOCK), target = mean(start);
  if (base.price == null || target.price == null) return { status: 'missing', baseHours: base.hours, targetHours: target.hours };
  const change = (target.price / base.price - 1) * 100;
  return { status: 'ok', change, label: direction(change, THRESHOLD), baseHours: base.hours, targetHours: target.hours };
}

// ── H2·H3·H4·S3: 주간 요일 비교 ────────────────────────────────────
export function weekPlan(spec: WeekSpec, monday: string) {
  const baseDay = shiftDay(monday, spec.base), targetDay = shiftDay(monday, spec.target);
  return { monday, baseDay, targetDay,
    // 비교할 두 날이 시작하기 전에만 발행한다.
    issueFrom: gameDayStart(monday), issueUntil: gameDayStart(baseDay),
    settleAt: gameDayStart(shiftDay(targetDay, 1)) + SETTLE_WAIT };
}

export type WeekActual =
  | { status: 'ok'; success: boolean; ratioPct: number; commonSlots: number; common: { base: number; target: number };
      all: { base: number; target: number; baseHours: number; targetHours: number } }
  | { status: 'insufficient'; commonSlots: number; baseHours: number; targetHours: number };

/** 두 게임일에 모두 관측된 시간 칸만으로 각 날 평균을 비교한다. 점검으로 빈 시간이 한쪽 평균을 바꾸지 않게 하려는 규칙이다. */
export function weekActual(spec: WeekSpec, series: Series, plan: { baseDay: string; targetDay: string }): WeekActual {
  const byHour = new Map(series.points.map((p) => [p.t, p.price]));
  const slots = (day: string) => Array.from({ length: 24 }, (_, i) => byHour.get(gameDayStart(day) + i * H) ?? null);
  const a = slots(plan.baseDay), b = slots(plan.targetDay);
  const common = a.flatMap((v, i) => (v != null && b[i] != null ? [i] : []));
  const allA = a.filter((v): v is number => v != null), allB = b.filter((v): v is number => v != null);
  if (common.length < COMMON_SLOTS_MIN) return { status: 'insufficient', commonSlots: common.length, baseHours: allA.length, targetHours: allB.length };
  const base = avg(common.map((i) => a[i]!))!, target = avg(common.map((i) => b[i]!))!;
  return { status: 'ok', success: spec.expect === 'up' ? target > base : target < base, ratioPct: (target / base - 1) * 100,
    commonSlots: common.length, common: { base, target },
    all: { base: avg(allA)!, target: avg(allB)!, baseHours: allA.length, targetHours: allB.length } };
}

// ── 통계 ───────────────────────────────────────────────────────────
const logChoose = (n: number, k: number) => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i); return s; };
/** P(X ≥ k), X ~ Binomial(n, 0.5). 일측 정확 검정의 p값이다. */
export function upperTail(k: number, n: number) {
  if (n <= 0 || k <= 0) return 1;
  let sum = 0;
  for (let i = k; i <= n; i++) sum += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, sum);
}

// ── 보고서 ─────────────────────────────────────────────────────────
export type IssueRow = { hypothesis: string; target: string; issued_at: string | Date; payload: any };
export type ActualRow = { hypothesis: string; target: string; settled_at: string | Date; values: any };
export type Status = 'waiting' | 'collecting' | 'confirmed' | 'unconfirmed' | 'insufficient' | 'reported';
const MODELS = ['slot', 'majority', 'momentum', 'flat', 'down', 'up'];

function decide(spec: Spec, asOf: number, decisionAt: number, enough: boolean, success: boolean): Status {
  if (asOf < decisionAt) return 'collecting';
  if (!enough) return 'insufficient';
  return spec.primary ? (success ? 'confirmed' : 'unconfirmed') : 'reported';
}

function blockReport(spec: BlockSpec, issues: IssueRow[], actuals: ActualRow[], asOf: number) {
  const mine = issues.filter((i) => i.hypothesis === spec.id).sort((a, b) => a.target.localeCompare(b.target));
  const head = { id: spec.id, primary: spec.primary, kind: spec.kind, series: spec.series, title: spec.title,
    rule: { window: BLOCK_WINDOW_DAYS, minDays: BLOCK_MIN_DAYS, alpha: spec.primary ? ALPHA_EACH : null } };
  if (!mine.length) return { ...head, status: 'waiting' as Status };
  const firstDay = gameDayOf(Date.parse(mine[0].target));
  const lastDay = shiftDay(firstDay, BLOCK_WINDOW_DAYS - 1);
  const decisionAt = gameDayStart(shiftDay(firstDay, BLOCK_WINDOW_DAYS)) + 2 * D;
  const done = new Map(actuals.filter((a) => a.hypothesis === spec.id).map((a) => [a.target, a.values]));
  const rows = mine.map((i) => ({ i, day: gameDayOf(Date.parse(i.target)), a: done.get(i.target) }))
    .filter((r) => r.day >= firstDay && r.day <= lastDay);
  const scored = rows.filter((r) => r.i.payload.status === 'issued' && r.a?.status === 'ok');
  const correct = Object.fromEntries(MODELS.map((m) => [m, scored.filter((r) => r.i.payload.predictions[m] === r.a.label).length]));
  const days = [...new Set(scored.map((r) => r.day))].sort();
  const perDay = days.map((day) => {
    const rs = scored.filter((r) => r.day === day);
    const c = (m: string) => rs.filter((r) => r.i.payload.predictions[m] === r.a.label).length;
    return { day, n: rs.length, slot: c('slot'), majority: c('majority') };
  });
  const wins = perDay.filter((d) => d.slot > d.majority).length, losses = perDay.filter((d) => d.slot < d.majority).length;
  const p = upperTail(wins, wins + losses);
  const beatsAll = scored.length > 0 && MODELS.slice(1).every((m) => correct.slot > correct[m]);
  const skipped: Record<string, number> = {};
  for (const r of rows) if (r.i.payload.status === 'skipped') skipped[r.i.payload.reason] = (skipped[r.i.payload.reason] ?? 0) + 1;
  // 발행 기한(구간 시작 후 1시간)이 지난 경계 중 기록이 없는 것은 조용히 빠뜨리지 않고 누락으로 센다.
  const firstTau = Date.parse(mine[0].target);
  const lastDue = Math.min(blockStartAtOrBefore(asOf - BLOCK_ISSUE_WINDOW), gameDayStart(shiftDay(firstDay, BLOCK_WINDOW_DAYS)) - BLOCK);
  const expected = lastDue >= firstTau ? Math.floor((lastDue - firstTau) / BLOCK) + 1 : 0;
  return { ...head, firstDay, lastDay, decisionAt: new Date(decisionAt).toISOString(),
    status: decide(spec, asOf, decisionAt, days.length >= BLOCK_MIN_DAYS, p <= ALPHA_EACH && beatsAll),
    counts: { expected, missed: Math.max(0, expected - rows.length), rows: rows.length,
      issued: rows.filter((r) => r.i.payload.status === 'issued').length, skipped,
      scored: scored.length, days: days.length, unsettled: rows.filter((r) => r.i.payload.status === 'issued' && !r.a).length },
    models: MODELS.map((m) => ({ model: m, correct: correct[m], accuracy: scored.length ? correct[m] / scored.length : null })),
    sign: { wins, losses, ties: perDay.length - wins - losses, p: wins + losses ? p : null }, beatsAll, perDay };
}

function weekReport(spec: WeekSpec, issues: IssueRow[], actuals: ActualRow[], asOf: number) {
  const mine = issues.filter((i) => i.hypothesis === spec.id).sort((a, b) => a.target.localeCompare(b.target));
  const head = { id: spec.id, primary: spec.primary, kind: spec.kind, series: spec.series, title: spec.title, expect: spec.expect,
    rule: { window: WEEK_WINDOW, minWeeks: WEEK_MIN, commonSlotsMin: COMMON_SLOTS_MIN, alpha: spec.primary ? ALPHA_EACH : null } };
  if (!mine.length) return { ...head, status: 'waiting' as Status };
  const first = mine[0].target;
  const decisionAt = gameDayStart(shiftDay(first, 7 * WEEK_WINDOW)) + 2 * D;
  const done = new Map(actuals.filter((a) => a.hypothesis === spec.id).map((a) => [a.target, a.values as WeekActual]));
  const weeks = Array.from({ length: WEEK_WINDOW }, (_, k) => {
    const monday = shiftDay(first, 7 * k), plan = weekPlan(spec, monday), issued = mine.some((i) => i.target === monday), a = done.get(monday);
    const state = a ? (a.status === 'ok' ? 'ok' : 'insufficient')
      : issued ? (asOf < plan.settleAt ? 'pending' : 'unsettled')
      : (asOf < plan.issueUntil ? 'upcoming' : 'missed');
    return { week: monday, baseDay: plan.baseDay, targetDay: plan.targetDay, state,
      success: a?.status === 'ok' ? a.success : null, ratioPct: a?.status === 'ok' ? a.ratioPct : null,
      commonSlots: a?.commonSlots ?? null, allRatioPct: a?.status === 'ok' ? (a.all.target / a.all.base - 1) * 100 : null };
  });
  const evaluable = weeks.filter((w) => w.state === 'ok'), successes = evaluable.filter((w) => w.success).length;
  const p = upperTail(successes, evaluable.length);
  const states: Record<string, number> = {};
  for (const w of weeks) states[w.state] = (states[w.state] ?? 0) + 1;
  return { ...head, firstWeek: first, decisionAt: new Date(decisionAt).toISOString(),
    status: decide(spec, asOf, decisionAt, evaluable.length >= WEEK_MIN, p <= ALPHA_EACH),
    counts: { evaluable: evaluable.length, successes, ...states },
    binomial: { k: successes, n: evaluable.length, p: evaluable.length ? p : null }, weeks };
}

/** 화면과 점검용 요약. 발행·실측 행만으로 매번 다시 계산하며 별도 상태를 저장하지 않는다. */
export function forwardTestReport(issues: IssueRow[], actuals: ActualRow[], asOf: number) {
  return { version: FT_VERSION, asOf: new Date(asOf).toISOString(), start: new Date(FT_START).toISOString(),
    protocol: 'docs/forward-test-protocol-2026-10-02.md', alpha: ALPHA_EACH,
    hypotheses: HYPOTHESES.map((h) => h.kind === 'block' ? blockReport(h, issues, actuals, asOf) : weekReport(h, issues, actuals, asOf)) };
}
