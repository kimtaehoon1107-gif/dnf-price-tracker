import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {prepare} from '../src/activity-study.ts';
import {blockDirectionStudy} from '../src/block-direction-study.ts';
const raw=readFileSync('data/intraday-study/activity-input.json','utf8'),input=JSON.parse(raw);
const series=prepare(input).filter(s=>s.id==='legendary:p10'||s.name==='레전더리 소울 결정');
const result={asOf:input.asOf,inputHash:createHash('sha256').update(raw).digest('hex'),primaryThreshold:.5,description:'Retrospective rolling classification; thresholds .25 and 1 are sensitivity checks, not selected alternatives.',results:series.flatMap(s=>[.5,.25,1].map(t=>blockDirectionStudy(s,Date.parse(input.asOf),t)))};
writeFileSync('docs/evidence/block-direction-20261002.json',JSON.stringify(result,null,2));
for(const r of result.results.filter(r=>r.threshold===.5))console.log(JSON.stringify({name:r.name,issued:r.issued,scored:r.scored,days:r.days,models:r.overall.map(m=>({model:m.model,accuracy:m.accuracy,balancedAccuracy:m.balancedAccuracy}))},null,2));
