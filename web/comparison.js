import { comparisonSource, comparisonData } from './comparison-model.js?v=20261002-comparison';
import { isThursday, renderThursdayMarkers } from './price-distribution.js?v=20261002-comparison';

const fmt = n => n == null ? '관측 없음' : Math.round(n).toLocaleString('ko-KR');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const md = d => `${+d.slice(5,7)}/${+d.slice(8)}`;
let cleanup = () => {};
export function disposeComparison() { cleanup(); cleanup = () => {}; }

export function renderComparison(root, data, initialId) {
  disposeComparison();
  const initial = data.items.find(i => i.item_id === initialId) ?? data.items.find(i => i.item_name === '레전더리 소울 결정');
  const state = { kind: initial?.price_basis === 'ask0' ? 'ask0' : 'trade', stage: 'zero', period: 30, mode: 'index', a: initial?.item_id, b: null, selected: null };
  let items = [], sources = [], generation = 0, disposed = false;
  const cache = new Map();
  root.innerHTML = `<a class="back" href="#">← 전체 목록</a><section class="comparison">
    <h2>아이템 비교</h2><p class="desc">동일한 가격 기준의 두 아이템을 같은 기간으로 비교합니다.</p>
    <div class="compare-filters"><label>가격 기준<select data-kind><option value="trade">일반 아이템 · 체결 중앙값</option><option value="ask0">카드 · 평균 최저호가</option></select></label>
    <label class="compare-stage">카드 단계<select data-stage><option value="zero">0업끼리</option><option value="max">맥스업끼리</option></select></label></div>
    <div class="compare-selectors"><label>아이템 A<select data-item="a"></select></label><label>아이템 B<select data-item="b"></select></label></div>
    <div class="panel"><div class="compare-toolbar"><div class="compare-buttons" aria-label="비교 기간"><button type="button" data-period="7">7일</button><button type="button" data-period="30">30일</button><button type="button" data-period="all">전체</button></div>
    <div class="compare-buttons" aria-label="가격 표시 방식"><button type="button" data-mode="index">변화 비교 · 시작 100</button><button type="button" data-mode="price">실제 가격</button></div></div>
    <p class="compare-status" role="status"></p><div class="compare-summaries"></div><div class="compare-plot"></div><div class="pd-thursdays" aria-label="목요일 · 실제 패치 여부와 별개"></div>
    <div class="compare-selected" aria-live="polite"></div><label class="compare-date">날짜 선택<input type="range" min="0" max="0" value="0" aria-label="비교 날짜"></label>
    <p class="hint compare-basis"></p><p class="hint">시작 100은 같은 시작일의 가격을 100으로 맞춘 지수입니다. 가격 크기나 구매 유리함을 뜻하지 않습니다. 오늘은 제외하며, 관측이 없거나 체결이 5건 미만인 날짜는 선으로 연결하지 않습니다. ‘목’은 요일 표시로 실제 패치 여부와는 별개입니다.</p></div></section>`;
  const $ = s => root.querySelector(s);
  function setItems() {
    items = data.items.filter(i => i.price_basis === state.kind);
    if (!items.some(i => i.item_id === state.a)) state.a = items[0]?.item_id;
    if (!items.some(i => i.item_id === state.b) || state.a === state.b) {
      const first = items.find(i => i.item_id === state.a);
      state.b = (items.find(i => i.item_id !== state.a && i.category === first?.category && (state.kind !== 'ask0' || i.slot === first?.slot)) ?? items.find(i => i.item_id !== state.a))?.item_id;
    }
    $('[data-kind]').value = state.kind; $('.compare-stage').hidden = state.kind !== 'ask0';
    for (const side of ['a','b']) {
      const select = $(`[data-item="${side}"]`);
      select.innerHTML = items.map(i => `<option value="${esc(i.item_id)}">${esc(i.item_name)}</option>`).join('');
      select.value = state[side];
    }
  }
  async function load() {
    const ticket = ++generation;
    sources = []; draw(); $('.compare-status').textContent = '시계열 자료를 불러오는 중…';
    try {
      const chosen = [state.a,state.b].map(id => items.find(i => i.item_id === id));
      if (chosen.some(i => !i)) { $('.compare-status').textContent = '비교 가능한 아이템이 2종 이상 필요합니다.'; return; }
      const raw = await Promise.all(chosen.map(async item => {
        if (cache.has(item.item_id)) return cache.get(item.item_id);
        const response = await fetch(`data/series/${encodeURIComponent(item.item_id)}.json`, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const series = await response.json(); cache.set(item.item_id, series); return series;
      }));
      if (disposed || ticket !== generation) return;
      sources = chosen.map((item,i) => comparisonSource(item, raw[i], state.stage, data.priceAsOf ?? data.builtAt));
      state.selected = null; draw();
    } catch (error) {
      if (disposed || ticket !== generation) return;
      console.error(error); $('.compare-status').textContent = '자료를 불러오지 못했습니다. 아이템을 다시 선택하거나 새로고침해 주세요.';
    }
  }
  function draw() {
    root.querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.period === String(state.period))));
    root.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
    const chosen = [state.a,state.b].map(id => items.find(i => i.item_id === id));
    $('.compare-basis').textContent = state.kind === 'ask0'
      ? `일평균 최저호가 · ${state.stage === 'zero' ? '두 카드 모두 0업' : chosen.map(i => `${i?.item_name ?? ''} ${i?.max_upgrade ?? '맥스'}업`).join(' / ')} · 실제 체결가와 다릅니다.`
      : '일별 수량 가중 중앙값 · 상세 상단의 최근 1시간 VWAP과 계산 기준이 다릅니다.';
    const model = comparisonData(sources, state.period);
    if (!model.from || !model.to) {
      if (sources.length) $('.compare-status').textContent = '두 아이템에 모두 가격이 있는 완료일이 2일 이상 필요합니다.';
      for (const s of ['.compare-summaries','.compare-plot','.pd-thursdays','.compare-selected']) $(s).replaceChildren();
      $('.compare-date').hidden = true; return;
    }
    const rows = model.rows.filter(r => r.time >= model.from.time && r.time <= model.to.time);
    $('.compare-status').textContent = `${model.from.d}–${model.to.d} · 공통 관측 시작·종료일 · 중간 가격 미확인 ${rows.filter(r => r.values.some(v => v === null)).length}일`;
    $('.compare-summaries').innerHTML = chosen.map((item,j) => {
      const first=model.from.values[j], last=model.to.values[j], percent=(last/first-1)*100;
      return `<div><span class="compare-name"><i class="compare-key ${j?'second':''}"></i>${esc(item.item_name)}</span><strong class="${percent>0?'up':percent<0?'down':'flat'}">${percent>=0?'+':''}${percent.toFixed(2)}%</strong><small>${fmt(first)} → ${fmt(last)} 골드</small></div>`;
    }).join('');
    const box = $('.compare-plot'), width = box.clientWidth; if (width < 100) return;
    const value = (r,j) => r.values[j] === null ? null : state.mode === 'index' ? r.values[j]/model.from.values[j]*100 : r.values[j];
    const prices=rows.flatMap(r=>[value(r,0),value(r,1)]).filter(v=>v!==null),lo=Math.min(...prices),hi=Math.max(...prices),pad=Math.max((hi-lo)*.15,hi*.002,1);
    const L=68,R=22,T=28,B=245,H=280,x=i=>L+i*(width-L-R)/(rows.length-1),y=p=>B-(p-lo+pad)/(hi-lo+2*pad)*(B-T);
    const axis=p=>state.mode==='index'?p.toFixed(1):p>=1e8?`${(p/1e8).toFixed(1)}억`:p>=1e4?`${(p/1e4).toFixed(1)}만`:fmt(p);
    let svg=`<svg viewBox="0 0 ${width} ${H}" role="img" aria-label="${state.mode==='index'?'시작 가격 100 기준':'골드 기준'} 아이템 가격 비교"><text x="${L}" y="15">${state.mode==='index'?'지수 (시작 100)':'골드 / 개'}</text>`;
    for(let i=0;i<4;i++){if(hi===lo&&i)break;const p=lo+(hi-lo)*i/3;svg+=`<line x1="${L}" x2="${width-R}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line-2)"/><text x="${L-8}" y="${y(p)+4}" text-anchor="end">${axis(p)}</text>`;}
    if(state.mode==='index')svg+=`<line x1="${L}" x2="${width-R}" y1="${y(100)}" y2="${y(100)}" stroke="var(--ink-3)" stroke-dasharray="3 4"/>`;
    for(let j=0;j<2;j++){
      let d='',connected=false;
      rows.forEach((r,i)=>{const p=value(r,j);if(p===null){connected=false;return;}d+=`${connected?'L':'M'}${x(i)},${y(p)} `;connected=true;});
      svg+=`<path d="${d}" fill="none" stroke="${j?'var(--compare-second)':'var(--blue)'}" stroke-width="2" ${j?'stroke-dasharray="6 4"':''}/>`;
      rows.forEach((r,i)=>{const p=value(r,j);if(p!==null)svg+=`<circle cx="${x(i)}" cy="${y(p)}" r="2.3" fill="${j?'var(--compare-second)':'var(--blue)'}"/>`;});
    }
    [0,Math.floor((rows.length-1)/2),rows.length-1].forEach((i,k)=>{svg+=`<text x="${x(i)}" y="${H-7}" text-anchor="${k===0?'start':k===2?'end':'middle'}">${md(rows[i].d)}</text>`;});
    svg+=`<line class="compare-guide" y1="${T}" y2="${B}" stroke="var(--ink-3)" stroke-dasharray="3 4"/></svg>`;box.innerHTML=svg;
    function select(r) {
      state.selected=r.time; const i=rows.indexOf(r), guide=$('.compare-guide'); guide.setAttribute('x1',x(i));guide.setAttribute('x2',x(i));
      $('.compare-selected').innerHTML=`<span>${r.d}${isThursday(r.d)?' · 목요일':''}</span>`+chosen.map((item,j)=>`<div><span class="compare-name"><i class="compare-key ${j?'second':''}"></i>${esc(item.item_name)}</span><b>${r.values[j]===null?'가격 미확인':fmt(r.values[j])+' 골드'}</b></div>`).join('');
      const input=$('.compare-date input'); input.value=i;input.setAttribute('aria-valuetext',r.d);
    }
    $('.compare-date').hidden=false;const input=$('.compare-date input');input.max=rows.length-1;input.oninput=()=>select(rows[Number(input.value)]);
    select(rows.find(r=>r.time===state.selected)??rows.at(-1));
    renderThursdayMarkers($('.pd-thursdays'),rows,x,select);
    box.querySelector('svg').onclick=e=>{const i=Math.round((e.clientX-box.getBoundingClientRect().left-L)/(width-L-R)*(rows.length-1));select(rows[Math.max(0,Math.min(rows.length-1,i))]);};
  }
  $('[data-kind]').onchange=e=>{state.kind=e.target.value;setItems();load();};
  $('[data-stage]').onchange=e=>{state.stage=e.target.value;load();};
  root.querySelectorAll('[data-item]').forEach(select=>select.onchange=()=>{const key=select.dataset.item,other=key==='a'?'b':'a',old=state[key];state[key]=select.value;if(state[key]===state[other])state[other]=old;setItems();load();});
  root.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{state.period=b.dataset.period==='all'?'all':Number(b.dataset.period);state.selected=null;draw();});
  root.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{state.mode=b.dataset.mode;draw();});
  const observer=new ResizeObserver(draw);observer.observe($('.compare-plot'));
  cleanup=()=>{disposed=true;generation++;observer.disconnect();};setItems();load();
}
