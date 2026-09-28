const DAY = 86400000, HOUR = 3600000;
const fmt = n => n == null ? '—' : Math.round(n).toLocaleString('ko-KR');
const kstDay = t => new Date(t + 9 * HOUR).toISOString().slice(0, 10);
const startDay = d => Date.parse(`${d}T00:00:00+09:00`);
const md = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const hh = t => `${String(new Date(t + 9 * HOUR).getUTCHours()).padStart(2, '0')}:00`;

// 달력상의 빈 구간을 실제 행으로 유지해야 직선이 결측을 가로지르지 않는다.
export function distributionRows(data, period = 30, date = null) {
  if (!data?.daily?.length) return [];
  const asOf = Date.parse(data.asOf), today = kstDay(asOf);
  const start = date ? startDay(date) : Math.max(startDay(data.daily[0].d),
    period === 'all' ? -Infinity : startDay(today) - (period - 1) * DAY);
  const end = date ? Math.min(start + DAY, asOf) : startDay(today) + DAY;
  const step = date ? HOUR : DAY;
  const source = new Map((date ? data.hourly : data.daily).map(r => [date ? Date.parse(r.t) : startDay(r.d), r]));
  const result = [];
  for (let t = start; t < end; t += step) {
    const r = source.get(t);
    result.push({ ...r, time: t, d: kstDay(t), partial: t + step > asOf,
      state: !r ? 'missing' : r.median == null ? 'unavailable' : r.n < data.minTrades ? 'sparse' : 'ready' });
  }
  return result;
}

export function distributionSegments(rows) {
  const segments = []; let current = [];
  for (const r of rows) {
    if (r.state !== 'ready') { if (current.length) segments.push(current); current = []; }
    else current.push(r);
  }
  if (current.length) segments.push(current);
  return segments;
}

let cleanup = () => {};
export function disposePriceDistribution() { cleanup(); cleanup = () => {}; }

