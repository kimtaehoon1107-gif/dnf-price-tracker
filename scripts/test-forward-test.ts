import assert from 'node:assert/strict';
import { H, D, type Series } from '../src/activity-study.ts';
import { blockDirectionStudy } from '../src/block-direction-study.ts';
import { direction } from '../src/intraday-joint-forecast.ts';
import * as ft from '../src/forward-test.ts';
import { readForwardTestReport, recordForwardTest } from '../src/forward-test-db.ts';

const approx = (a: number, b: number) => assert(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);
const utc = (s: string) => Date.parse(s);

// ── 게임일·구간 경계 ────────────────────────────────────────────────
assert.equal(ft.gameDayOf(utc('2026-10-02T21:00:00Z')), '2026-10-03', '06:00 KST는 그 날짜 게임일의 시작');
assert.equal(ft.gameDayOf(utc('2026-10-03T20:59:00Z')), '2026-10-03', '다음 날 05:59 KST는 아직 같은 게임일');
assert.equal(ft.gameDayOf(utc('2026-10-03T21:00:00Z')), '2026-10-04');
assert.equal(ft.gameDayStart('2026-10-03'), ft.FT_START);
assert.equal(ft.mondayOf('2026-10-03'), '2026-09-28', '토요일 게임일의 주 시작');
assert.equal(ft.mondayOf('2026-10-04'), '2026-09-28', '일요일 게임일은 그 주의 마지막');
assert.equal(ft.mondayOf('2026-10-05'), '2026-10-05');
for (const h of [21, 3, 9, 15]) assert(ft.isBlockBoundary(utc(`2026-10-03T${String(h).padStart(2, '0')}:00:00Z`)), `UTC ${h}시 = KST 06·12·18·00시`);
for (const h of [0, 1, 2, 4, 10, 20, 22]) assert(!ft.isBlockBoundary(utc(`2026-10-03T${String(h).padStart(2, '0')}:00:00Z`)));
assert(!ft.isBlockBoundary(utc('2026-10-02T21:30:00Z')));
assert.equal(ft.blockStartAtOrBefore(utc('2026-10-03T00:30:00Z')), utc('2026-10-02T21:00:00Z'));
assert.equal(ft.blockStartAtOrBefore(utc('2026-10-03T03:00:00Z')), utc('2026-10-03T03:00:00Z'));

// ── 6시간 구간 발행: 후향 연구와 같은 예측, 미래 누출 없음 ─────────────────
const start = utc('2026-09-01T21:00:00Z'); // KST 06:00
const s: Series = { id: 'x', name: 'x', category: 'x', points: Array.from({ length: 24 * 22 }, (_, i) =>
  ({ t: start + i * H, price: 100 + Math.sin(i * Math.PI / 12) * 2 + Math.sin(i * 0.37) * 0.8, stock: 0, known: false, clean: false })) };
const tau = start + 16 * D + 6 * H;
const issue = ft.blockIssue(s, tau);
assert.equal(issue.status, 'issued');
const study = blockDirectionStudy(s, start + 22 * D).rows.find((r) => r.start === tau)!;
assert.deepEqual((issue as any).predictions, study.predictions, '발행 시점의 예측은 나중에 전체 자료로 다시 계산한 같은 구간의 예측과 같다');
assert.equal((issue as any).slot, study.slot);
const changed = { ...s, points: s.points.map((p) => (p.t >= tau ? { ...p, price: p.price * 4 } : p)) };
assert.deepEqual(ft.blockIssue(changed, tau), issue, 'τ 이후 가격이 바뀌어도 발행·입력 해시는 같다');
const firstHour = { ...s, points: s.points.filter((p) => p.t !== tau + H) };
assert.deepEqual(ft.blockIssue(firstHour, tau), issue, '대상 구간의 시간봉 유무와 무관');
assert.throws(() => ft.blockIssue(s, tau + H), /경계/);
assert.deepEqual(ft.blockIssue(s, start + 3 * D + 6 * H), { status: 'skipped', start: start + 3 * D + 6 * H, reason: 'training_insufficient' });
const gap = { ...s, points: s.points.filter((p) => !(p.t >= tau - 6 * H && p.t < tau - 2 * H)) };
assert.equal((ft.blockIssue(gap, tau) as any).reason, 'input_missing', '직전 구간 관측이 4시간 미만이면 입력 부족');
assert.equal((ft.blockIssue({ ...s, points: [] }, tau) as any).reason, 'no_data');

