import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {comparisonSummary,forecastItemNames,MIN_COMPARABLE,niceTicks,overview} from '../web/forecast-review-model.js';
const data=JSON.parse(readFileSync('web/forecast-review.json','utf8'));
assert.equal(data.items.length,3);
assert.deepEqual(Object.values(forecastItemNames).sort(),data.items.map(i=>i.name).sort());
assert.equal(forecastItemNames['not-a-supported-item'],undefined);
for(const item of data.items){
  const keys=new Set();
  for(const r of item.rows){
    assert.equal((Date.parse(r.target)-Date.parse(r.origin))/86400000,r.h);
    assert(!keys.has(r.target+'/'+r.h));keys.add(r.target+'/'+r.h);
    assert(r.actual>0&&Number.isFinite(r.actual));
    for(const v of Object.values(r.pred))assert(typeof v==='number'&&Number.isFinite(v)&&v>0);
    for(const m of r.failed)assert.equal(r.pred[m],r.pred.last);
  }
}
const sample=[{actual:100,pred:{last:110,arima110:120,weekday_arima:110},failed:['weekday_arima']}];
const score=comparisonSummary(sample);
assert(Math.abs(score.weekday_arima.mape-10)<1e-9);
assert.equal(score.weekday_arima.failures,1);
assert.equal(comparisonSummary([]).last.mape,null);

// 마지막 가격 유지보다 오차가 작았던 날만 센다. 같은 오차(적합 실패 대체 포함)는 나은 날이 아니다.
const winRows=[
  {actual:100,pred:{last:110,arima110:104,weekday_arima:110},failed:['weekday_arima']},
  {actual:100,pred:{last:105,arima110:112,weekday_arima:101},failed:[]},
  {actual:100,pred:{last:100,arima110:100,weekday_arima:100},failed:[]},
];
const wins=comparisonSummary(winRows);
assert.equal(wins.last.wins,null);
assert.equal(wins.arima110.wins,1);
assert.equal(wins.weekday_arima.wins,1);

// 화면이 근거로 삼는 규칙: 7일 뒤는 품목마다 한 주(7건)에 못 미쳐 평균 오차를 비교하지 않는다.
const table=overview(data.items);
assert.equal(table.length,9);
for(const row of table.filter(r=>r.h===7))assert(row.n<MIN_COMPARABLE,'7일 뒤는 비교 최소 건수에 못 미친다');
assert(table.filter(r=>r.n>=MIN_COMPARABLE).every(r=>r.h===1),'비교 가능한 조합은 내일뿐');
assert.equal(table.reduce((n,r)=>n+r.n,0),data.items.reduce((n,i)=>n+i.rows.length,0));

// 축 눈금은 둥근 값이어야 하고 데이터 범위를 덮어야 한다.
for(const [min,max] of [[1049531,1384755],[0.55,9.98],[306000,309000],[92.14,92.14],[1e8,1.3e8]]){
  const {ticks,lo,hi}=niceTicks(min,max);
  assert(ticks.length>=2&&ticks.length<=8,`${min}~${max} 눈금 수 ${ticks.length}`);
  assert(lo<=min&&hi>=max,`${min}~${max}을 덮지 못함`);
  const step=ticks[1]-ticks[0];
  for(let i=1;i<ticks.length;i++)assert(Math.abs(ticks[i]-ticks[i-1]-step)<step*1e-6,'눈금 간격 불일치');
  const unit=10**Math.floor(Math.log10(step));
  assert([1,2,2.5,5,10].some(m=>Math.abs(step/unit-m)<1e-6),`${step}는 1·2·2.5·5 배수가 아님`);
}
assert.deepEqual(niceTicks(1049531,1384755).ticks,[1000000,1100000,1200000,1300000,1400000]);
assert.deepEqual(niceTicks(Number.NaN,1).ticks,[]);
console.log('forecast review: date alignment, fallback inclusion, metrics, overview and axis ticks passed');