export function renderPriceDistribution(root, data, events = []) {
  disposePriceDistribution();
  if (!data?.daily?.length) { root.textContent = '체결 분포 자료가 없습니다.'; return; }
  root.className = 'price-distribution';
  root.innerHTML = `<div class="pd-toolbar"><div class="pd-periods" aria-label="조회 기간">
    <button type="button" data-period="7">7일</button><button type="button" data-period="30">30일</button><button type="button" data-period="all">전체</button></div><span class="pd-extent"></span></div>
    <div class="pd-drill" hidden><button type="button" class="pd-back">← 기간 보기</button><label>날짜 <select class="pd-date" aria-label="상세 날짜"></select></label></div>
    <div class="pd-readout"><div><span class="pd-selected"></span><div class="pd-price"></div><div class="pd-range"></div></div><div class="pd-qty"></div></div>
    <div class="pd-legend"><span><i class="pd-line-key"></i>수량 가중 중앙값</span><span><i class="pd-band-key"></i>주요 거래 가격대</span><span>○ 체결 5건 미만</span></div>
    <div class="pd-plot"></div><div class="pd-events"></div>
    <div class="pd-select"><label><span class="pd-unit">날짜</span> <select class="pd-point" aria-label="확인할 구간"></select></label><button type="button" class="pd-open">이 날짜 시간별 보기 →</button></div>
    <div class="pd-status" aria-live="polite"></div>
    <details class="pd-help"><summary>주요 거래 가격대란?</summary><p>관측한 체결을 개당 가격순으로 놓고, 누적 수량이 25%와 75%에 도달하는 가격을 표시합니다. 가운데 50%에 해당하는 가격 구간이며 동일 가격에 거래가 몰리면 포함 수량은 더 많을 수 있습니다. 미래 가격의 예측 범위가 아닙니다. 체결 5건 미만은 표시 기준상 점만 남기며, 5건 이상이라고 통계적 신뢰성을 보장하지 않습니다.</p></details>
    <details class="pd-raw"><summary>원본 고가·저가와 평균 확인</summary><p></p></details>
    <p class="hint">API 관측 수량은 전체 거래량의 하한입니다. 빈 구간은 체결 관측이 없으며 무거래와 수집 공백을 구분할 수 없습니다. 원본이 불완전한 과거 구간은 분포를 표시하지 않습니다.</p>`;
  const $ = s => root.querySelector(s);
  const state = { period: 30, date: null, selected: null };
  const dates = distributionRows(data, 'all').map(r => r.d);
  $('.pd-date').innerHTML = dates.map(d => `<option value="${d}">${d}</option>`).join('');
  let rows = [], positions = new Map();
  function info(r, announce = false) {
    state.selected = r.time;
    $('.pd-selected').textContent = `${r.d}${state.date ? ` ${hh(r.time)} KST` : ''}${r.partial ? ' · 수집 중' : ''}`;
    $('.pd-price').textContent = r.median == null ? '—' : `${fmt(r.median)} 골드`;
    $('.pd-range').textContent = r.state === 'ready' ? `주요 거래 가격대 ${fmt(r.q25)}–${fmt(r.q75)}`
      : r.state === 'sparse' ? `체결 ${fmt(r.n)}건 · 가격점만 표시` : r.state === 'unavailable' ? '원본 불완전 · 분포 자료 없음' : '체결 관측 없음';
    $('.pd-qty').textContent = r.n == null ? '관측 수량 미확인' : `관측 ${fmt(r.qty)}개 · ${fmt(r.n)}건`;
    $('.pd-point').value = String(r.time);
    $('.pd-raw p').textContent = r.n == null ? '관측 자료 없음' : `최저 ${fmt(r.l)} · 최고 ${fmt(r.h)} · VWAP ${fmt(r.vwap)} 골드`;
    if (announce) $('.pd-status').textContent = `${$('.pd-selected').textContent} · ${$('.pd-range').textContent}`;
    const pos = positions.get(r.time), guide = $('.pd-guide');
    if (pos && guide) {
      guide.setAttribute('x1', pos.x); guide.setAttribute('x2', pos.x);
      const dot = $('.pd-active'); dot.setAttribute('cx', pos.x); dot.setAttribute('cy', pos.y ?? 0);
      dot.setAttribute('opacity', r.median == null ? 0 : 1);
      dot.setAttribute('fill', r.state === 'sparse' ? 'var(--card)' : 'var(--blue)');
    }
  }
  function draw() {
    rows = distributionRows(data, state.period, state.date);
    if (!rows.length) return;
    root.querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-pressed', String(!state.date && String(state.period) === b.dataset.period)));
    $('.pd-drill').hidden = !state.date; $('.pd-open').hidden = !!state.date;
    $('.pd-unit').textContent = state.date ? '시간' : '날짜';
    $('.pd-extent').textContent = state.date ? `${state.date} · 시간별` : `${rows[0].d}–${rows.at(-1).d} · 일별`;
    if (state.date) $('.pd-date').value = state.date;
    $('.pd-point').innerHTML = rows.map(r => `<option value="${r.time}">${state.date ? hh(r.time) : md(r.d)}${r.state === 'missing' ? ' · 관측 없음' : ''}</option>`).join('');
    const box = $('.pd-plot'), width = box.clientWidth;
    if (width < 100) return;
    const L = 68, R = 14, T = 28, B = 228, V = 308, H = 340;
    const x = i => L + (i + .5) * (width - L - R) / rows.length;
    const prices = rows.flatMap(r => r.median == null ? [] : r.state === 'ready' ? [r.q25,r.q75,r.median] : [r.median]);
    const lo = prices.length ? Math.min(...prices) : 0, hi = prices.length ? Math.max(...prices) : 1;
    const pad = Math.max((hi-lo)*.15, hi*.002, 1), y = p => B - (p-lo+pad)/(hi-lo+2*pad)*(B-T);
    positions = new Map(rows.map((r,i) => [r.time, { x: x(i), y: r.median == null ? null : y(r.median) }]));
    const axis = p => p >= 1e8 ? `${(p/1e8).toFixed(2)}억` : p >= 1e4 ? `${(p/1e4).toFixed(1)}만` : fmt(p);
    let svg = `<svg viewBox="0 0 ${width} ${H}" role="img" aria-label="중앙값 점·직선, 구간별 주요 거래 가격대와 관측 수량. 빈 구간은 연결하지 않습니다."><text x="${L}" y="15">골드</text>`;
    if (prices.length) for (let i=0;i<4;i++) { const p=lo+(hi-lo)*i/3; if(hi===lo&&i)break;
      svg+=`<line x1="${L}" x2="${width-R}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line-2)"/><text x="${L-8}" y="${y(p)+4}" text-anchor="end">${axis(p)}</text>`; }
    else svg+=`<text x="${(L+width-R)/2}" y="130" text-anchor="middle">이 기간의 분포 자료가 없습니다</text>`;
    const barW = Math.max(1,(width-L-R)/rows.length-3);
    rows.forEach((r,i) => { if(r.state==='ready')svg+=`<rect x="${x(i)-barW/2}" y="${y(r.q75)}" width="${barW}" height="${Math.max(1,y(r.q25)-y(r.q75))}" fill="var(--ink-3)" opacity=".18"/>`; });
    for (const segment of distributionSegments(rows)) svg+=`<path d="${segment.map((r,i)=>`${i?'L':'M'}${positions.get(r.time).x},${y(r.median)}`).join(' ')}" fill="none" stroke="var(--blue)" stroke-width="2"/>`;
    rows.forEach((r,i)=>{if(r.median!=null)svg+=`<circle cx="${x(i)}" cy="${y(r.median)}" r="${r.state==='sparse'?3.5:2.2}" fill="${r.state==='sparse'?'var(--card)':'var(--blue)'}" stroke="var(--blue)" stroke-width="1.3"/>`;});
    svg+=`<text x="${L}" y="255">API 관측 수량</text>`;
    const maxQty = Math.max(1,...rows.map(r=>r.qty??0));
    rows.forEach((r,i)=>{if(r.qty!=null){const h=r.qty/maxQty*42;svg+=`<rect x="${x(i)-barW/2}" y="${V-h}" width="${barW}" height="${h}" fill="var(--blue)" opacity=".23"/>`;}});
    const ticks=[...new Set([0,Math.round((rows.length-1)/3),Math.round((rows.length-1)*2/3),rows.length-1])];
    ticks.forEach((i,k)=>{svg+=`<text x="${x(i)}" y="333" text-anchor="${k===0?'start':k===ticks.length-1?'end':'middle'}">${state.date?hh(rows[i].time):md(rows[i].d)}</text>`;});
    svg+=`<line class="pd-guide" y1="${T}" y2="${V}" stroke="var(--ink-3)" stroke-dasharray="3 4"/><circle class="pd-active" r="4" stroke="var(--blue)" stroke-width="1.5"/><rect class="pd-hit" x="${L}" y="${T}" width="${width-L-R}" height="${V-T}" fill="transparent"/></svg>`;
    box.innerHTML=svg;
    info(rows.find(r=>r.time===state.selected)??rows.at(-1));
    const pick = e => { const rect=box.getBoundingClientRect();return rows[Math.max(0,Math.min(rows.length-1,Math.floor((e.clientX-rect.left-L)/(width-L-R)*rows.length)))]; };
    $('.pd-hit').onpointermove=e=>{if(e.pointerType==='mouse')info(pick(e));};
    $('.pd-hit').onclick=e=>{info(pick(e),true);if(!state.date)openDay();};
    const missing=rows.filter(r=>r.state==='missing').length, unavailable=rows.filter(r=>r.state==='unavailable').length;
    $('.pd-status').textContent=[missing?`관측 없음 ${missing}${state.date?'시간':'일'}`:'',unavailable?`분포 자료 없음 ${unavailable}${state.date?'시간':'일'}`:''].filter(Boolean).join(' · ');
    const eventBox=$('.pd-events');eventBox.replaceChildren();
    for(const event of events.filter(e=>e.starts>=rows[0].d&&e.starts<=rows.at(-1).d)){
      const button=document.createElement('button');button.type='button';button.textContent=`${md(event.starts)} · ${event.name}`;
      button.onclick=()=>{const detail=document.getElementById('event-details');if(detail)detail.open=true;};eventBox.append(button);
    }
  }
  function openDay(){state.date=kstDay(state.selected);state.selected=startDay(state.date);draw();}
  root.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{state.period=b.dataset.period==='all'?'all':Number(b.dataset.period);state.date=null;state.selected=null;draw();});
  $('.pd-open').onclick=openDay;
  $('.pd-back').onclick=()=>{state.selected=startDay(state.date);state.date=null;draw();};
  $('.pd-date').onchange=()=>{state.date=$('.pd-date').value;state.selected=startDay(state.date);draw();};
  $('.pd-point').onchange=()=>info(rows.find(r=>r.time===Number($('.pd-point').value)),true);
  const observer=new ResizeObserver(draw);observer.observe($('.pd-plot'));cleanup=()=>observer.disconnect();draw();
}
