import { esc, fmt, timeText, plot, renderForecast } from './research-ui.js?v=20260920-data';

let data, disposers = [];
const view = document.getElementById('view');
const clearCharts = () => { disposers.forEach((f) => f()); disposers = []; };
const signed = (v, unit = '%') => v == null ? '관측 대기' : `${v >= 0 ? '+' : ''}${fmt(v, 2)}${unit}`;

// 화면 정리 기준: 기본 목록에는 구성 4종 이상인 지수만 둔다. 1~3종 구성은 개별 아이템의 흐름에 가깝다.
// 구성과 사전 예측 기록은 그대로 두며 "소수 구성도 보기"로 언제든 연다.
const MIN_MEMBERS = 4;
let showSmall = false;

function groups() {
  const all = data.series.filter((s) => s.basket);
  const small = all.filter((s) => s.basket.members.length < MIN_MEMBERS);
  const selected = location.hash.split('/')[1];
  // 링크로 소수 구성을 직접 열었으면 목록에서도 보여 준다.
  if (small.some((g) => g.id === selected)) showSmall = true;
  const groups = showSmall ? all : all.filter((s) => s.basket.members.length >= MIN_MEMBERS);
  const s = groups.find((g) => g.id === selected) ?? groups[0];
  const b = s.basket, lastDay = s.daily.at(-1), lastValid = s.daily.filter((p) => p.value != null).at(-1);
  const basis = { trade: '일별 체결 VWAP', ask0: '0업 일평균 최저호가', askMax: '맥스업 일평균 최저호가' }[b.basis];
  view.innerHTML = `<label class="research-label" for="group-select">비교할 종류</label>
    <select id="group-select" class="research-select">${groups.map((g) => `<option value="${g.id}" ${g.id === s.id ? 'selected' : ''}>${esc(g.label)} · ${g.basket.members.length}종</option>`).join('')}</select>
    ${small.length ? `<p class="hint">화면 정리를 위해 기본 목록에는 구성 ${MIN_MEMBERS}종 이상인 지수만 표시합니다.
      <button type="button" class="link-btn" id="toggle-small">${showSmall ? '기본 목록으로' : `소수 구성 ${small.length}개도 보기`}</button>
      (${small.map((g) => `${esc(g.label)} ${g.basket.members.length}종`).join(' · ')}) 소수 구성도 발행·평가 기록은 그대로 보존합니다.</p>` : ''}
    <section class="panel"><h3>구성이 고정된 ${esc(s.label)} 지수</h3>
      <p class="desc">${esc(basis)} · 기준 주간 ${esc(b.baseDate)}의 각 종목 평균을 100으로 환산한 뒤 동일 비중으로 평균합니다.</p>
      <div class="kv research-kv"><div><div class="k">최근 유효 지수 · ${esc(lastValid?.d ?? '없음')}</div><div class="v">${fmt(lastValid?.value, 2)}</div></div>
        <div><div class="k">${esc(lastDay?.d ?? '')} 관측 구성종목</div><div class="v">${lastDay?.coverage ?? 0}<small> / ${b.members.length}종</small></div></div></div>
      <p class="hint">${b.members.length < MIN_MEMBERS ? `구성이 ${b.members.length}종이라 개별 아이템의 흐름에 가깝습니다. ` : ''}매일 동일한 종목을 비교하며 하나라도 관측이 없으면 그날 지수는 공백입니다.
        ${b.basis === 'trade' ? '무거래일·수집 누락은 보간하지 않습니다. 적은 체결로 계산된 일평균도 포함됩니다.' : '카드 호가는 시간별 마지막 관측을 평균하며 하루 18시간 이상이어야 사용합니다.'}
        2026-09-16에 정한 구성을 과거에도 적용한 설명용 지수입니다. 당시 시장 전체를 재현한 지수나 과거 투자 성과가 아닙니다.</p>
    </section>
    <section class="panel" id="group-forecast"></section>
    <section class="panel"><h3>구성 아이템별 흐름</h3><p class="desc">등급·종류별 움직임이 같은 방향인지 비교합니다. 선택한 아이템도 자신의 기준 주간 평균이 100입니다.</p>
      <label for="member-select" class="research-label">비교할 구성 아이템</label>
      <select id="member-select" class="research-select">${s.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
      <div class="stock-legend"><span>● 전체 지수</span><span style="color:#307be8">● 선택한 아이템</span></div><div id="member-chart" class="chart"></div>
      <details class="research-details"><summary>고정 구성 ${b.members.length}종 · 제외 ${b.excluded?.length ?? 0}종과 기준 가격</summary>
        <div class="table-scroll"><table><thead><tr><th>아이템</th><th>기준 주간 평균</th><th>기준 관측일</th></tr></thead><tbody>
          ${b.members.map((m) => `<tr><th><a href="index.html#${m.id}">${esc(m.name)}</a></th><td>${fmt(m.base, 0)} 골드</td><td>${m.baseDays}일</td></tr>`).join('')}
        </tbody></table></div>${(b.excluded ?? []).map((m) => `<p>${esc(m.name)}: ${esc(m.reason)}</p>`).join('')}
        <p class="hint">기준 주간에 유효 관측 3일 이상인 종목으로 고정했습니다. 신규 종목은 자동 편입하지 않습니다. 종결 교체 시에는 새 버전 지수로 분리해야 합니다.</p>
      </details></section>`;
  document.getElementById('group-select').onchange = (e) => { location.hash = `groups/${e.target.value}`; };
  const toggle = document.getElementById('toggle-small');
  if (toggle) toggle.onclick = () => {
    showSmall = !showSmall;
    if (!showSmall && small.some((g) => g.id === selected)) location.hash = 'groups';
    else render();
  };
  disposers.push(renderForecast(document.getElementById('group-forecast'), s, data));
  let disposeMember;
  const draw = () => {
    disposeMember?.();
    const member = s.members.find((m) => m.id === document.getElementById('member-select').value);
    disposeMember = plot(document.getElementById('member-chart'), [
      { label: s.label, color: '#27364b', points: s.daily.slice(-90) },
      { label: member.name, color: '#307be8', points: member.daily.slice(-90) },
    ]);
  };
  document.getElementById('member-select').onchange = draw;
  draw();
  disposers.push(() => disposeMember?.());
}

