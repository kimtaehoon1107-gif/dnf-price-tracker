import assert from 'node:assert/strict';
import { distributionRows, distributionSegments } from '../web/price-distribution.js';
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
console.log('가격 분포 화면: KST 날짜·결측·희소 표본·불완전 원본·진행 시간 통과');
