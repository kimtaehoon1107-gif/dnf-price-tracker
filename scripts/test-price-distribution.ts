import assert from 'node:assert/strict';
import { distributionRows, distributionSegments } from '../web/price-distribution.js';
const data = { asOf:'2026-09-21T05:30:00Z',minTrades:5,
  daily:[{d:'2026-09-18',median:100,n:10},{d:'2026-09-20',median:120,n:2},{d:'2026-09-21',median:null,n:8}],
  hourly:[{t:'2026-09-20T15:00:00Z',median:100,n:5},{t:'2026-09-20T17:00:00Z',median:101,n:5}] };
const rows = distributionRows(data,'all');
assert.deepEqual(rows.map(r=>r.state),['ready','missing','sparse','unavailable']);
assert.equal(rows.at(-1).partial,true);
assert.equal(distributionSegments(rows).length,1);
const hours=distributionRows(data,30,'2026-09-21');
assert.equal(hours.length,15,'진행 중인 시간까지만 표시하고 미래는 만들지 않는다');
assert.equal(hours[1].state,'missing');
assert.equal(hours[2].state,'ready');
assert.equal(distributionSegments(hours).length,2,'빈 시간 양쪽을 연결하지 않는다');
assert.equal(distributionRows(data,1).length,1);
assert.equal(distributionRows(null).length,0);
console.log('가격 분포 화면: KST 날짜·결측·희소 표본·불완전 원본·진행 시간 통과');
