import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {study,windowStats,HOUR} from '../src/event-hourly-study.ts';
const inputDir=process.argv[2]??'data/d-note-study-20261103';
const inputBytes=readFileSync(`${inputDir}/input.json.gz`),input=JSON.parse(gunzipSync(inputBytes).toString());
const at=Date.parse('2026-10-27T10:00:00Z'),announced=Date.parse('2026-10-23T06:00:00Z');
const event=input.sources.flatMap((s:any)=>s.events).find((e:any)=>e.type==='방송'&&Date.parse(e.starts_at)===at);
assert(event&&Date.parse(event.announced_at)===announced,'이벤트 원본과 규칙 불일치');
const items=input.items.map((item:any)=>{
  const rows=input.sources.flatMap((s:any)=>s.rows.filter((x:any)=>x.item_id===item.id));
  const byHour=new Map<number,any>(rows.map((x:any)=>[Date.parse(x.hour),x]));
  const baseline=windowStats(byHour,at-6*HOUR,6);
  return {...item,
    comparisons:[1,6,24].map(h=>study(rows,at,announced,6,h)),
    sensitivities:[study(rows,at,announced,24,6),study(rows,at,announced,6,6,'noThursday'),study(rows,at,announced,6,6,'Tuesday')],
    path:Array.from({length:48},(_,i)=>{
      const offset=i-24,row=byHour.get(at+offset*HOUR);
      return {offset,at:new Date(at+offset*HOUR).toISOString(),price:row?.vwap??null,index:row&&baseline?100*row.vwap/baseline.price:null,qty:row?.qty??null};
    })};
});
const hash=(s:Buffer|string)=>createHash('sha256').update(s).digest('hex');
const report={format:1,exploratory:true,at:new Date(at).toISOString(),inputRevision:input.revision,
  analysisRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  mainRevision:execFileSync('git',['rev-parse','origin/main'],{encoding:'utf8'}).trim(),
  inputHash:hash(inputBytes),inputJsonHash:hash(gunzipSync(inputBytes)),from:input.from,through:input.through,
  snapshots:input.sources.map((s:any)=>({name:s.name,...s.snapshot})),items};
const evidence='docs/evidence/d-note-20261103';mkdirSync(evidence,{recursive:true});
copyFileSync(`${inputDir}/input.json.gz`,`${evidence}/input.json.gz`);
copyFileSync(`${inputDir}/summary.json`,`${evidence}/summary.json`);
writeFileSync(`${evidence}/results.json`,JSON.stringify(report,null,2)+'\n');
const pct=(x:number|null|undefined)=>x==null?'—':`${x>=0?'+':''}${x.toFixed(2)}`;
const rows=items.map((item:any)=>{
  const c=item.comparisons[1],a=c.actual;
  return `| ${item.name} | ${pct(a?.pricePct)} | ${pct(c.excessPp)} | ${pct(c.low)}~${pct(c.high)} | ${c.referenceCount} | ${pct(a?.qtyPct)} | ${c.status} |`;
});
const counts=[1,6,24].map((h,i)=>({h,ready:items.filter((x:any)=>x.comparisons[i].status!=='자료 부족').length,
  outside:items.filter((x:any)=>x.comparisons[i].status==='평소 범위 밖(탐색)').map((x:any)=>x.name)}));
