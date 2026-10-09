import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// 공유 링크로 상세 화면(#품목번호)에 바로 들어오면 index.html <head>가 그 품목의 시계열 파일을 미리 요청하고,
// app.js의 fetchSeries()가 그 응답을 이어받는다. 두 곳의 요청이 어긋나면 같은 파일을 두 번 받거나, 미리 한 요청이 버려진다.

const html = readFileSync('web/index.html', 'utf8');
const app = readFileSync('web/app.js', 'utf8');

// ── ① 요청 주소·옵션이 두 곳에서 같다
const earlyFetch = html.match(/fetch\(`(data\/series\/)\$\{id\}(\.json)`, (\{ cache: 'no-cache' \})\)/);
const ownFetch = app.match(/fetch\(`(data\/series\/)\$\{itemId\}(\.json)`, (\{ cache: 'no-cache' \})\)/);
assert(earlyFetch, 'index.html의 미리 요청이 fetch(`data/series/${id}.json`, { cache: \'no-cache\' }) 모양이어야 함');
assert(ownFetch, 'app.js fetchSeries()의 직접 요청이 fetch(`data/series/${itemId}.json`, { cache: \'no-cache\' }) 모양이어야 함');
assert.deepEqual(earlyFetch.slice(1), ownFetch.slice(1), '미리 요청과 직접 요청의 주소·옵션이 같아야 함');
assert(app.includes('await fetchSeries(it.item_id)'), 'renderDetail이 fetchSeries(it.item_id)로 시계열을 받아야 함');
assert(html.includes('window.__seriesRequest') && app.includes('globalThis.__seriesRequest'), '미리 요청을 넘기고 받는 이름(__seriesRequest)이 같아야 함');

// 스크립트가 스타일시트보다 뒤에 있으면 브라우저가 CSS가 다 올 때까지 실행을 미뤄 미리 요청의 의미가 사라진다.
const scriptAt = html.indexOf('window.__seriesRequest');
const firstStylesheet = html.search(/<link\s+rel="stylesheet"/);
assert(scriptAt !== -1 && firstStylesheet !== -1 && scriptAt < firstStylesheet, '미리 요청 스크립트는 첫 <link rel="stylesheet"> 앞에 있어야 함');

// ── ② index.html의 인라인 스크립트: 품목 번호가 주소에 있을 때만 정확히 한 번 요청한다
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((code) => code.includes('__seriesRequest'));
assert(inline, '미리 요청 인라인 스크립트를 찾지 못함');
const ID = 'f9941d3fa0b8253bb0b2567a29b1299f';
// vm 안에서 만든 객체는 프로토타입이 달라 deepStrictEqual이 거부하므로, 기록할 때 평범한 객체로 바꿔 둔다.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));
function runInline(hash: string, fetchImpl?: (url: string, options: unknown) => Promise<unknown>) {
  const calls: Array<{ url: string; options: unknown }> = [];
  const window: Record<string, any> = {};
  const fetch = (url: string, options: unknown) => { calls.push({ url, options: plain(options) }); return (fetchImpl ?? (async () => ({ ok: true })))(url, options); };
  vm.runInNewContext(inline!, { window, location: { hash }, fetch });
  return { calls, request: window.__seriesRequest };
}
{
  const r = runInline(`#${ID}`);
  assert.deepEqual(r.calls, [{ url: `data/series/${ID}.json`, options: { cache: 'no-cache' } }], '품목 번호가 있으면 그 시계열 파일을 한 번 요청');
  assert.equal(r.request.id, ID);
}
// 목록·비교·레전더리·잘못된 번호(길이·대문자·덧붙은 글자)에서는 요청하지 않는다
for (const hash of ['', '#', '#compare', `#compare?item=${ID}`, '#legendary-card', `#${ID.slice(1)}`, `#${ID}0`, `#${ID.toUpperCase()}`, `#${ID}x`, `#x${ID}`, `#${ID}/extra`]) {
  const r = runInline(hash);
  assert.deepEqual(r.calls, [], `${JSON.stringify(hash)}에서는 요청하지 않아야 함`);
  assert.equal(r.request, undefined);
}
// 미리 한 요청이 실패해도 '처리되지 않은 오류'가 되지 않는다(이어받기 전에 끝나 버리는 경우)
{
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  runInline(`#${ID}`, () => Promise.reject(new Error('network')));
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], '실패한 미리 요청이 처리되지 않은 거부로 남으면 안 됨');
}