// ── 구간 실측: 같은 함수의 정답과 일치, 결측은 채우지 않음 ───────────────────
const actual = ft.blockActual(s, tau) as any;
assert.equal(actual.status, 'ok');
assert.equal(actual.change, study.actual);
assert.equal(actual.label, direction(study.actual!, ft.THRESHOLD));
assert.deepEqual([actual.baseHours, actual.targetHours], [6, 6]);
const thin = ft.blockActual({ ...s, points: s.points.filter((p) => !(p.t >= tau + 2 * H && p.t < tau + 6 * H)) }, tau);
assert.deepEqual(thin, { status: 'missing', baseHours: 6, targetHours: 2 });

// ── 주간 비교: 두 날에 모두 관측된 시간 칸만 비교 ─────────────────────────
const h2 = ft.HYPOTHESES.find((h) => h.id === 'H2') as ft.WeekSpec, h4 = ft.HYPOTHESES.find((h) => h.id === 'H4') as ft.WeekSpec;
const plan = ft.weekPlan(h2, '2026-10-05');
assert.deepEqual([plan.baseDay, plan.targetDay], ['2026-10-09', '2026-10-10']);
assert.equal(plan.issueFrom, utc('2026-10-04T21:00:00Z'));
assert.equal(plan.issueUntil, utc('2026-10-08T21:00:00Z'), '금요일 게임일이 시작되기 전까지만 발행');
assert.equal(plan.settleAt, utc('2026-10-11T21:00:00Z'), '토요일 게임일이 끝나고 24시간 뒤');
assert.equal(ft.weekPlan(h4, '2026-10-05').issueUntil, utc('2026-10-06T21:00:00Z'), 'H4는 수요일 게임일 시작 전까지');
const day = (d: string, f: (slot: number) => number | null) => Array.from({ length: 24 }, (_, i) => f(i) == null ? [] : [{ t: ft.gameDayStart(d) + i * H, price: f(i)! }]).flat();
const mk = (pts: { t: number; price: number }[]): Series => ft.toSeries('soul-legendary', pts);
const same = ft.weekActual(h2, mk([...day('2026-10-09', (i) => 100 + i), ...day('2026-10-10', (i) => (i < 4 ? null : 100 + i))]), plan) as any;
assert.equal(same.status, 'ok');
assert.equal(same.commonSlots, 20);
assert.equal(same.success, false, '같은 모양에서 앞 4시간이 비었을 뿐이면 공통 시간 비교는 변화 없음');
assert(same.all.target > same.all.base, '전체 관측 시간 평균은 점검으로 빈 시간 때문에 높아 보인다');
approx(same.ratioPct, 0);
const up = ft.weekActual(h2, mk([...day('2026-10-09', () => 100), ...day('2026-10-10', () => 105)]), plan) as any;
assert.deepEqual([up.status, up.success, up.commonSlots], ['ok', true, 24]);
approx(up.ratioPct, 5);
const down = ft.weekActual(h4, mk([...day('2026-10-07', () => 100), ...day('2026-10-08', () => 95)]), ft.weekPlan(h4, '2026-10-05')) as any;
assert.equal(down.success, true, 'H4는 목요일이 수요일보다 낮을 때 성공');
const sparse = ft.weekActual(h2, mk([...day('2026-10-09', () => 100), ...day('2026-10-10', (i) => (i < 10 ? 110 : null))]), plan);
assert.deepEqual(sparse, { status: 'insufficient', commonSlots: 10, baseHours: 24, targetHours: 10 });

// ── 정확 이항 검정 ──────────────────────────────────────────────────
approx(ft.upperTail(8, 8), 1 / 256);
approx(ft.upperTail(9, 10), 11 / 1024);
approx(ft.upperTail(7, 8), 9 / 256);
approx(ft.upperTail(10, 10), 1 / 1024);
assert.equal(ft.upperTail(0, 10), 1);
assert.equal(ft.upperTail(3, 0), 1);
assert(ft.upperTail(9, 10) <= ft.ALPHA_EACH && ft.upperTail(8, 10) > ft.ALPHA_EACH, '10주 평가에서는 9주 이상 성공해야 확인');
assert(ft.upperTail(8, 8) <= ft.ALPHA_EACH && ft.upperTail(7, 8) > ft.ALPHA_EACH);

