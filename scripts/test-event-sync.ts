import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source=stripTypeScriptTypes(readFileSync('scripts/sync-events.ts','utf8'));
async function sync(fail: string[]) {
  const saved: string[]=[],logs: string[]=[];
  let ended=false;
  const context=vm.createContext({ Error, Map, Set,
    process:{argv:['node','sync-events.ts']},
    console:{log:(s:string)=>logs.push(s),warn:(s:string)=>logs.push(s)},
    Date:class extends Date { constructor(value?:string|number){super(value??'2026-10-26T03:00:00Z');} },
  });
  const synthetic=(values:Record<string,unknown>)=>new vm.SyntheticModule(Object.keys(values),function(){
    for(const [k,v] of Object.entries(values))this.setExport(k,v);
  },{context});
  const modules={
    '../src/db.ts':synthetic({pool:{end:async()=>{ended=true;}},query:async(sql:string,args:any[])=>{
      if(sql.includes('INSERT INTO events'))saved.push(args[0]);
      return {rows:[]};
    }}),
    '../src/live-projects.ts':synthetic({trackedItems:async()=>[{item_id:'a',item_name:'숲속의 유랑악단 패키지'}]}),
    '../src/public-fetch.ts':synthetic({fetchPublic:async(url:string)=>{
      if(fail.some(part=>url.includes(part)))throw new Error('HTTP 502');
      const text=url.endsWith('/update/list')
        ? '<ul><li class="category">주요</li><li class="title" data-no="11">10/22(목) 주요 업데이트<div class="iconset"></div></li><li class="date">2026.10.21</li></ul>'
        : url.endsWith('/seriashop/list')
          ? '<ul data-id="22"><b>숲속의 유랑악단 패키지</b>2026.08.27 ~ 2026.11.05</ul>'
          : '<span class="date">2026.10.21 12:00</span>';
      return {ok:true,text:async()=>text};
    }}),
  };
  const module=new vm.SourceTextModule(source,{context});
  await module.link(name=>modules[name]);
  let error:unknown;
  try{await module.evaluate();}catch(e){error=e;}
  assert(ended,'실패 후에도 DB 연결 종료');
  return {saved,error,logs};
}
const success=await sync([]);
assert.equal(success.error,undefined);assert.equal(success.saved.length,2);
for(const [broken,kept] of [['seriashop/list','주요 업데이트'],['update/list','숲속의 유랑악단 패키지']]) {
  const result=await sync([broken]);
  assert.equal(result.saved.length,1);
  assert(result.saved[0].includes(kept),'다른 목록 장애로 정상 후보를 버리지 않음');
  assert.match(String(result.error),/목록 조회 실패/,'부분 실패는 Actions 실패로 유지');
}
const failed=await sync(['update/list','seriashop/list']);
assert.equal(failed.saved.length,0);assert(failed.error);
console.log('공식 공지: 목록별 실패 격리·정상 후보 저장·실패 표시·연결 정리 통과');
