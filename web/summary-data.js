let pending;
export function loadSummary() {
  return pending ??= fetch('data/summary.json', { cache: 'no-cache' }).then(response => {
    if (!response.ok) throw new Error('요약 데이터 HTTP ' + response.status);
    return response.json();
  }).catch(error => { pending = undefined; throw error; });
}
