const fmt = (n) => n === null || n === undefined ? '-' : Math.round(n).toLocaleString('ko-KR');
const won = (n) => n >= 1e8 ? `${(n / 1e8).toFixed(1)}억` : n >= 1e4 ? `${(n / 1e4).toFixed(0)}만` : fmt(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BASIS = {
  collected: ['연속수집', '수집기가 최근 24시간 동안 확인한 체결대금의 합입니다.'],
  api_complete: ['24h 조회', '최근 100건이 24시간 전체를 덮어 한 번의 조회로 합산했습니다.'],
  estimated: ['24h 환산', '최근 100건의 체결 속도와 거래대금을 24시간으로 환산한 추정치입니다.'],
};

// 100건이 덮은 시간을 24시간으로 늘린 배수. 같은 "환산"이라도 ×1.1과 ×266은
// 신뢰도가 전혀 다르므로 배지에 배수를 함께 적는다. 실측 두 종류는 null이다.
const factor = (row) => row.span_minutes > 0 ? 1440 / row.span_minutes : null;

// 100건이 거의 하루를 덮으면 배수가 1에 가깝다. 정수로 반올림하면 "×1"이 되어
// 오류처럼 보이므로 10 미만은 소수 한 자리까지 적는다.
const factorText = (value) => value >= 10 ? `×${Math.round(value)}` : `×${value.toFixed(1)}`;

// 이 배수를 넘으면 24시간의 5%(72분)도 관측하지 못한 것이라 따로 강조한다.
const WIDE_FACTOR = 20;

async function boot() {
  const response = await fetch('data/summary.json');
  if (!response.ok) throw new Error(`요약 데이터 HTTP ${response.status}`);
  const data = await response.json();
  const ranking = data.marketRanking;
  const rows = ranking?.items ?? [];
  const tracked = new Set(data.items.map((item) => item.item_id));
  const counts = rows.reduce((result, row) => {
    result[row.basis] = (result[row.basis] ?? 0) + 1;
    return result;
  }, {});
  const factors = rows.filter((row) => row.basis === 'estimated')
    .map(factor).filter((value) => value !== null).sort((a, b) => a - b);
  const minFactor = factors[0] ?? null;
  const maxFactor = factors.at(-1) ?? null;
  const captured = ranking?.capturedAt ? new Date(ranking.capturedAt) : null;
  document.getElementById('built').textContent = captured
    ? captured.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 기준'
    : '';

  document.getElementById('ranking-view').innerHTML = `
    <div class="ranking-title">
      <h1>24시간 거래대금 TOP100 <span class="tag g">시험 집계</span></h1>
      <p>옵션이 섞이지 않는 스태커블 아이템을 중심으로 거래대금을 비교합니다.</p>
    </div>

    <div class="cards">
      <div class="card"><div class="k">순위 아이템</div><div class="v">${rows.length}<small>종</small></div><div class="sub">거래대금 내림차순</div></div>
      <div class="card hl"><div class="k">연속수집</div><div class="v">${counts.collected ?? 0}<small>종</small></div><div class="sub">DB의 24시간 관측 합계</div></div>
      <div class="card"><div class="k">24h 완전조회</div><div class="v">${counts.api_complete ?? 0}<small>종</small></div><div class="sub">최근 100건이 하루를 모두 포함</div></div>
      <div class="card"><div class="k">24h 환산</div><div class="v">${counts.estimated ?? 0}<small>종</small></div><div class="sub">100건 체결 속도로 추정${maxFactor ? ` · 최대 ${factorText(maxFactor)}` : ''}</div></div>
    </div>

    ${rows.length ? `<div class="list ranking-list">
      <div class="ranking-lh">
        <span class="r">#</span><span>아이템</span><span class="r h-price">최근 체결가</span>
        <span class="r">거래대금</span><span class="r h-qty">관측 수량</span><span class="r">산정</span>
      </div>
      ${rows.map((row) => {
        const [label, description] = BASIS[row.basis];
        const times = factor(row);
        const tip = times === null ? description
          : `${description} 최근 100건이 ${row.span_minutes.toFixed(0)}분치라 ${factorText(times).slice(1)}배로 늘린 값입니다.`;
        const content = `
          <span class="rank r">${row.rank}</span>
          <span class="nm"><img src="${row.img}" alt="" loading="lazy" width="32" height="32"><span class="t"><b>${esc(row.item_name)}</b><span>${esc(row.item_rarity)} · ${esc(row.item_type_detail)} · 체결 ${fmt(row.trade_count)}건</span></span></span>
          <span class="px h-price">${fmt(row.last_price)}</span>
          <strong class="rank-turnover">${won(row.turnover_24h)}</strong>
          <span class="dim h-qty">${fmt(row.observed_qty)}</span>
          <span class="basis-tag ${row.basis}${times !== null && times > WIDE_FACTOR ? ' wide' : ''}" title="${esc(tip)}">${label}${times === null ? '' : ` ${factorText(times)}`}</span>`;
        return tracked.has(row.item_id)
          ? `<a class="ranking-row" href="index.html#${row.item_id}">${content}</a>`
          : `<div class="ranking-row">${content}</div>`;
      }).join('')}
    </div>` : '<div class="panel"><h3>아직 순위 데이터가 없습니다</h3><p class="desc">다음 시장 탐색이 끝나면 표시됩니다.</p></div>'}

    <div class="note ranking-note">
      <b>순위의 범위</b><br>
      장비·아바타·카드는 같은 아이템 ID 안에서 옵션이나 업그레이드 단계가 섞이므로 전수 탐색에서 제외했습니다.
      기존 시세 페이지에서 별도로 검증해 수집 중인 품목은 함께 포함합니다.<br><br>
      <b>거래대금의 한계</b><br>
      연속수집과 24h 조회도 API가 반환하지 않은 체결은 복원할 수 없어 실제 거래대금의 하한값입니다.
      <b>24h 환산</b>은 최근 거래 속도가 하루 동안 같았다고 가정한 탐색용 추정치이므로 정확한 회계값으로 보면 안 됩니다.
      ${minFactor && maxFactor ? `환산 배수는 종목마다 달라 현재 <b>${factorText(minFactor)}</b>에서 <b>${factorText(maxFactor)}</b>까지이며,
      배수가 클수록 관측 구간이 짧아 오차가 큽니다. ×${WIDE_FACTOR}을 넘는 종목은 배지를 진하게 표시했습니다.` : ''}
    </div>`;
}

boot().catch((error) => {
  console.error(error);
  document.getElementById('ranking-view').innerHTML = '<div class="panel"><h3>순위를 불러오지 못했습니다</h3><p class="desc">잠시 뒤 다시 시도해 주세요.</p></div>';
});
