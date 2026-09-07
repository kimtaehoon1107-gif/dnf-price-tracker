// Neople 오픈 API 클라이언트
//
// 아래 응답 타입은 공식 문서에 예제가 없어 실제 호출로 확인한 것이다 (2026-09-07).
// 문서에 없는 필드가 있으므로, 스키마를 바꾸기 전에 반드시 실제 응답을 다시 찍어볼 것.

const BASE = 'https://api.neople.co.kr/df';

/** /df/auction-sold 한 행. auctionNo가 없다는 점이 중복 제거 설계를 결정한다. */
export interface SoldRow {
  soldDate: string;            // "2026-09-07 01:29:20" (KST)
  itemId: string;
  itemName: string;
  itemRarity: string;
  itemTypeDetail: string;
  refine: number;
  reinforce: number;
  amplificationName: string | null;
  count: number;
  price: number;               // 총액
  unitPrice: number;           // 개당가 — 모든 지표는 이 값 기준
}

/** /df/auction 한 행. regCount와 count가 따로 오므로 부분 판매를 추적할 수 있다. */
export interface AuctionRow {
  auctionNo: number;
  regDate: string;             // KST
  expireDate: string;          // KST, 등록 24시간 후
  itemId: string;
  itemName: string;
  itemRarity: string;
  refine: number;
  reinforce: number;
  amplificationName: string | null;
  count: number;               // 잔여 수량
  regCount: number;            // 최초 등록 수량
  unitPrice: number;
  currentPrice: number;
  averagePrice: number;
}

export interface ItemRow {
  itemId: string;
  itemName: string;
  itemRarity: string;
  itemTypeDetail: string;
}

/** API가 돌려주는 KST 시각 문자열을 ISO 8601 UTC로 바꾼다. */
export function kstToIso(kst: string): string {
  return new Date(`${kst.replace(' ', 'T')}+09:00`).toISOString();
}

function apiKey(): string {
  const key = process.env.NEOPLE_API_KEY;
  if (!key) throw new Error('NEOPLE_API_KEY가 없습니다. .env 파일을 확인하세요.');
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(path: string, params: Record<string, string | number>): Promise<T[]> {
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    apikey: apiKey(),
  });
  const url = `${BASE}${path}?${qs}`;

  // 초당 1,000건 제한 대비 우리 호출량은 무시할 수준이라 레이트 제한은 걸릴 일이 없다.
  // 재시도는 순전히 일시적 네트워크·서버 오류를 위한 것.
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      const body = (await res.json()) as { rows?: T[] };
      return body.rows ?? [];
    }

    // 4xx는 우리 잘못이므로 재시도해도 같은 답이 온다
    if (res.status < 500 && res.status !== 429) {
      throw new Error(`${path} → ${res.status} ${await res.text()}`);
    }
    if (attempt === 3) throw new Error(`${path} → ${res.status} (재시도 4회 실패)`);
    await sleep(1000 * 2 ** attempt);
  }
  throw new Error('unreachable');
}

/** 최근 체결 내역. 최대 100건 또는 최대 1개월치만 돌아온다. */
export const getSold = (itemId: string, limit = 100) =>
  request<SoldRow>('/auction-sold', { itemId, limit });

/** 현재 등록된 매물. 최대 400건. */
export const getAuction = (itemId: string, limit = 400) =>
  request<AuctionRow>('/auction', { itemId, limit, sort: 'unitPrice:asc' });

/** 아이템 마스터 검색. wordType: match(동일 단어) | front(앞 단어) | full(전문) */
export const searchItems = (itemName: string, wordType = 'match', limit = 20) =>
  request<ItemRow>('/items', { itemName, wordType, limit });
