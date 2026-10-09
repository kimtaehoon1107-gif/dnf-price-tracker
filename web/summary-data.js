let pending;
export function loadSummary() {
  // index.html이 <head>에서 미리 시작해 둔 요청이 있으면 한 번만 이어받는다. 모듈 체인이 끝나기를 기다리지 않아 데이터가 먼저 도착한다.
  // 요청 옵션은 index.html과 같아야 한다(scripts/test-module-preload.ts가 대조한다).
  const early = globalThis.__summaryRequest;
  globalThis.__summaryRequest = undefined;
  return pending ??= (early ?? fetch('data/summary.json', { cache: 'no-cache' })).then(response => {
    if (!response.ok) throw new Error('요약 데이터 HTTP ' + response.status);
    return response.json();
  }).catch(error => { pending = undefined; throw error; });
}
