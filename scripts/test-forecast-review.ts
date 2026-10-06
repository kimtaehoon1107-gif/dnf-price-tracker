import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {comparisonSummary} from '../web/forecast-review-model.js';
const data=JSON.parse(readFileSync('web/forecast-review.json','utf8'));
assert.equal(data.items.length,3);
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
console.log('forecast review: date alignment, fallback inclusion and metrics passed');
