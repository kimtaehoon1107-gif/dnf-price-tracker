import assert from 'node:assert/strict';
import { decide, MIN_AGE_MS, RECENT_SUCCESS_MS, type Issue, type Run } from '../src/watchdog-issues.ts';

const now = Date.parse('2026-10-08T12:00:00Z');
const at = (msAgo: number) => new Date(now - msAgo).toISOString();
const min = 60000;
const issue = (over: Partial<Issue> = {}): Issue => ({ number: 1, title: '[감시견] 수집 지연 — 전역 공백 24.5분 · 지연 8종', created_at: at(5 * 3600000), state: 'open', ...over });
const run = (conclusion: string | null, msAgo: number, status = 'completed'): Run => ({ status, conclusion, updated_at: at(msAgo) });

// 알림 이후 수집이 성공했고 마지막 완료 실행도 성공이면 닫는다.
assert.equal(decide(issue(), [run('success', 20 * min)], now).close, true);
// 취소된 실행은 판단에서 뺀다: 성공 뒤에 취소가 와도 닫는다(동시성 정책으로 취소가 흔하다).
assert.equal(decide(issue(), [run('cancelled', 5 * min), run('success', 20 * min)], now).close, true);
// 알림 직후에는 닫지 않는다.
assert.equal(decide(issue({ created_at: at(MIN_AGE_MS - min) }), [run('success', 5 * min)], now).close, false);
// 마지막 완료 실행이 실패면 이전 성공이 있어도 유지한다.
assert.equal(decide(issue(), [run('failure', 5 * min), run('success', 40 * min)], now).close, false);
// 성공이 너무 오래됐으면(수집이 멈췄을 수 있다) 유지한다.
assert.equal(decide(issue(), [run('success', RECENT_SUCCESS_MS + min)], now).close, false);
// 알림보다 이전의 성공은 복구의 증거가 아니다.
assert.equal(decide(issue({ created_at: at(10 * min + MIN_AGE_MS) }), [run('success', MIN_AGE_MS + 30 * min)], now).close, false);
assert.equal(decide(issue({ created_at: at(MIN_AGE_MS + min) }), [run('success', MIN_AGE_MS + 2 * min)], now).close, false);
// 실행이 없거나 아직 진행 중이면 유지한다.
assert.equal(decide(issue(), [], now).close, false);
assert.equal(decide(issue(), [run(null, 5 * min, 'in_progress')], now).close, false);
// 감시견 이슈가 아니거나 PR이거나 이미 닫힌 것은 건드리지 않는다.
assert.equal(decide(issue({ title: '디자인 개선 제안' }), [run('success', 5 * min)], now).close, false);
assert.equal(decide(issue({ pull_request: {} }), [run('success', 5 * min)], now).close, false);
assert.equal(decide(issue({ state: 'closed' }), [run('success', 5 * min)], now).close, false);
console.log('감시견 이슈 정리: 복구 판단·취소 실행 제외·알림 직후/오래된 성공/이전 성공 보류 통과');