function packageStudy() {
  const p = data.package;
  if (!p.event) { view.innerHTML = '<div class="panel">연결된 패키지 이벤트가 없습니다.</div>'; return; }
  const labels = { price: '패키지 체결 VWAP', parts: '구성품 5종 합계', margin: '수수료 반영 해체 마진', qty: 'API 관측 체결 수량', stock: '관측 매물 잔량', benchmark: p.benchmark };
  view.innerHTML = `<section class="panel"><h3>${esc(p.event.name)} · 이벤트 관측</h3>
    <p class="desc">출시 ${esc(p.event.starts)} · 판매 종료 ${esc(p.event.ends)} · 완료 일봉 첫 관측 ${esc(p.firstObserved ?? '없음')}</p>
    <p>출시 전 가격이 없어 출시 충격은 계산할 수 없습니다. 판매 종료는 예정된 사건이므로 종료 전부터 가격이 움직일 수 있습니다.</p>
    <p class="hint">전 7일(-7~-1)과 이후 7일(0~+6)을 달력 날짜로 비교합니다. 양쪽 7일을 모두 관측해야 변화율을 계산합니다.
      관측 전후 차이이며, 다른 패치·공급 변화·요일 효과를 제거한 인과효과 추정은 아닙니다.</p>
    <a href="${esc(p.event.source_url)}" target="_blank" rel="noopener">공식 판매 공지 ↗</a>
    <label class="research-label" for="stage-select">비교할 사건</label>
    <select class="research-select" id="stage-select">${p.stages.map((s, i) => `<option value="${i}" ${s.label === '판매 종료' ? 'selected' : ''}>${s.label} · ${s.date}</option>`).join('')}</select>
    <div id="event-window"></div>
  </section>
  <section class="panel"><h3>패키지와 구성품 가격</h3><p class="desc">패키지 체결 VWAP과 구성품 5종의 일별 VWAP 합계입니다. 다섯 가격이 모두 있는 날에만 합산합니다.</p>
    <div class="stock-legend"><span>● 패키지</span><span style="color:#bb7820">● 구성품 합계</span></div><div id="package-price" class="chart"></div>
    <label class="research-label" for="part-select">구성품 개별 가격</label><select class="research-select" id="part-select">${p.components.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
    <div id="part-chart" class="chart"></div>
  </section>
  <section class="panel"><h3>관측 가격 기준 해체 마진</h3><p class="desc">(구성품 합계 × 0.97 ÷ 패키지 가격 − 1) × 100. 같은 날에도 체결 시점이 다르고 현재 매물·실제 판매 가능성을 반영하지 않아 실행 가능한 차익을 뜻하지 않습니다.</p><div id="package-margin" class="chart"></div></section>
  <section class="panel"><h3>API 관측 수량과 매물 잔량</h3><p class="desc">파랑은 하루 관측 체결 수량, 회색은 시간별 마지막 매물 잔량의 일평균입니다. 잔량은 하루 18시간 이상 관측한 날만 표시합니다. 신규 등록량·전체 거래량이 아니며 두 값을 합산하지 않습니다.</p><div id="package-qty" class="chart"></div></section>
  <section class="panel"><h3>다른 품목과의 비교</h3><p class="desc">패키지와 소울 결정 지수를 두 값이 모두 있는 첫날 100으로 맞췄습니다. 소울 결정 6종은 패키지·구성품을 포함하지 않지만 시장 전체를 대표하거나 적절한 인과 비교군임을 보장하지 않습니다.</p><div id="package-context" class="chart"></div></section>`;
  const renderStage = () => {
    const s = p.stages[Number(document.getElementById('stage-select').value)];
    const w = s.metrics.price;
    document.getElementById('event-window').innerHTML = `<p><b>${s.label}</b> 전 ${w.preFrom} ~ ${w.preTo} / 이후 ${w.postFrom} ~ ${w.postTo}</p>
      <div class="table-scroll"><table><thead><tr><th>관측 항목</th><th>전 / 후 관측일</th><th>전 평균</th><th>후 평균</th><th>변화</th></tr></thead><tbody>
      ${Object.entries(s.metrics).map(([key, m]) => `<tr><th>${labels[key]}</th><td>${m.preN}/7 · ${m.postN}/7</td><td>${fmt(m.pre, 2)}</td><td>${fmt(m.post, 2)}</td><td>${key === 'margin' ? signed(m.ready ? m.post - m.pre : null, '%p') : signed(m.change)}</td></tr>`).join('')}
      ${s.components.map((c) => `<tr><th>${esc(c.name)}</th><td>${c.preN}/7 · ${c.postN}/7</td><td>${fmt(c.pre, 0)}</td><td>${fmt(c.post, 0)}</td><td>${signed(c.change)}</td></tr>`).join('')}
      </tbody></table></div><p class="hint">${s.date < p.firstObserved ? '사건이 관측 시작 전이라 이전 가격을 복원할 수 없습니다.' : !w.ready ? '예정된 비교 기간 또는 관측이 아직 완성되지 않았습니다. 조건 충족 시 자동 계산합니다.' : '기간 전체 관측을 충족했습니다. 전후 차이를 사건의 영향으로 단정하지 않습니다.'}</p>`;
  };
  document.getElementById('stage-select').onchange = renderStage;
  renderStage();
  const points = (key) => p.daily.map((r) => ({ d: r.d, value: r[key] }));
  disposers.push(plot(document.getElementById('package-price'), [
    { label: '패키지', color: '#27364b', points: points('price') }, { label: '구성품 합계', color: '#bb7820', points: points('parts') },
  ], '골드'));
  disposers.push(plot(document.getElementById('package-margin'), [{ label: '해체 마진', color: '#27364b', points: points('margin') }], '%'));
  disposers.push(plot(document.getElementById('package-qty'), [
    { label: '관측 체결 수량', color: '#307be8', points: points('qty') }, { label: '관측 매물 잔량', color: '#8a94a3', points: points('stock') },
  ], '개'));
  const base = p.daily.find((d) => d.price > 0 && d.benchmark > 0);
  if (base) disposers.push(plot(document.getElementById('package-context'), ['price', 'benchmark'].map((key, i) => ({
    label: i ? p.benchmark : '패키지', color: i ? '#307be8' : '#27364b', points: p.daily.filter((d) => d.d >= base.d).map((d) => ({ d: d.d, value: d[key] === null ? null : d[key] / base[key] * 100 })),
  }))));
  else document.getElementById('package-context').textContent = '공통 관측일을 기다리고 있습니다.';
  let disposePart;
  const drawPart = () => {
    disposePart?.();
    const c = p.components.find((c) => c.id === document.getElementById('part-select').value);
    disposePart = plot(document.getElementById('part-chart'), [{ label: c.name, color: '#307be8', points: c.daily }], '골드');
  };
  document.getElementById('part-select').onchange = drawPart;
  drawPart(); disposers.push(() => disposePart?.());
}

function render() {
  if (!data) return;
  clearCharts();
  const pkg = location.hash === '#package';
  document.querySelectorAll('.research-tabs a').forEach((a) => a.classList.toggle('on', a.hash === (pkg ? '#package' : '#groups')));
  if (pkg) packageStudy(); else groups();
}
try {
  const response = await fetch('data/research.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('데이터 응답 실패');
  data = await response.json();
  document.getElementById('built').textContent = `${timeText(data.asOf)} KST 기준`;
  render();
  addEventListener('hashchange', render);
} catch (error) {
  clearCharts();
  view.innerHTML = '<div class="panel">분석 데이터를 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.</div>';
  console.error(error);
}
