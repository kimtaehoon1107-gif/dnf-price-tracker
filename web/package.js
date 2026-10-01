const fmt = n => Math.round(n).toLocaleString('ko-KR');
const gold = n => n == null ? '계산 대기' : `${fmt(n)} 골드`;

export function packagePanelHTML(data) {
  const margin = data.margin;
  const complete = margin?.partsComplete && margin.pkg > 0;
  const net = complete ? margin.partsSum * (1 - margin.fee) : null;
  return `<section class="panel pkg-overview" aria-label="유랑악단 패키지 해체 마진">
    <div class="pkg-heading"><h3>유랑악단 패키지 해체 마진</h3><a href="research.html#package">가격 추이·이벤트 관측 →</a></div>
    <div class="pkg-stats">
      <div><span>패키지 가격</span><strong>${gold(margin?.pkg)}</strong></div>
      <div><span>구성 상자 5종 합계</span><strong>${gold(margin?.partsComplete ? margin.partsSum : null)}</strong></div>
      <div><span>수수료 3% 반영 차이</span><strong>${gold(complete ? net - margin.pkg : null)}</strong></div>
    </div>
    <p class="hint">최근 24시간 체결의 수량가중평균입니다. 구성 상자 5종이 모두 관측될 때 계산하며, 같은 시점에 사고팔 수 있는 차익을 뜻하지 않습니다.</p>
  </section>`;
}