// ── 보고서: 구간 방향 ───────────────────────────────────────────────
const day0 = '2026-10-03';
const block = (dayIdx: number, j: number) => utc('2026-10-02T21:00:00Z') + dayIdx * D + j * 6 * H;
const LABELS = [0, 2, 0, 2], SLOT = [0, 2, 0, 0], MAJ = [0, 0, 2, 0], MOM = [2, 0, 2, 0];
const blockRows = (days: number, slot = SLOT) => {
  const issues: ft.IssueRow[] = [], actuals: ft.ActualRow[] = [];
  for (let d = 0; d < days; d++) for (let j = 0; j < 4; j++) {
    const target = new Date(block(d, j)).toISOString();
    issues.push({ hypothesis: 'H1', target, issued_at: target, payload: { status: 'issued',
      predictions: { slot: slot[j], majority: MAJ[j], momentum: MOM[j], flat: 1, down: 0, up: 2 } } });
    actuals.push({ hypothesis: 'H1', target, settled_at: target, values: { status: 'ok', label: LABELS[j], change: 0, baseHours: 6, targetHours: 6 } });
  }
  return { issues, actuals };
};
const full = blockRows(28);
const decisionAt = ft.gameDayStart('2026-10-31') + 2 * D;
const h1 = (r: ReturnType<typeof ft.forwardTestReport>) => r.hypotheses.find((h) => h.id === 'H1') as any;
assert.equal(ft.forwardTestReport([], [], decisionAt).hypotheses[0].status, 'waiting');
const early = h1(ft.forwardTestReport(full.issues, full.actuals, decisionAt - 1));
assert.equal(early.status, 'collecting', '창이 끝나기 전에는 판정하지 않는다');
const done = h1(ft.forwardTestReport(full.issues, full.actuals, decisionAt));
assert.deepEqual([done.status, done.counts.days, done.counts.scored, done.sign.wins, done.sign.losses, done.sign.ties, done.beatsAll], ['confirmed', 28, 112, 28, 0, 0, true]);
assert.deepEqual(done.models.map((m: any) => m.correct), [84, 28, 0, 0, 56, 56], '모든 단순 기준선과 같은 표본에서 비교');
assert.equal(done.counts.missed, 0);
// 시간대 모델이 항상 하락 기준선을 못 이기면 p값이 작아도 확인하지 않는다.
const alwaysDown = blockRows(28, [0, 0, 0, 0]);
assert.equal(h1(ft.forwardTestReport(alwaysDown.issues, alwaysDown.actuals, decisionAt)).status, 'unconfirmed');
// 날짜별 승패가 섞이면 미확정.
const flip = blockRows(28);
flip.issues.forEach((r, i) => { if (Math.floor(i / 4) < 12) r.payload.predictions.slot = MAJ[i % 4]; }); // 앞 12일은 시간대=최빈 → 동률
flip.issues.forEach((r, i) => { const d = Math.floor(i / 4); if (d >= 12 && d < 20) r.payload.predictions.slot = [2, 0, 2, 0][i % 4]; }); // 8일은 시간대가 전부 틀림
const flipped = h1(ft.forwardTestReport(flip.issues, flip.actuals, decisionAt));
assert.deepEqual([flipped.sign.wins, flipped.sign.losses, flipped.sign.ties], [8, 8, 12]);
assert.equal(flipped.status, 'unconfirmed');
// 채점 일수가 모자라면 판정 불가, 누락은 세어 둔다.
const thinDays = blockRows(10);
const t = h1(ft.forwardTestReport(thinDays.issues, thinDays.actuals, decisionAt));
assert.equal(t.status, 'insufficient');
assert.equal(t.counts.missed, 28 * 4 - 40, '기한이 지난 경계 중 기록이 없는 것은 누락');
// 입력 부족으로 남긴 발행은 채점하지 않고 사유를 센다.
const skip = blockRows(28);
skip.issues[0].payload = { status: 'skipped', reason: 'input_missing' };
assert.deepEqual(h1(ft.forwardTestReport(skip.issues, skip.actuals, decisionAt)).counts.skipped, { input_missing: 1 });
assert.equal(h1(ft.forwardTestReport(skip.issues, skip.actuals, decisionAt)).counts.scored, 111);
// 보조 가설은 확인으로 표시하지 않는다.
const s1 = blockRows(28); s1.issues.forEach((r) => (r.hypothesis = 'S1')); s1.actuals.forEach((r) => (r.hypothesis = 'S1'));
assert.equal(ft.forwardTestReport(s1.issues, s1.actuals, decisionAt).hypotheses.find((h) => h.id === 'S1')!.status, 'reported');

