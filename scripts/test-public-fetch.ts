import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';

const source = stripTypeScriptTypes(readFileSync('src/public-fetch.ts','utf8'));
async function run(outcomes: (number | Error)[]) {
  let calls = 0, cancelled = 0;
  const waits: number[] = [], signals: AbortSignal[] = [];
  const context = vm.createContext({ Error, AbortSignal,
    setTimeout(resolve: () => void, ms: number) { waits.push(ms); queueMicrotask(resolve); },
    fetch: async (url: string, options: RequestInit) => {
      assert.equal(url,'https://example.test/data.json');
      assert.equal(options.cache,'no-store');
      assert.equal(new Headers(options.headers).get('user-agent'),'fixture');
      signals.push(options.signal!);
      const outcome = outcomes[calls++];
      if (outcome instanceof Error) throw outcome;
      return {status:outcome,body:{async cancel(){cancelled++;}}};
    },
  });
  const module = new vm.SourceTextModule(source,{context});
  await module.link(()=>{throw new Error('unexpected import');});
  await module.evaluate();
  let status: number | undefined, error: unknown;
  try { status = (await module.namespace.fetchPublic('https://example.test/data.json',30000,
    {cache:'no-store',headers:{'user-agent':'fixture'}})).status; } catch(e) {error=e;}
  assert.equal(new Set(signals).size,calls,'매 시도마다 새 timeout 신호 사용');
  return {calls,cancelled,waits,status,error};
}
for (const status of [429,500,502,503,504]) {
  const result=await run([status,200]);
  assert.equal(result.status,200); assert.equal(result.calls,2); assert.equal(result.cancelled,1);
}
for (const status of [200,400,401,403,404]) {
  const result=await run([status]);
  assert.equal(result.status,status); assert.equal(result.calls,1); assert.deepEqual(result.waits,[]);
}
const exhausted=await run([503,503,503]);
assert.equal(exhausted.status,503); assert.equal(exhausted.calls,3); assert.deepEqual(exhausted.waits,[1000,2000]);
const timeout=Object.assign(new Error('timeout'),{name:'TimeoutError'});
assert.equal((await run([timeout,new TypeError('network'),200])).status,200);
const network=await run([timeout,timeout,timeout]);
assert.equal(network.error,timeout); assert.equal(network.calls,3);
console.log('공개 조회: 5xx·429·네트워크 재시도, 4xx 즉시 반환, 횟수·대기·timeout 경계 통과');
