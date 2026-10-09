import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// index.html은 app.js가 정적으로 불러오는 모듈을 <link rel="modulepreload">로 미리 받고, 요약 데이터 요청을 <head>에서 먼저 시작한다.
// 이 목록이 실제 import 그래프와 어긋나면 브라우저가 같은 파일을 두 번 받거나(주소가 다를 때) 체인이 다시 길어지므로 여기서 막는다.

const html = readFileSync('web/index.html', 'utf8');

// 모듈 하나가 정적으로 가져오는 주소들. 동적 import()는 지연 로딩이라 미리 받지 않는다.
function staticImports(file: string): string[] {
  const source = readFileSync(`web/${file}`, 'utf8');
  const found: string[] = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) found.push(m[1]);
  return found.map((specifier) => specifier.replace(/^\.\//, ''));
}

// 진입 모듈에서 닿는 모든 모듈(진입 자신은 제외). 키는 ?v= 까지 포함한 주소 그대로다.
function graph(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const url = queue.shift()!;
    for (const dep of staticImports(url.split('?')[0])) if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
  }
  return seen;
}

const entries = [...html.matchAll(/<script\s+type="module"\s+src="([^"]+)"/g)].map((m) => m[1]);
assert(entries.length > 0, 'index.html에 모듈 진입 스크립트가 있어야 함');
const entryFiles = new Set(entries);
const needed = graph(entries);
for (const entry of entryFiles) needed.delete(entry); // 진입 스크립트는 <script>가 직접 받는다
const preloaded = new Set([...html.matchAll(/<link\s+rel="modulepreload"\s+href="([^"]+)"/g)].map((m) => m[1]));

const missing = [...needed].filter((url) => !preloaded.has(url));
const extra = [...preloaded].filter((url) => !needed.has(url));
assert.deepEqual(missing, [], `index.html에 modulepreload가 없는 모듈: ${missing.join(', ')} — import 주소(?v= 포함)를 그대로 추가하세요`);
assert.deepEqual(extra, [], `import 그래프에 없거나 ?v= 값이 다른 modulepreload: ${extra.join(', ')} — import 문과 같은 주소로 맞추세요`);

// 요약 데이터 요청: index.html의 선요청과 summary-data.js가 같은 요청이어야 이어받아도 신선도 의미가 바뀌지 않는다.
const request = "fetch('data/summary.json', { cache: 'no-cache' })";
const summarySource = readFileSync('web/summary-data.js', 'utf8');
assert(html.includes(request), `index.html의 선요청이 ${request} 이어야 함`);
assert(summarySource.includes(request), `summary-data.js의 요청이 ${request} 이어야 함`);
assert(html.includes('window.__summaryRequest') && summarySource.includes('__summaryRequest'), '선요청을 넘기고 받는 이름(__summaryRequest)이 같아야 함');

// 선요청 스크립트가 스타일시트보다 뒤에 있으면 브라우저가 CSS가 다 올 때까지 실행을 미뤄 선요청의 의미가 사라진다.
const earlyScript = html.indexOf('window.__summaryRequest');
const firstStylesheet = html.search(/<link\s+rel="stylesheet"/);
assert(earlyScript !== -1 && firstStylesheet !== -1 && earlyScript < firstStylesheet, '선요청 스크립트는 첫 <link rel="stylesheet"> 앞에 있어야 함');

// loadSummary: 선요청이 있으면 한 번만 이어받고, 없거나 실패하면 직접 요청한다.
const calls: string[] = [];
let failFirst = false;
const original = { fetch: globalThis.fetch, early: (globalThis as any).__summaryRequest };
globalThis.fetch = (async (url: string, options: any) => {
  calls.push(`${url} ${options?.cache}`);
  if (failFirst) { failFirst = false; throw new Error('network'); }
  return { ok: true, json: async () => ({ items: [], from: 'own-fetch' }) };
}) as any;
try {
  const { loadSummary } = await import(`../web/summary-data.js?adopt=${Date.now()}`);
  (globalThis as any).__summaryRequest = Promise.resolve({ ok: true, json: async () => ({ items: [], from: 'early' }) });
  assert.equal((await loadSummary()).from, 'early', '선요청이 있으면 그 응답을 이어받음');
  assert.deepEqual(calls, [], '이어받으면 새로 요청하지 않음');
  assert.equal((globalThis as any).__summaryRequest, undefined, '이어받은 뒤에는 비워 다른 호출이 같은 Response를 또 읽지 않게 함');
  assert.equal((await loadSummary()).from, 'early', '이미 받은 결과는 그대로 공유(chat.js와 app.js가 한 요청을 나눠 씀)');

  const second = await import(`../web/summary-data.js?own=${Date.now()}`);
  assert.equal((await second.loadSummary()).from, 'own-fetch', '선요청이 없으면 직접 요청');
  assert.deepEqual(calls, ['data/summary.json no-cache'], '직접 요청도 같은 옵션(no-cache)');

  const third = await import(`../web/summary-data.js?fail=${Date.now()}`);
  (globalThis as any).__summaryRequest = Promise.reject(new Error('early network'));
  await assert.rejects(third.loadSummary(), /early network/, '선요청이 실패하면 호출한 쪽에 실패로 전달');
  assert.equal((await third.loadSummary()).from, 'own-fetch', '실패한 뒤 다시 부르면 직접 요청해 복구');
} finally {
  globalThis.fetch = original.fetch;
  (globalThis as any).__summaryRequest = original.early;
}
console.log('모듈 미리받기 목록·요약 선요청 이어받기·실패 복구 테스트 통과');