// ── ③ app.js의 fetchSeries(): 같은 품목이면 한 번만 이어받고, 아니면 직접 요청한다
const code = app.match(/async function fetchSeries\(itemId\) \{[\s\S]*?\r?\n\}\r?\n/)?.[0];
assert(code, 'app.js에서 fetchSeries를 찾지 못함');
function load() {
  const calls: Array<{ url: string; options: unknown }> = [];
  const context: Record<string, any> = { fetch: async (url: string, options: unknown) => { calls.push({ url, options: plain(options) }); return { ok: true, from: 'own' }; } };
  vm.createContext(context);
  context.globalThis = context;
  const fetchSeries = vm.runInContext(`${code}; fetchSeries`, context) as (id: string) => Promise<any>;
  return { calls, context, fetchSeries };
}
const early = (id: string, response: Promise<unknown>) => { response.catch(() => {}); return { id, response }; };
{ // 같은 품목: 미리 한 응답을 이어받고 새로 요청하지 않는다. 이어받은 뒤에는 비워 같은 Response를 또 읽지 않게 한다.
  const t = load();
  t.context.__seriesRequest = early('a', Promise.resolve({ ok: true, from: 'early' }));
  assert.equal((await t.fetchSeries('a')).from, 'early');
  assert.deepEqual(t.calls, []);
  assert.equal(t.context.__seriesRequest, undefined);
  assert.equal((await t.fetchSeries('a')).from, 'own', '이미 이어받았으면 두 번째 호출은 직접 요청');
  assert.deepEqual(t.calls, [{ url: 'data/series/a.json', options: { cache: 'no-cache' } }]);
}
{ // 다른 품목: 미리 한 요청은 버리고 직접 요청한다.
  const t = load();
  t.context.__seriesRequest = early('b', Promise.resolve({ ok: true, from: 'early' }));
  assert.equal((await t.fetchSeries('a')).from, 'own');
  assert.deepEqual(t.calls, [{ url: 'data/series/a.json', options: { cache: 'no-cache' } }]);
  assert.equal(t.context.__seriesRequest, undefined, '다른 품목이어도 비워 둠');
}
{ // 미리 한 요청이 네트워크 오류: 직접 한 번 다시 요청한다.
  const t = load();
  t.context.__seriesRequest = early('a', Promise.reject(new Error('network')));
  assert.equal((await t.fetchSeries('a')).from, 'own');
  assert.equal(t.calls.length, 1);
}
{ // 미리 한 요청이 HTTP 오류(예: 404): 그 응답을 쓰지 않고 직접 요청한다.
  const t = load();
  t.context.__seriesRequest = early('a', Promise.resolve({ ok: false, status: 404 }));
  assert.equal((await t.fetchSeries('a')).from, 'own');
  assert.equal(t.calls.length, 1);
}
{ // 미리 한 요청이 없으면(홈에서 목록을 눌러 들어온 경우) 직접 요청한다.
  const t = load();
  assert.equal((await t.fetchSeries('a')).from, 'own');
  assert.deepEqual(t.calls, [{ url: 'data/series/a.json', options: { cache: 'no-cache' } }]);
}

console.log('상세 시계열 선요청 테스트 통과: 주소·옵션 일치 · 품목 번호일 때만 한 번 · 이어받기 · 다른 품목/실패/404는 직접 요청');
