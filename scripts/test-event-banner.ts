import assert from 'node:assert/strict';
import { bannerState, DELETE_AT } from '../web/event-banner.js';

const at = (s: string) => bannerState(Date.parse(s));
assert.equal(DELETE_AT, Date.parse('2026-11-04T21:00:00Z'), '11-05 06:00 KST');
// 기준선: 09-10부터 완료된 날짜 수. 10-02에는 09-10~10-01의 22일이 끝났다.
assert.deepEqual(at('2026-10-02T12:00:00+09:00'), { show: true, stage: 'baseline', lead: 'D-34', text: '패키지 판매 종료 · 삭제 전 연구 기준선 22/42일' });
assert.equal(at('2026-09-10T00:30:00+09:00').text, '패키지 판매 종료 · 삭제 전 연구 기준선 0/42일');
assert.equal(at('2026-10-21T23:59:00+09:00').text, '패키지 판매 종료 · 삭제 전 연구 기준선 41/42일');
// 10-22 0시에 선반영 구간이 시작된다.
assert.deepEqual([at('2026-10-22T00:00:00+09:00').stage, at('2026-10-22T00:00:00+09:00').lead, at('2026-10-22T00:00:00+09:00').text],
  ['anticipation', 'D-14', '패키지 판매 종료 · 삭제 전 14일 관측 0/14일']);
assert.equal(at('2026-11-04T23:59:00+09:00').text, '패키지 판매 종료 · 삭제 전 14일 관측 13/14일');
// 삭제 당일 06시 전에는 오늘 삭제로 표시하고 선반영 14일이 모두 끝났다.
assert.deepEqual([at('2026-11-05T05:59:00+09:00').lead, at('2026-11-05T05:59:00+09:00').text], ['오늘 06시 삭제', '패키지 판매 종료 · 삭제 전 14일 관측 14/14일']);
// 삭제 뒤: 11-06~11-19의 1차 구간 진행.
assert.deepEqual(at('2026-11-05T06:00:00+09:00'), { show: true, stage: 'after', lead: '삭제 완료', text: '삭제 뒤 비교 관측 중 · 1차 구간 0/14일' });
assert.equal(at('2026-11-12T12:00:00+09:00').text, '삭제 뒤 비교 관측 중 · 1차 구간 6/14일');
assert.equal(at('2026-11-20T00:00:00+09:00').text, '삭제 뒤 비교 관측 중 · 1차 구간 14/14일');
assert.equal(at('2026-12-03T23:59:00+09:00').show, true);
assert.deepEqual(at('2026-12-04T00:00:00+09:00'), { show: false });
console.log('판매 종료 띠: D-day·기준선/선반영/삭제 후 단계 경계 통과');