// ── 보고서: 주간 비교 ───────────────────────────────────────────────
const weekRows = (id: string, flags: (boolean | 'insufficient' | 'missing')[]) => {
  const issues: ft.IssueRow[] = [], actuals: ft.ActualRow[] = [];
  flags.forEach((f, k) => {
    const monday = new Date(utc('2026-10-05T00:00:00Z') + k * 7 * D).toISOString().slice(0, 10);
    if (f === 'missing') return;
    issues.push({ hypothesis: id, target: monday, issued_at: monday, payload: { status: 'issued' } });
    actuals.push({ hypothesis: id, target: monday, settled_at: monday, values: f === 'insufficient'
      ? { status: 'insufficient', commonSlots: 9, baseHours: 24, targetHours: 12 }
      : { status: 'ok', success: f, ratioPct: f ? 3 : -2, commonSlots: 24, common: { base: 100, target: 103 }, all: { base: 100, target: 103, baseHours: 24, targetHours: 24 } } });
  });
  return { issues, actuals };
};
const weekDecision = ft.gameDayStart('2026-12-14') + 2 * D; // 첫 주 10월 5일 + 10주
const hw = (id: string, flags: Parameters<typeof weekRows>[1], asOf = weekDecision) => {
  const { issues, actuals } = weekRows(id, flags);
  return ft.forwardTestReport(issues, actuals, asOf).hypotheses.find((h) => h.id === id) as any;
};
assert.equal(hw('H2', Array(10).fill(true), weekDecision - 1).status, 'collecting');
assert.deepEqual([hw('H2', Array(10).fill(true)).status, hw('H2', Array(10).fill(true)).binomial.k], ['confirmed', 10]);
assert.equal(hw('H2', [...Array(9).fill(true), false]).status, 'confirmed', '10주 중 9주 성공은 p=0.0107');
assert.equal(hw('H2', [...Array(8).fill(true), false, false]).status, 'unconfirmed', '10주 중 8주 성공은 p=0.0547');
assert.equal(hw('H4', [...Array(7).fill(true), 'insufficient', 'insufficient', 'missing']).status, 'insufficient', '평가 가능한 주가 8주 미만');
assert.equal(hw('H4', [...Array(8).fill(true), 'insufficient', 'missing']).status, 'confirmed', '8주가 모두 성공하고 2주는 평가 불가');
const withStates = hw('H3', [true, true, 'insufficient', 'missing'], utc('2026-11-04T00:00:00Z'));
assert.deepEqual([withStates.counts.ok, withStates.counts.insufficient, withStates.counts.missed], [2, 1, 1]);
assert.equal(withStates.weeks[3].state, 'missed');
assert.equal(withStates.weeks[9].state, 'upcoming', '아직 발행 기한 전인 주');
assert.equal(ft.forwardTestReport([], [], 0).hypotheses.filter((h) => h.status === 'waiting').length, ft.HYPOTHESES.length);

