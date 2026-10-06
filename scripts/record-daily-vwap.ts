import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { S3Client,GetObjectCommand,PutObjectCommand,ListObjectsV2Command } from '@aws-sdk/client-s3';
import { VERSION,day,shift,checkSnapshot,makeInput,validateIssue,settle,evaluate,type Series } from '../src/daily-forecast-ledger.ts';

const PREFIX=`research-v1/daily-vwap/${VERSION}/`;
const BASE='https://kimtaehoon1107-gif.github.io/dnf-price-tracker/data/';
const WORK='archive-work-daily-vwap';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export function journal(client:{send:(command:any)=>Promise<any>},Bucket:string) {
  return {
    async get(key:string) {
      try {const r=await client.send(new GetObjectCommand({Bucket,Key:PREFIX+key}));return JSON.parse(await r.Body.transformToString());}
      catch(e:any) {if(e.$metadata?.httpStatusCode===404)return null;throw e;}
    },
    async putOnce(key:string,value:any) {
      try {await client.send(new PutObjectCommand({Bucket,Key:PREFIX+key,Body:JSON.stringify(value),ContentType:'application/json',IfNoneMatch:'*'}));return true;}
      catch(e:any) {if(e.$metadata?.httpStatusCode===412)return false;throw e;}
    },
    async list(prefix:string) {
      const keys:string[]=[];let token:string|undefined;
      do {const r=await client.send(new ListObjectsV2Command({Bucket,Prefix:PREFIX+prefix,ContinuationToken:token}));
        keys.push(...(r.Contents??[]).map((o:any)=>o.Key.slice(PREFIX.length)));token=r.NextContinuationToken;
      } while(token);
      return keys.sort();
    },
  };
}
async function getPublic(path:string,optional=false) {
  const r=await fetch(BASE+path,{signal:AbortSignal.timeout(30000),cache:'no-store'});
  if(optional && r.status===404)return null;
  assert(r.ok,`공개 자료 HTTP ${r.status}`);return r.json();
}
async function main() {
  await mkdir(WORK,{recursive:true});
  const now=new Date().toISOString(),origin=day(now);
  const summary=await getPublic('summary.json');checkSnapshot(summary,now);
  const client=new S3Client({region:'auto',endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID!,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY!},
    requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  const store=journal(client,process.env.R2_BUCKET!);
  // 모델 코드가 바뀌면 기존 버전 기록에 섞지 않고 버전 갱신을 요구한다.
  const files=['src/forecast.ts','src/daily-forecast-ledger.ts','scripts/predict-daily-vwap.py','scripts/forecast-model-study.py','scripts/arima-diagnostics-study.py','scripts/arima-diagnostics-requirements.txt','scripts/forecast-study-requirements.txt'];
  const contents=await Promise.all(files.map(f=>readFile(f,'utf8')));
  const modelHash=hash(contents.map(s=>s.replaceAll('\r\n','\n')).join('\n'));
  await store.putOnce('protocol.json',{version:VERSION,modelHash,files,createdAt:now,rule:'02시 이후 당일 첫 정상 공개 빌드; 목표일 종료 24시간 후 실측 고정; h=1/3/7; n>=5'});
  assert.equal((await store.get('protocol.json')).modelHash,modelHash,'모델 코드 변경: 새 실험 VERSION 필요');
  const issues=await Promise.all((await store.list('issues/')).map(k=>store.get(k)));
  const actuals=await Promise.all((await store.list('actuals/')).map(k=>store.get(k)));
  const hour=new Date(Date.parse(now)+9*3600000).getUTCHours();
  const needsIssue=hour>=2 && !issues.some(i=>i.origin===origin);
  const targets=[...new Set<string>(issues.flatMap(i=>i.items.flatMap((it:any)=>it.predictions.map((p:any)=>p.d))))]
    .filter(d=>d<=shift(origin,-2) && !actuals.some(a=>a.target===d));
  const current=summary.items.filter((i:any)=>i.price_basis==='trade' && i.category!=='카드');
  const ids=new Set<string>(needsIssue?current.map((i:any)=>i.item_id):[]);
  for(const target of targets) for(const issue of issues) for(const item of issue.items)
    if(item.predictions.some((p:any)=>p.d===target))ids.add(item.id);
  const series:Series[]=[];
  for(const id of ids) {
    const s=await getPublic(`series/${id}.json`,true);
    if(needsIssue && current.some((i:any)=>i.item_id===id))assert(s,'현재 품목 시계열 누락');
    series.push({id,name:current.find((i:any)=>i.item_id===id)?.item_name??id,daily:s?.daily??[]});
  }
  if(ids.size)assert.equal((await getPublic('summary.json')).builtAt,summary.builtAt,'다운로드 중 공개 배포 변경: 다음 실행에서 재시도');
  let issued=0;
  if(needsIssue) {
    const input=makeInput(series.filter(s=>current.some((i:any)=>i.item_id===s.id)),origin);
    await writeFile(`${WORK}/input.json`,JSON.stringify(input));
    execFileSync(process.env.PYTHON??'python',['scripts/predict-daily-vwap.py',`${WORK}/input.json`,`${WORK}/predictions.json`],{stdio:'inherit',timeout:300000});
    const prediction=JSON.parse(await readFile(`${WORK}/predictions.json`,'utf8'));
    const issuedAt=new Date().toISOString();
    const issue={version:VERSION,origin,issuedAt,dataAsOf:summary.priceAsOf,builtAt:summary.builtAt,modelHash,inputSha256:hash(JSON.stringify(input)),input,excluded:input.excluded,items:prediction.items};
    validateIssue(issue,issuedAt);
    issued=Number(await store.putOnce(`issues/${origin}.json`,issue));
    issues.push(await store.get(`issues/${origin}.json`));
  }
  for(const target of targets) {
    const ids=[...new Set<string>(issues.flatMap(i=>i.items.filter((it:any)=>it.predictions.some((p:any)=>p.d===target)).map((it:any)=>it.id)))];
    const actual={...settle(target,series,ids,new Date().toISOString()),dataAsOf:summary.priceAsOf,builtAt:summary.builtAt};
    await store.putOnce(`actuals/${target}.json`,actual);
    actuals.push(await store.get(`actuals/${target}.json`));
  }
  const evaluation={generatedAt:new Date().toISOString(),issuedDays:issues.length,...evaluate(issues,actuals)};
  await writeFile(`${WORK}/evaluation.json`,JSON.stringify(evaluation));
  const lines=['# 개별 평균 거래가 예측 검증',`버전 ${VERSION} · 발행 누적 ${issues.length}일 · 이번 신규 ${issued}일 · 실측 신규 ${targets.length}일`,
    `평가 대기 ${evaluation.pending.length}건 · 실측 부족 제외 ${evaluation.excluded.length}건`,'',
    '|거리|모델|평가 건수|품목|목표 날짜|MAPE|','|---|---|---:|---:|---:|---:|',
    ...evaluation.scores.map(s=>`|${s.h}|${s.model}|${s.count}|${s.items}|${s.dates}|${s.mape===null?'대기':s.mape.toFixed(3)+'%'}|`),
    '','표본이 적거나 같은 날짜를 공유하는 평가를 독립 표본으로 해석하지 않습니다. 전체 비교와 품목별 평가는 evaluation.json에 있습니다.'];
  const report=lines.join('\n')+'\n';
  await writeFile(`${WORK}/report.md`,report);
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,report);
  console.log(`개별 예측: ${origin} 신규 ${issued} · 실측 ${targets.length} · 평가 ${evaluation.rows.length}`);
  client.destroy();
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(e=>{console.error('개별 예측 기록 실패:',e instanceof assert.AssertionError?e.message:e.name);process.exitCode=1;});
