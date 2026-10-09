// 아이템 시계열(data/series/<id>.json)을 상세 화면이 처음에 필요한 핵심 파일과, 패널이 보일 때 받는 호가 차이 파일로 나눈다.
// 압축 기준 한 아이템이 149KB였는데 askGap이 115KB, 화면이 읽지 않는 distribution.hourly가 24KB였다.
// 핵심 파일에는 build-inline-forecast.py·package-study.ts·record-daily-vwap.ts가 읽는 필드가 모두 남는다.

export interface AskGapRow { t: string; min_ask: number | null; vwap: number | null; gap: number }

export interface SplitSeries {
  /** data/series/<id>.json — askGap과 distribution.hourly를 뺀다. askGapCount가 있으면 별도 파일이 있다는 뜻이다. */
  core: Record<string, any>;
  /** data/series/<id>.askgap.json 의 내용. 행이 없으면 null(파일을 만들지 않는다). */
  askGapFile: { askGap: AskGapRow[] } | null;
}

/** 호가 차이 파일의 이름. web/app.js가 같은 이름으로 요청한다(scripts/test-series-split.ts가 대조). */
export const askGapPath = (itemId: string) => `${itemId}.askgap.json`;

export function splitSeries(series: Record<string, any>): SplitSeries {
  const askGap: AskGapRow[] = series.askGap ?? [];
  const core: Record<string, any> = {};
  for (const [key, value] of Object.entries(series)) {
    if (key === 'askGap') continue;
    if (key === 'distribution' && value) {
      // 첫 차트(일별 분위수)가 쓰는 daily와 asOf·minTrades만 남긴다. hourly(시간별 700여 행)는 화면이 읽지 않는다.
      const { hourly: _hourly, ...used } = value;
      core[key] = used;
    } else core[key] = value;
  }
  if (askGap.length) core.askGapCount = askGap.length;
  return { core, askGapFile: askGap.length ? { askGap } : null };
}
