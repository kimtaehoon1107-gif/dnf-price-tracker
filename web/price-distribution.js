const DAY = 86400000, HOUR = 3600000;
const fmt = n => n == null ? '—' : Math.round(n).toLocaleString('ko-KR');
const kstDay = t => new Date(t + 9 * HOUR).toISOString().slice(0, 10);
const startDay = d => Date.parse(`${d}T00:00:00+09:00`);
const md = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

// 달력상의 빈 구간을 실제 행으로 유지해야 직선이 결측을 가로지르지 않는다.
export function distributionRows(data, period = 30) {
  if (!data?.daily?.length) return [];
  const asOf = Date.parse(data.asOf), today = kstDay(asOf);
  const start = Math.max(startDay(data.daily[0].d), period === 'all' ? -Infinity : startDay(today) - (period - 1) * DAY);
  const source = new Map(data.daily.map(r => [startDay(r.d), r]));
  const result = [];
  for (let t = start; t < startDay(today) + DAY; t += DAY) {
    const r = source.get(t), ask = data.basis === 'ask' || data.basis === 'legendary';
    const value = ask ? (r?.vwap > 0 ? r.vwap : null) : r?.median;
    result.push({ ...r, median: value, time: t, d: kstDay(t), partial: t + DAY > asOf,
      state: !r || (ask && value == null) ? 'missing' : value == null ? 'unavailable'
        : data.basis === 'legendary' && r.hours < 18 ? 'sparse' : !ask && r.n < data.minTrades ? 'sparse' : 'ready' });
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

export function periodChange(rows) {
  const observed = rows.filter(r => !r.partial && r.state === 'ready' && r.median > 0);
  if (observed.length < 2) return null;
  const first = observed[0], last = observed.at(-1);
  return { first, last, percent: (last.median / first.median - 1) * 100 };
}

export function isThursday(day) { return new Date(`${day}T00:00:00Z`).getUTCDay() === 4; }

export function renderThursdayMarkers(root, rows, position, onSelect) {
  root.replaceChildren();
  // 긴 기간·모바일에서 터치 영역이 겹치면 최근 목요일부터 간격을 확보한다.
  let right = Infinity;
  rows.map((r, i) => ({ r, i })).reverse().forEach(({ r, i }) => {
    const left = position(i);
    if (!isThursday(r.d) || right - left < 44) return;
    right = left;
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = '목'; button.style.left = `${left}px`;
    button.title = `${r.d} 목요일 · 요일 표시이며 실제 패치 여부와는 별개입니다.`;
    button.setAttribute('aria-label', button.title);
    button.onclick = () => onSelect(r);
    root.prepend(button);
  });
}

let cleanup = () => {};
export function disposePriceDistribution() { cleanup(); cleanup = () => {}; }

export function renderPriceDistribution(root, data, events = []) {
  disposePriceDistribution();
  const legendary = data?.basis === 'legendary';
  const ask = data?.basis === 'ask' || legendary;
  const priceLabel = legendary ? (data.metric === 'min' ? '전체 최저호가 · 일평균' : 'P10 · 일평균') : '평균 최저호가';
  if (!data?.daily?.length) { root.textContent = ask ? '최저호가 관측 자료가 없습니다.' : '체결 분포 자료가 없습니다.'; return; }
  root.className = 'price-distribution';
  root.innerHTML = `<div class="pd-toolbar"><div class="pd-periods" aria-label="조회 기간">
    <button type="button" data-period="7">7일</button><button type="button" data-period="30">30일</button><button type="button" data-period="all">전체</button></div><span class="pd-extent"></span></div>
    <div class="pd-period-change"></div>
    <div class="pd-readout"><div><span class="pd-selected"></span><div class="pd-price"></div><div class="pd-range"></div></div><div class="pd-qty"></div></div>
    ${ask ? '' : '<div class="pd-legend"><span><i class="pd-line-key"></i>수량 가중 중앙값</span><span><i class="pd-band-key"></i>주요 거래 가격대</span><span>○ 체결 5건 미만</span></div>'}
    <div class="pd-plot"></div><div class="pd-thursdays" aria-label="목요일 · 실제 패치 여부와 별개"></div><div class="pd-events"></div>
    <div class="pd-status"></div><div class="pd-announcement" aria-live="polite"></div>
    <details class="pd-help" ${ask ? 'hidden' : ''}><summary>주요 거래 가격대란?</summary><p>관측한 체결을 개당 가격순으로 놓고, 누적 수량이 25%와 75%에 도달하는 가격을 표시합니다. 가운데 50%에 해당하는 가격 구간이며 동일 가격에 거래가 몰리면 포함 수량은 더 많을 수 있습니다. 미래 가격의 예측 범위가 아닙니다. 체결 5건 미만은 표시 기준상 점만 남기며, 5건 이상이라고 통계적 신뢰성을 보장하지 않습니다.</p></details>
    <details class="pd-raw" ${legendary ? 'hidden' : ''}><summary>${ask ? '관측 최저·최고 호가와 횟수' : '원본 고가·저가와 평균 확인'}</summary><p></p></details>
    <p class="hint">${ask ? '가격이 확인된 관측만 평균합니다. 빈 구간은 매물 없음과 수집 공백을 구분할 수 없어 연결하지 않습니다.' : 'API 관측 수량은 전체 거래량의 하한입니다. 빈 구간은 체결 관측이 없으며 무거래와 수집 공백을 구분할 수 없습니다. 원본이 불완전한 과거 구간은 분포를 표시하지 않습니다.'}</p>`;
  const $ = s => root.querySelector(s);
  const state = { period: 30, selected: null };
  let rows = [], positions = new Map();
  function info(r, announce = false) {
    state.selected = r.time;
    $('.pd-selected').textContent = `${r.d}${isThursday(r.d) ? ' · 목요일' : ''}${r.partial ? ' · 수집 중' : ''}`;
    $('.pd-price').textContent = r.median == null ? '—' : `${fmt(r.median)} 골드`;
    $('.pd-range').textContent = legendary ? `${priceLabel}${r.state === 'sparse' ? ' · 관측 18시간 미만: 점만 표시' : r.state === 'missing' ? ' · 가격 관측 없음' : ''}` : ask ? (r.state === 'ready' ? '' : '가격 관측 없음') : r.state === 'ready' ? `주요 거래 가격대 ${fmt(r.q25)}–${fmt(r.q75)}`
      : r.state === 'sparse' ? `체결 ${fmt(r.n)}건 · 가격점만 표시` : r.state === 'unavailable' ? '원본 불완전 · 분포 자료 없음' : '체결 관측 없음';
    $('.pd-qty').textContent = legendary ? (r.hours == null ? '' : `관측 ${r.hours}/24시간 · 평균 관측 매물 ${fmt(r.listings)}건`) : ask ? (r.state === 'ready' ? `가격 관측 ${fmt(r.n)}회` : '') : r.n == null ? '관측 수량 미확인' : `관측 ${fmt(r.qty)}개 · ${fmt(r.n)}건`;
    $('.pd-raw p').textContent = r.n == null || (ask && r.state === 'missing') ? '가격 관측 자료 없음' : `최저 ${fmt(r.l)} · 최고 ${fmt(r.h)} · ${ask ? '평균 최저호가' : 'VWAP'} ${fmt(r.vwap)} 골드${ask ? ` · 가격 관측 ${fmt(r.n)}회` : ''}`;
    if (announce) $('.pd-announcement').textContent = `${$('.pd-selected').textContent} · ${$('.pd-price').textContent} · ${$('.pd-range').textContent}`;
    const slider = $('.pd-plot svg');
    slider.setAttribute('aria-valuenow', rows.indexOf(r));
    slider.setAttribute('aria-valuetext', `${r.d} · ${$('.pd-price').textContent} · ${$('.pd-range').textContent}`);
    const pos = positions.get(r.time), guide = $('.pd-guide');
    if (pos && guide) {
      guide.setAttribute('x1', pos.x); guide.setAttribute('x2', pos.x);
      const dot = $('.pd-active'); dot.setAttribute('cx', pos.x); dot.setAttribute('cy', pos.y ?? 0);
      dot.setAttribute('opacity', r.median == null ? 0 : 1);
      dot.setAttribute('fill', r.state === 'sparse' ? 'var(--card)' : 'var(--blue)');
    }
  }
  function draw() {
    rows = distributionRows(data, state.period);
    if (!rows.length) return;
    root.querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-pressed', String(String(state.period) === b.dataset.period)));
    $('.pd-extent').textContent = `${rows[0].d}–${rows.at(-1).d} · 일별`;
    const change = periodChange(rows);
    $('.pd-period-change').textContent = change
      ? `기간 변화 ${change.percent >= 0 ? '+' : ''}${change.percent.toFixed(2)}% · ${fmt(change.first.median)} → ${fmt(change.last.median)} 골드 (${change.first.d}–${change.last.d} · 완료 관측일 기준)`
      : '기간 변화: 가격이 있는 완료 관측일이 2일 이상 필요합니다.';
    const box = $('.pd-plot'), width = box.clientWidth;
    if (width < 100) return;
    const L = 68, R = 14, T = 28, B = 228, V = ask && !legendary ? 228 : 308, H = ask && !legendary ? 260 : 340;
    const x = i => L + (i + .5) * (width - L - R) / rows.length;
    const prices = rows.flatMap(r => r.median == null ? [] : !ask && r.state === 'ready' ? [r.q25,r.q75,r.median] : [r.median]);
    const lo = prices.length ? Math.min(...prices) : 0, hi = prices.length ? Math.max(...prices) : 1;
    const pad = Math.max((hi-lo)*.15, hi*.002, 1), y = p => B - (p-lo+pad)/(hi-lo+2*pad)*(B-T);
    positions = new Map(rows.map((r,i) => [r.time, { x: x(i), y: r.median == null ? null : y(r.median) }]));
    const axis = p => p >= 1e8 ? `${(p/1e8).toFixed(2)}억` : p >= 1e4 ? `${(p/1e4).toFixed(1)}만` : fmt(p);
    let svg = `<svg viewBox="0 0 ${width} ${H}" role="slider" tabindex="0" aria-label="날짜별 ${ask ? priceLabel : '체결 가격'}. 좌우 화살표로 날짜 선택" aria-valuemin="0" aria-valuemax="${rows.length-1}"><text x="${L}" y="15">골드</text>`;
    if (prices.length) for (let i=0;i<4;i++) { const p=lo+(hi-lo)*i/3; if(hi===lo&&i)break;
      svg+=`<line x1="${L}" x2="${width-R}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line-2)"/><text x="${L-8}" y="${y(p)+4}" text-anchor="end">${axis(p)}</text>`; }
    else svg+=`<text x="${(L+width-R)/2}" y="130" text-anchor="middle">${ask ? '가격 관측 자료 없음' : '분포 자료 없음'}</text>`;
    const barW = Math.max(1,(width-L-R)/rows.length-3);
    rows.forEach((r,i) => { if(!ask && r.state==='ready')svg+=`<rect x="${x(i)-barW/2}" y="${y(r.q75)}" width="${barW}" height="${Math.max(1,y(r.q25)-y(r.q75))}" fill="var(--ink-3)" opacity=".18"/>`; });
    for (const segment of distributionSegments(rows)) svg+=`<path d="${segment.map((r,i)=>`${i?'L':'M'}${positions.get(r.time).x},${y(r.median)}`).join(' ')}" fill="none" stroke="var(--blue)" stroke-width="2"/>`;
    rows.forEach((r,i)=>{if(r.median!=null)svg+=`<circle cx="${x(i)}" cy="${y(r.median)}" r="${r.state==='sparse'?3.5:2.2}" fill="${r.state==='sparse'?'var(--card)':'var(--blue)'}" stroke="var(--blue)" stroke-width="1.3"/>`;});
    if (!ask || legendary) {
      svg+=`<text x="${L}" y="255">${legendary ? '평균 관측 매물 · 건 (체결량 아님)' : 'API 관측 수량'}</text>`;
      const quantity = r => legendary ? r.listings : r.qty;
      const maxQty = Math.max(1,...rows.map(r=>quantity(r)??0));
      rows.forEach((r,i)=>{if(quantity(r)!=null){const h=quantity(r)/maxQty*42;svg+=`<rect x="${x(i)-barW/2}" y="${V-h}" width="${barW}" height="${h}" fill="var(--blue)" opacity=".23"/>`;}});
    }
    const ticks=[...new Set([0,Math.round((rows.length-1)/3),Math.round((rows.length-1)*2/3),rows.length-1])];
    ticks.forEach((i,k)=>{svg+=`<text x="${x(i)}" y="${H-7}" text-anchor="${k===0?'start':k===ticks.length-1?'end':'middle'}">${md(rows[i].d)}</text>`;});
    svg+=`<line class="pd-guide" y1="${T}" y2="${V}" stroke="var(--ink-3)" stroke-dasharray="3 4"/><circle class="pd-active" r="4" stroke="var(--blue)" stroke-width="1.5"/><rect class="pd-hit" x="${L}" y="${T}" width="${width-L-R}" height="${V-T}" fill="transparent"/></svg>`;
    box.innerHTML=svg;
    renderThursdayMarkers($('.pd-thursdays'), rows, x, r => info(r, true));
    info(rows.find(r=>r.time===state.selected)??rows.at(-1));
    const pick = e => { const rect=box.getBoundingClientRect();return rows[Math.max(0,Math.min(rows.length-1,Math.floor((e.clientX-rect.left-L)/(width-L-R)*rows.length)))]; };
    $('.pd-hit').onpointermove=e=>{if(e.pointerType==='mouse')info(pick(e));};
    $('.pd-hit').onclick=e=>info(pick(e),true);
    $('.pd-plot svg').onkeydown=e=>{
      const i=rows.findIndex(r=>r.time===state.selected);
      const next=e.key==='ArrowLeft'?i-1:e.key==='ArrowRight'?i+1:e.key==='Home'?0:e.key==='End'?rows.length-1:null;
      if(next!==null){e.preventDefault();info(rows[Math.max(0,Math.min(rows.length-1,next))],true);}
    };
    const missing=rows.filter(r=>r.state==='missing').length, unavailable=rows.filter(r=>r.state==='unavailable').length;
    $('.pd-status').textContent=[missing?`관측 없음 ${missing}일`:'',unavailable?`분포 자료 없음 ${unavailable}일`:''].filter(Boolean).join(' · ');
    const eventBox=$('.pd-events');eventBox.replaceChildren();
    for(const event of events.filter(e=>e.starts>=rows[0].d&&e.starts<=rows.at(-1).d)){
      const button=document.createElement('button');button.type='button';button.textContent=`${md(event.starts)} · ${event.name}`;
      button.onclick=()=>{const detail=document.getElementById('event-details');if(detail)detail.open=true;};eventBox.append(button);
    }
  }
  root.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{state.period=b.dataset.period==='all'?'all':Number(b.dataset.period);state.selected=null;draw();});
  const observer=new ResizeObserver(draw);observer.observe($('.pd-plot'));cleanup=()=>observer.disconnect();draw();
}
