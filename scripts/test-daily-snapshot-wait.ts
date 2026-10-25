import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import * as ledger from '../src/daily-forecast-ledger.ts';
import * as input from '../src/daily-forecast-input.ts';

const source=stripTypeScriptTypes(readFileSync('scripts/record-daily-vwap.ts','utf8'))+'\nexport {main};';
async function record(summary:any) {
  const outputs:string[]=[];
  let r2=false;
  const context=vm.createContext({console:{log(){}},process:{argv:[],env:{GITHUB_OUTPUT:'output'}},
    Date:class extends Date {constructor(){super('2026-10-24T15:16:00Z');}},
  });
  const synthetic=(values:Record<string,unknown>)=>new vm.SyntheticModule(Object.keys(values),function(){
    for(const [k,v] of Object.entries(values))this.setExport(k,v);
  },{context});
  const modules={
    'node:assert/strict':synthetic({default:assert}),
    'node:fs/promises':synthetic({readFile(){},writeFile(){},mkdir:async()=>{},appendFile:async(_p:string,s:string)=>outputs.push(s)}),
    'node:crypto':synthetic({createHash(){}}),
    'node:child_process':synthetic({execFileSync(){}}),
    'node:url':synthetic({pathToFileURL(){}}),
    '@aws-sdk/client-s3':synthetic({S3Client:class{constructor(){r2=true;throw new Error('R2 reached');}},GetObjectCommand:class{},PutObjectCommand:class{},ListObjectsV2Command:class{}}),
    '../src/daily-forecast-ledger.ts':synthetic(ledger),
    '../src/daily-forecast-input.ts':synthetic(input),
    '../src/public-fetch.ts':synthetic({fetchPublic:async()=>({ok:true,json:async()=>summary})}),
  };
  const module=new vm.SourceTextModule(source,{context});
  await module.link(name=>modules[name]);await module.evaluate();
  let error:unknown;
  try{await module.namespace.main();}catch(e){error=e;}
  return {outputs,r2,error};
}
const summary={priceAsOf:'2026-10-24T15:07:00Z',quality:{through:'2026-10-24T14:00:00Z',stale:false,mismatches:0},cleaning:input.FORECAST_PREPROCESSING};
const pending=await record(summary);
assert.equal(pending.error,undefined);assert(!pending.r2);assert.deepEqual(pending.outputs,['snapshot_pending=true\n']);
for(const invalid of [{...summary,quality:{...summary.quality,mismatches:1}},{...summary,cleaning:{version:'wrong'}}]) {
  const result=await record(invalid);assert(result.error);assert(!result.r2);assert.deepEqual(result.outputs,[]);
}
const ready=await record({...summary,quality:{...summary.quality,through:'2026-10-24T15:00:00Z'}});
assert(ready.r2,'당일 완료 시간봉이 있으면 기존 R2 처리로 진행');
assert.deepEqual(ready.outputs,[]);
console.log('자정 예측 진입점: 정상 대기 시 R2·완료 캐시 차단, 정제·정합성 오류 차단, 준비 완료 시 기존 처리 통과');