// ── 기록기: 가짜 DB로 발행·중복·늦은 발행·실측 확정 ───────────────────────
const KEYS = Object.entries(ft.SERIES);
const price = (key: string, t: number) => {
  const wd = new Date(ft.gameDayStart(ft.gameDayOf(t)) + 3 * H).getUTCDay(); // 게임일 날짜의 요일
  const bump = key === 'legendary-p10' ? (wd === 4 ? 0.97 : 1) : (wd === 6 ? 1.03 : 1);
  return 1000 * (1 + 0.02 * Math.sin(t / H * 0.9) + 0.01 * Math.sin(t / H / 24 * 6.3)) * bump;
};
const history = (key: string, to: number) => {
  const out = [];
  for (let t = utc('2026-08-20T00:00:00Z'); t < to; t += H) out.push({ t, price: price(key, t) });
  return out;
};
function fakeDb(clock: { now: number }) {
  const issues: any[] = [], actuals: any[] = [], writes: string[] = [];
  const writer = { async query(sql: string, args: any[] = []) {
    if (sql.includes('clock_timestamp() AS now')) return { rows: [{ now: new Date(clock.now) }] };
    if (sql.startsWith('INSERT INTO forward_test_issues')) {
      writes.push('issue');
      if (issues.some((r) => r.hypothesis === args[1] && r.target === args[2])) return { rows: [], rowCount: 0 };
      issues.push({ version: args[0], hypothesis: args[1], target: args[2], data_as_of: args[3], payload: JSON.parse(args[4]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM forward_test_issues i')) return { rows: issues.filter((i) => i.payload.status === 'issued'
      && !actuals.some((a) => a.hypothesis === i.hypothesis && a.target === i.target)).map((i) => ({ hypothesis: i.hypothesis, target: i.target })) };
    if (sql.startsWith('INSERT INTO forward_test_actuals')) {
      writes.push('actual');
      if (actuals.some((r) => r.hypothesis === args[1] && r.target === args[2])) return { rows: [], rowCount: 0 };
      actuals.push({ version: args[0], hypothesis: args[1], target: args[2], values: JSON.parse(args[3]) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error('예상하지 못한 쿼리: ' + sql.slice(0, 60));
  } };
  const reader = { async query(sql: string, args: any[] = []) {
    if (sql.includes('FROM items')) return { rows: KEYS.flatMap(([, v]) => v.itemId ? [{ item_id: v.itemId, item_name: v.label }] : []) };
    if (sql.includes('FROM candles_1h')) {
      const [ids, from, to] = args as [string[], Date, Date];
      return { rows: KEYS.flatMap(([key, v]) => v.itemId && ids.includes(v.itemId)
        ? history(key, to.getTime()).filter((p) => p.t >= from.getTime()).map((p) => ({ item_id: v.itemId, ...p })) : []) };
    }
    if (sql.includes('FROM legendary_card_floor')) {
      const [from, to] = args as [Date, Date];
      return { rows: history('legendary-p10', to.getTime()).filter((p) => p.t >= from.getTime()) };
    }
    throw new Error('예상하지 못한 읽기: ' + sql.slice(0, 60));
  } };
  return { issues, actuals, writes, writer, reader };
}
const quality = (asOf: string, through = asOf.slice(0, 13) + ':00:00Z') => ({ checkedAt: asOf, through });
{
  const clock = { now: utc('2026-10-02T21:10:00Z') }, db = fakeDb(clock);
  const before = await recordForwardTest(db.writer, db.reader, quality('2026-10-02T20:30:00Z'));
  assert.deepEqual(before, { issued: 0, skipped: 0, settled: 0, idle: true });
  assert.equal(db.writes.length, 0, '시작 전에는 아무것도 쓰지 않는다');
  // 첫 구간: 06:00 KST. 주간 가설은 시작 전 주라서 발행하지 않는다.
  const first = await recordForwardTest(db.writer, db.reader, quality('2026-10-02T21:06:00Z'));
  assert.deepEqual([first.issued, first.skipped, first.settled], [3, 0, 0]);
  assert.deepEqual(db.issues.map((r) => r.hypothesis).sort(), ['H1', 'S1', 'S2']);
  assert(db.issues.every((r) => r.target === '2026-10-02T21:00:00.000Z' && r.payload.status === 'issued' && r.payload.inputHash.length === 64));
  const again = await recordForwardTest(db.writer, db.reader, quality('2026-10-02T21:06:00Z'));
  assert.equal(again.issued, 0, '같은 구간은 한 번만 발행');
  assert.equal(db.issues.length, 3);
  // 기한(구간 시작 후 1시간)이 지난 실행은 소급 발행하지 않는다.
  clock.now = utc('2026-10-03T00:30:00Z');
  await recordForwardTest(db.writer, db.reader, quality('2026-10-03T00:12:00Z', '2026-10-03T00:00:00Z'));
  assert.equal(db.issues.length, 3, '09시 실행은 06시 구간을 새로 발행하지 못한다');
  // 12:00 KST 구간은 정상 발행. 시간봉 집계가 구간 경계에 못 미치면 발행하지 않는다.
  clock.now = utc('2026-10-03T03:10:00Z');
  assert.equal((await recordForwardTest(db.writer, db.reader, quality('2026-10-03T03:06:00Z', '2026-10-03T02:00:00Z'))).issued, 0);
  assert.equal((await recordForwardTest(db.writer, db.reader, quality('2026-10-03T03:06:00Z'))).issued, 3);
  // 월요일 06시 이후: 구간 3개 + 주간 가설 7개. 첫 구간 3개는 대상이 끝나고 24시간이 지나 실측이 확정된다.
  clock.now = utc('2026-10-04T21:10:00Z');
  const monday = await recordForwardTest(db.writer, db.reader, quality('2026-10-04T21:06:00Z'));
  assert.deepEqual([monday.issued, monday.settled], [10, 6], '10-03 06시·12시 구간 6개 확정');
  assert.deepEqual(db.issues.filter((r) => r.target === '2026-10-05').map((r) => r.hypothesis).sort(), ['H2', 'H3', 'H4', 'S3a', 'S3b', 'S3c', 'S3d']);
  const settled = db.actuals.find((a) => a.hypothesis === 'H1' && a.target === '2026-10-02T21:00:00.000Z')!;
  assert.equal(settled.values.status, 'ok');
  assert.equal(settled.values.baseHours, 6);
  // 비교할 첫 날이 시작한 뒤의 실행은 그 주를 발행하지 않는다(수요일 06시 이후 H4, 금요일 06시 이후 H2).
  clock.now = utc('2026-10-06T22:10:00Z');
  await recordForwardTest(db.writer, db.reader, quality('2026-10-06T22:06:00Z'));
  assert(db.issues.filter((r) => r.target === '2026-10-05').length === 7);
  // 토요일 게임일이 끝나고 24시간 뒤: 주간 가설이 확정된다. H2는 토요일이 높고 H4는 목요일이 낮은 합성 자료다.
  clock.now = utc('2026-10-11T21:10:00Z');
  await recordForwardTest(db.writer, db.reader, quality('2026-10-11T21:06:00Z'));
  const week = (id: string) => db.actuals.find((a) => a.hypothesis === id && a.target === '2026-10-05')!.values;
  assert.deepEqual([week('H2').status, week('H2').success, week('H4').status, week('H4').success], ['ok', true, 'ok', true]);
  assert.equal(week('H2').commonSlots, 24);
  // 확정한 실측은 다시 쓰지 않는다.
  const settledBefore = db.actuals.length;
  assert.equal((await recordForwardTest(db.writer, db.reader, quality('2026-10-11T21:06:00Z'))).settled, 0);
  assert.equal(db.actuals.length, settledBefore);
  // 읽기 보고서: 테이블이 없으면 null, 있으면 같은 규칙의 보고서.
  assert.equal(await readForwardTestReport({ async query() { return { rows: [{ t: null }] }; } }, utc('2026-10-12T00:00:00Z')), null);
  const report = await readForwardTestReport({ async query(sql: string) {
    if (sql.includes('to_regclass')) return { rows: [{ t: 'forward_test_issues' }] };
    if (sql.includes('FROM forward_test_issues')) return { rows: db.issues };
    return { rows: db.actuals };
  } }, utc('2026-10-12T00:00:00Z'));
  assert.equal(report!.hypotheses.find((h) => h.id === 'H2')!.status, 'collecting');
}
{
  // 늦게 실행된 첫 시도: 기한이 이미 지났다면 아무 구간도 만들지 않는다.
  const clock = { now: utc('2026-10-02T23:30:00Z') }, db = fakeDb(clock);
  assert.equal((await recordForwardTest(db.writer, db.reader, quality('2026-10-02T21:06:00Z'))).issued, 0);
  assert.equal(db.issues.length, 0);
  // 구간 경계에 학습 자료가 모자라면 사유를 남긴 행을 쓴다(조용히 빠뜨리지 않는다).
  const thinReader = { async query(sql: string, args: any[] = []) {
    const rows = (await db.reader.query(sql, args)).rows;
    return { rows: sql.includes('FROM candles_1h') || sql.includes('FROM legendary_card_floor') ? rows.filter((r: any) => r.t >= utc('2026-09-30T00:00:00Z')) : rows };
  } };
  clock.now = utc('2026-10-02T21:10:00Z');
  const r = await recordForwardTest(db.writer, thinReader, quality('2026-10-02T21:06:00Z'));
  assert.deepEqual([r.issued, r.skipped], [0, 3]);
  assert(db.issues.every((i) => i.payload.status === 'skipped' && i.payload.reason === 'training_insufficient'));
}
// 고정한 종목 ID와 이름이 다르면 발행하지 않는다.
{
  const clock = { now: utc('2026-10-02T21:10:00Z') }, db = fakeDb(clock);
  const wrong = { async query(sql: string, args: any[] = []) {
    if (sql.includes('FROM items')) return { rows: [{ item_id: ft.SERIES['soul-legendary'].itemId, item_name: '다른 이름' }] };
    return db.reader.query(sql, args);
  } };
  await assert.rejects(() => recordForwardTest(db.writer, wrong, quality('2026-10-02T21:06:00Z')), /고정한 종목/);
}
console.log('전향 검증: 게임일·구간 경계, 후향 연구와 같은 발행, 미래 누출 없음, 공통 시간 비교, 정확 이항 검정, 사전 발행 기한, 중복·늦은 발행 방지, 실측 확정 불변, 판정 규칙 통과');
