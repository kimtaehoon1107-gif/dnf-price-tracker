// 공개 자료 조회만 재시도한다. DB·R2 쓰기와 분석 계산은 재실행하지 않는다.
export async function fetchPublic(url: string, timeoutMs: number, options: RequestInit = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    if ((response.status < 500 && response.status !== 429) || attempt === 2) return response;
    await response.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  throw new Error('unreachable');
}