const detail=items.filter((x:any)=>x.comparisons[1].status==='평소 범위 밖(탐색)').map((item:any)=>{
  const windowRows=item.comparisons.map((c:any)=>`| ${c.afterHours}시간 | ${pct(c.actual?.pricePct)} | ${pct(c.excessPp)} | ${pct(c.low)}~${pct(c.high)} | ${c.referenceCount} | ${c.status} |`).join('\n');
  const sensitivity=item.sensitivities.map((c:any)=>`| ${c.mode==='all'?'직전 24시간 기준':c.mode==='Tuesday'?'화요일만':'목요일이 걸친 창 제외'} | ${pct(c.actual?.pricePct)} | ${pct(c.excessPp)} | ${pct(c.low)}~${pct(c.high)} | ${c.referenceCount} | ${c.status} |`).join('\n');
  return `## ${item.name}\n\n| 직후 창 | 실제 변화 % | 초과 변화 pp | 평소 5~95% 범위 | 참고일 | 상태 |\n|---|---:|---:|---:|---:|---|\n${windowRows}\n\n6시간 창 민감도. 화요일만 비교는 4개 수준의 기술적 비교이며 추론에 쓰지 않는다.\n\n| 비교 규칙 | 실제 변화 % | 초과 변화 pp | 평소 범위 | 참고일 | 상태 |\n|---|---:|---:|---:|---:|---|\n${sensitivity}`;
});
writeFileSync('docs/d-note-event-analysis-results-2026-11-03.md',`# D-NOTE 시간봉 탐색 분석 결과\n
분석일: 2026-11-03. [계산 전 고정한 탐색 규칙](d-note-event-analysis-plan-2026-11-03.md). 사후 설계이므로 사전 등록 연구가 아니다.\n
공식 공지상 10-27 19시 방송 예정, 20시 퍼스트 서버 개방이다. 실제 발언 시각을 검증하지 않았으며 6·24시간 결과는 두 사건이 함께 포함된다. [공식 출처](https://df.nexon.com/community/news/notice/2928724).\n
## 핵심 결과\n
${counts.map(c=>`- ${c.h}시간 창: 38종 중 비교 가능 ${c.ready}종, 평소 범위 밖 ${c.outside.length}종 (${c.outside.join(', ')||'없음'}).`).join('\n')}\n
주된 6시간 비교에서 범위 이탈은 평소 동일 시간대의 관측 움직임보다 이례적이라는 뜻이다. 여러 품목·창을 탐색했으며 신뢰구간·검정·다중검정 보정을 수행한 유의성 판정이 아니다. 따라서 방송의 인과효과나 '영향 없음'을 결론내릴 수 없다. 카드 34종은 호가 기반이므로 체결 분석에서 제외했다.\n
닳아버린 순례의 증표는 서버 개방 전 1시간에도 +11.89%로 참고 범위를 벗어났고, 직전 24시간을 기준으로 바꿔도 6시간 상승이 범위 밖이었다. 방송 시점과 맞물린 변화라는 관측 근거가 세 품목 중 상대적으로 일관된다. 다만 방송 내용·다른 공지·거래구성의 영향을 분해한 인과 증명은 아니다.\n
레전더리 소울은 6시간 기준 +13.37%이지만 직전 24시간 기준으로는 +4.91%이고 평소 범위 안이었다. 에픽 소울은 6시간 +26.18%지만 서버 개방 전 1시간의 +9.97%는 평소 범위 안이었다. 에픽의 24시간 기준 민감도 참고일은 19개로 최소 20개에 미달한다. 두 소울의 방송 단독 효과를 확정하지 않는다.\n
24시간 창은 실제 변화가 계산되는 품목도 있지만 모든 품목에서 유효 과거 비교일이 최소 20개에 미달했다. 시간 경로를 볼 수 있다는 것과 이례성을 평가할 표본이 충분하다는 것은 다르다.\n
![시간봉 가격 경로](evidence/d-note-20261103/price-path.png)\n
## 38종 전체: 직전 6시간 대비 직후 6시간\n
가격은 원본 시간봉 수량 가중 평균 체결가다. 초과 변화는 실제 변화에서 과거 가상 사건 변화 중앙값을 뺀 퍼센트포인트. 거래량은 시간당 관측 수량 변화이며 전수 시장 거래량이 아니다. 모든 시간에 양의 체결 봉을 요구하므로 희소 품목은 자료 부족으로 남긴다. 결측 원인은 무거래와 수집 누락을 구분할 수 없다.\n
| 품목 | 가격 변화 % | 초과 변화 pp | 평소 5~95% 범위 | 참고일 | 수량 변화 % | 판정 |\n|---|---:|---:|---:|---:|---:|---|\n${rows.join('\n')}\n
${detail.join('\n\n')}\n
## 해석의 한계\n
- 비교일은 공지 이전의 매일 19시다. 모두 동일 요일이 아니며 추세·다른 사건·시간대 거래구성 변화가 섞여 있다. 목요일 제외와 화요일만의 결과를 함께 보되 적은 참고일로 유의성을 주장하지 않는다.\n+- 원본 체결 시간봉을 사용했다. 화면의 정제 일봉과 수치가 다를 수 있다. raw_complete는 보존 중 원본과의 집계 경계 상태이지 API 완전 포착 인증이 아니다. 과거 원본 삭제로 false인 봉도 그대로 보존했다.\n+- 비교 가능 품목은 활발한 거래 종목으로 치우친다. 전체 시장 대표값이나 38종 전체의 평균 효과로 일반화하지 않는다.\n+- 관측된 거래 수량 급증은 수집 응답 포화의 영향을 받을 수 있다. 과거 collection_runs 7일 보존 때문에 전체 참고기간의 포착률을 이 입력만으로 재검증하지 못했다.\n+- 공지 뒤~방송 전 기대 반영, 방송 내용별 발언 시각, 서버 개방 이후의 영향을 분해하지 않았다. 발표 내용을 반영한 수혜/피해 분류도 결과를 보고 소급 지정하지 않는다.\n
## 재현과 보존\n
- 운영 main: \`${report.mainRevision}\`\n+- 보고서 생성 코드 커밋: ${report.analysisRevision}\n- 입력 확보/계산 함수 커밋: \`${report.inputRevision}\`\n+- 입력 구간: ${input.from} 이상 ~ ${input.through} 미만 (KST 09-28 19시~10-28 19시).\n+- DB 기준: ${report.snapshots.map((s:any)=>`${s.name}: read_at=${s.read_at}, refreshed_at=${s.refreshed_at}, raw_max_id=${s.raw_max_id}`).join('; ')}\n+- 입력 gzip SHA-256: \`${report.inputHash}\`\n+- 압축 전 JSON SHA-256: \`${report.inputJsonHash}\`\n+- 입력·공개 summary·모든 비교일/시간경로/민감도 결과는 [evidence/d-note-20261103](evidence/d-note-20261103)에 보존. 파일별 해시는 manifest.json.\n+- 재계산: \`node scripts/d-note-event-study.ts docs/evidence/d-note-20261103\`\n+- 그림: \`python scripts/plot-d-note-study.py\`\n+- 운영 DB는 읽기 전용 트랜잭션만 사용했다. 정기 수집·R2·모델·분석 규칙·사이트 배포는 변경하지 않았다.\n`);
console.log(JSON.stringify(counts));
