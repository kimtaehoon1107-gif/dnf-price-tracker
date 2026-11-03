// 확정된 일회성 분석을 압축해 전달한다. 배포 때 통계 규칙을 다시 계산하지 않는다.
import assert from 'node:assert/strict';
export function eventStudyForItem(report:any, itemId:string) {
  assert.equal(report.exploratory,true);
  assert.equal(report.at,'2026-10-27T10:00:00.000Z');
  assert.equal(new Set(report.items.map((x:any)=>x.id)).size,38);
  const item=report.items.find((x:any)=>x.id===itemId);
  const compact=(c:any)=>({beforeHours:c.beforeHours,afterHours:c.afterHours,mode:c.mode,
    actual:c.actual?{pricePct:c.actual.pricePct,qtyPct:c.actual.qtyPct}:null,
    referenceCount:c.referenceCount,median:c.median,low:c.low,high:c.high,excessPp:c.excessPp,status:c.status});
  return {at:report.at,analyzedOn:'2026-11-03',sourceUrl:'https://df.nexon.com/community/news/notice/2928724',
    reportUrl:'https://github.com/kimtaehoon1107-gif/dnf-price-tracker/blob/main/docs/d-note-event-analysis-results-2026-11-03.md',
    inputHash:report.inputHash,comparisons:item?.comparisons.map(compact)??[],sensitivities:item?.sensitivities.map(compact)??[]};
}
