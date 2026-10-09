import assert from 'node:assert/strict';
import { axisLabel, axisTicks, distributionRows, distributionSegments, periodChange } from '../web/price-distribution.js';
const data = { asOf:'2026-09-21T05:30:00Z',minTrades:5,
  daily:[{d:'2026-09-18',median:100,n:10},{d:'2026-09-20',median:120,n:2},{d:'2026-09-21',median:null,n:8}],
  hourly:[{t:'2026-09-20T15:00:00Z',median:100,n:5},{t:'2026-09-20T17:00:00Z',median:101,n:5}] };
const rows = distributionRows(data,'all');
assert.deepEqual(rows.map(r=>r.state),['ready','missing','sparse','unavailable']);
assert.equal(rows.at(-1).partial,true);
assert.equal(distributionSegments(rows).length,1);
const card=distributionRows({basis:'ask',asOf:data.asOf,daily:[
  {d:'2026-09-18',vwap:100,n:1},{d:'2026-09-19',vwap:0,n:2},
  {d:'2026-09-21',vwap:120,n:3},
]},'all');
assert.deepEqual(card.map(r=>r.state),['ready','missing','missing','ready']);
assert.equal(card[0].median,100,'카드는 중앙값 대신 기존 최저호가 평균을 사용');
assert.equal(card[1].median,null,'매물 없는 날을 0원으로 그리지 않는다');
assert.equal(distributionSegments(card).length,2,'가격 없는 날짜 양쪽을 연결하지 않는다');
assert.equal(distributionRows(data,1).length,1);
assert.equal(distributionRows(null).length,0);
const material = distributionRows({ basis:'legendary', asOf:data.asOf, daily:[
  {d:'2026-09-18',vwap:100,hours:18}, {d:'2026-09-19',vwap:900,hours:17},
  {d:'2026-09-20',vwap:120,hours:24}, {d:'2026-09-21',vwap:200,hours:18},
] }, 'all');
assert.deepEqual(material.map(r=>r.state), ['ready','sparse','ready','ready']);
assert.equal(distributionSegments(material).length,2,'재료 시세도 관측 부족일을 가로질러 연결하지 않는다');
assert.equal(periodChange(material).last.d,'2026-09-20','당일을 기간 변화에서 제외');
assert.ok(Math.abs(periodChange(material).percent-20)<1e-9,'18시간 이상 관측한 완료일만 비교');
console.log('가격 분포 화면: KST 날짜·결측·희소 표본·불완전 원본·진행 시간 통과');

const {chartRows, usableForecast} = await import('../web/price-distribution.js');
const forward = {metric:'vwap',asOf:'2026-10-06T16:00:00Z',minTrades:5,
 daily:[{d:'2026-10-06',vwap:100,median:90,n:20},{d:'2026-10-07',vwap:110,median:95,n:10}],
 forecast:{status:'ready',anchor:{d:'2026-10-06',value:100},points:Array.from({length:8},(_,i)=>({d:`2026-10-${String(7+i).padStart(2,'0')}`,value:101+i}))}};
const future=chartRows(forward);
assert.equal(future[0].median,100,'실측과 예측은 같은 VWAP 기준');
assert.equal(future.length,9);
assert.equal(future.at(-1).state,'forecast');
assert.equal(future.at(-1).d,'2026-10-14');
assert.equal(periodChange(future),null,'future and partial days excluded from actual change');
assert.equal(distributionSegments(future).flat().length,2,'future not drawn as observed');
assert.equal(usableForecast({...forward,asOf:'2026-10-08T01:00:00Z'}),null,'stale forecast not shifted forward');
assert.equal(chartRows({...forward,forecast:{status:'unavailable'}}).length,2);

// 축 눈금: 둥근 값만, 보이는 범위 안에서, 3~6개. 실제 화면에서 "5100.0만, 4776.7만, 4453.3만, 4130.0만"이 나오던 범위로 확인한다.
{
  const lo = 41300000 - 0.15 * 9700000, hi = 51000000 + 0.15 * 9700000;
  const { ticks, step } = axisTicks(lo, hi);
  assert.deepEqual(ticks.map(axisLabel), ['4,000만', '4,250만', '4,500만', '4,750만', '5,000만']);
  assert(ticks.every(v => v >= lo && v <= hi) && step === 2500000);
  for (const [a, b] of [[280000, 310000], [1049531, 1384755], [8.5e7, 1.3e8], [92, 101], [9500, 12500]]) {
    const { ticks: t, step: s } = axisTicks(a, b);
    assert(t.length >= 2 && t.length <= 7 && t.every(v => v >= a && v <= b), `${a}~${b} 눈금 ${t}`);
    assert([1, 2, 2.5, 5, 10].some(m => Math.abs(s / 10 ** Math.floor(Math.log10(s)) - m) < 1e-9), `${a}~${b} 간격 ${s}가 1·2·2.5·5 배수가 아님`);
    assert(t.every(v => Math.abs(v / s - Math.round(v / s)) < 1e-9), `${a}~${b} 눈금이 간격의 배수가 아님`);
  }
  assert.deepEqual(axisTicks(5, 5).ticks, [5]);
  assert.equal(axisLabel(125000000), '1.25억');
  assert.equal(axisLabel(9500), '9,500');
}
