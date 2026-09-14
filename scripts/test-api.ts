import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';

const key = 'fixture-secret+/=2026';
const source = stripTypeScriptTypes(readFileSync('src/api.ts', 'utf8'));
async function client(fetch: typeof globalThis.fetch) {
  const context = vm.createContext({
    URLSearchParams, AbortSignal, Error, process: { env: { NEOPLE_API_KEY: key } }, fetch,
    setTimeout(fn: () => void) { queueMicrotask(fn); },
  });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => { throw new Error('예상하지 않은 의존성'); });
  await module.evaluate();
  return module.namespace;
}

let calls = 0;
const api = await client(async (input, init) => {
  calls++;
  const url = new URL(String(input));
  assert.equal(url.searchParams.has('apikey'), false, '요청 URL에서 인증값 제외');
  assert(!String(input).includes(key));
  assert.equal(new Headers(init?.headers).get('apikey'), key, '헤더로만 인증');
  if (url.pathname.endsWith('/items')) assert.equal(url.searchParams.get('itemName'), '에픽 소울 결정');
  return new Response(JSON.stringify({ rows: [{ itemId: 'fixture' }] }));
});
assert.equal((await api.getSold('fixture', 100))[0].itemId, 'fixture');
await api.getAuction('fixture');
await api.searchItems('에픽 소울 결정');
assert.equal(calls, 3);

// 응답 본문·네트워크 오류·잘못된 JSON에서 반환된 키도 기록되지 않아야 한다.
for (const failure of ['http', 'network', 'json']) {
  let attempts = 0;
  const secretMessage = `인증 실패 ${key} / ${encodeURIComponent(key)}`;
  const failing = await client(async () => {
    attempts++;
    if (failure === 'network') throw new Error(secretMessage);
    if (failure === 'json') return new Response(secretMessage);
    return new Response(secretMessage, { status: 401 });
  });
  await assert.rejects(() => failing.getSold('fixture'), (error: Error) => {
    assert(!String(error.stack).includes(key));
    assert(!String(error.stack).includes(encodeURIComponent(key)));
    if (failure === 'json') assert.equal(error.message, '/auction-sold → 응답 JSON 해석 실패');
    else assert(error.message.includes('[REDACTED]'));
    return true;
  });
  assert.equal(attempts, failure === 'network' ? 4 : 1, '네트워크 재시도와 4xx 즉시 실패 유지');
}
for (const status of [429, 503]) {
  let attempts = 0;
  const retry = await client(async () => ++attempts === 1
    ? new Response('', { status }) : new Response('{"rows":[]}'));
  assert.equal((await retry.getAuction('fixture')).length, 0);
  assert.equal(attempts, 2);
}
console.log('API 헤더 인증·오류 비밀값 마스킹·재시도 테스트 통과');
