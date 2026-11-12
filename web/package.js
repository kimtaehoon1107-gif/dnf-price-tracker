const fmt = n => Math.round(n).toLocaleString('ko-KR');
const gold = n => n == null ? '계산 대기' : `${fmt(n)} 골드`;
const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

export function bunnyPackagePanelHTML(margin) {
  if (!margin) return '';
  const [body, ...parts] = margin.items;
  const partsSum = parts.length === 3 && parts.every(part => part.vwap > 0)
    ? parts.reduce((sum, part) => sum + part.vwap, 0) : null;
  const difference = partsSum !== null && body.vwap > 0
    ? partsSum * (1 - margin.fee) - body.vwap : null;
  const percent = difference === null ? '' : ` (${difference >= 0 ? '+' : ''}${(100 * difference / body.vwap).toFixed(2)}%)`;
  return `<section class="panel pkg-overview" aria-label="바니바니 패키지 해체 마진">
    <div class="pkg-heading"><h3>바니바니 윈터 아라드 패키지 해체 마진</h3><a href="https://df.nexon.com/community/news/seriashop/671">공식 구성 보기 →</a></div>
    <div class="pkg-stats">
      <div><span>패키지 가격</span><strong>${gold(body.vwap)}</strong></div>
      <div><span>구성 상자 3종 합계</span><strong>${gold(partsSum)}</strong></div>
      <div><span>수수료 3% 반영 해체 마진</span><strong>${gold(difference)}${percent}</strong></div>
    </div>
    <ul class="hint">${margin.items.map(item => `<li><a href="index.html#${encodeURIComponent(item.id)}">${escapeHTML(item.name)}</a> · ${gold(item.vwap)} · 체결 ${fmt(item.n)}건</li>`).join('')}</ul>
    <p class="hint">최근 24시간에 수집된 체결의 수량가중평균입니다. 본체와 구성 상자 3종이 모두 관측되면 계산합니다. 첫 수집 이전 체결은 일부만 포함될 수 있습니다.</p>
  </section>`;
}

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
