import { rankedItems, calendarCells, periodsOnDate } from './sidebar-model.js?v=20261011-periods';
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Math.round(n).toLocaleString('ko-KR');
const icons = { calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M7 14h3M14 14h3M7 18h3"/>', ranking: '<path d="m3 17 6-6 4 4 8-10M15 5h6v6"/>' };
export function mountSidebar(summary, rail, closeChat) {
  rail.setAttribute('aria-label', '시세 도구');
  let active = null, direction = 'up', filter = '전체', calendar = null, error = false;
  const today = new Date().toLocaleDateString('sv-SE', {timeZone:'Asia/Seoul'});
  let year = +today.slice(0,4), month = +today.slice(5,7)-1, selected = today;
  const panel = document.createElement('aside'); panel.id = 'market-tools'; panel.hidden = true; panel.setAttribute('aria-label','시세 도구 패널');
  document.body.append(panel);
  const buttons = {};
  for (const [key,label] of [['calendar','캘린더'],['ranking','등락 순위']]) {
    const b = document.createElement('button'); b.className = 'tool-launch'; b.type = 'button'; b.setAttribute('aria-label',label+' 열기'); b.setAttribute('aria-controls',panel.id); b.setAttribute('aria-expanded','false');
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${icons[key]}</svg><span>${label}</span>`;
    b.onclick = () => show(active === key ? null : key); rail.append(b); buttons[key] = b;
  }
  function show(key, focus = true) {
    const previous = active; active = key;
    if(key) closeChat();
    panel.hidden = !key; document.body.classList.toggle('market-tools-open',!!key);
    for(const [k,b] of Object.entries(buttons)) { b.setAttribute('aria-expanded',String(k===key)); b.classList.toggle('active',k===key); }
    if(key) { render(); if(focus) panel.querySelector('.tool-close').focus(); }
    else if(focus && previous) buttons[previous].focus();
    window.dispatchEvent(new Event('resize'));
    if(key==='calendar' && !calendar && !error) loadCalendar();
  }
  window.addEventListener('market-chat-opened',()=>show(null,false));
  panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();show(null)}});
  async function loadCalendar() {
    try { const response = await fetch('update-calendar.json',{cache:'no-cache'}); if(!response.ok)throw Error(); calendar = await response.json();
      // 오늘 공지가 없으면 이번 달의 최근 공지 날짜를 선택한다.
      if(!calendar.entries.some(e=>e.date===selected) && !periodsOnDate(calendar.periods ?? [],selected).length) selected = calendar.entries.find(e=>e.date.startsWith(today.slice(0,7)) && e.date<=today)?.date ?? today;
    } catch { error = true; }
    if(active==='calendar')render();
  }
  function render() {
    panel.innerHTML = `<header><button class="tool-close" aria-label="도구 패널 닫기">×</button><h2>${active==='calendar'?'업데이트·이벤트 캘린더':'상승·하락 순위'}</h2><p>${active==='calendar'?'업데이트·이벤트·패키지 판매기간을 확인하세요.':'최근 24시간 평균 거래가의 변화입니다.'}</p></header><div class="tool-body"></div>`;
    panel.querySelector('.tool-close').setAttribute('aria-label','도구 패널 닫기');panel.querySelector('.tool-close').onclick=()=>show(null);
    const body=panel.querySelector('.tool-body');
    if(active==='ranking') {
      const list=rankedItems(summary.items,direction);
      body.innerHTML=`<div class="tool-filters"><button data-direction="up" aria-pressed="${direction==='up'}">상승폭 높은 순</button><button data-direction="down" aria-pressed="${direction==='down'}">하락폭 큰 순</button></div><p class="tool-muted">${esc(summary.priceAsOf ? new Date(summary.priceAsOf).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+' KST 기준' : '공개 시세 기준')}</p>`+list.map((i,n)=>`<a class="tool-rank" href="index.html#${encodeURIComponent(i.item_id)}"><span>${n+1}</span><div><strong>${esc(i.item_name)}</strong><small>${fmt(i.vwap24)} 골드</small></div><b class="${direction}">${i.change>0?'+':''}${i.change.toFixed(2)}%</b></a>`).join('')+(list.length?'':'<p>조건을 충족하는 아이템이 없습니다.</p>')+'<p class="tool-note">직전 24시간 평균과 비교합니다. API 관측 수량 100개 이상인 일반 아이템만 표시합니다. 수량은 거래 건수와 다르며 카드 판매가는 제외합니다.</p>';
      body.querySelectorAll('[data-direction]').forEach(b=>b.onclick=()=>{direction=b.dataset.direction;render();panel.querySelector(`[data-direction="${direction}"]`).focus()});
      body.querySelectorAll('.tool-rank').forEach(a=>a.addEventListener('click',()=>show(null,false)));
      return;
    }
    if(!calendar) { body.innerHTML=error?'<p>업데이트 목록을 불러오지 못했습니다.</p><button class="tool-retry">다시 시도</button>':'<p role="status">공식 업데이트 목록을 불러오는 중…</p>';body.querySelector('.tool-retry')?.addEventListener('click',()=>{error=false;loadCalendar()});return; }
    const prefix=`${year}-${String(month+1).padStart(2,'0')}`;
    const entries=filter==='전체'||filter==='업데이트'?calendar.entries:[];
    const periods=(calendar.periods ?? []).filter(p=>filter==='전체'||p.category===filter);
    body.innerHTML=`<div class="tool-month"><button data-month="-1" aria-label="이전 달">‹</button><strong>${year}년 ${month+1}월</strong><button data-month="1" aria-label="다음 달">›</button></div><div class="tool-calendar">${['일','월','화','수','목','금','토'].map(d=>`<span>${d}</span>`).join('')}${calendarCells(year,month).map(d=>{if(!d)return '<span></span>';const date=prefix+'-'+String(d).padStart(2,'0');const has=entries.some(e=>e.date===date)||periods.some(p=>p.startDate===date||p.endDate===date);return `<button data-date="${date}" aria-label="${date}${has?' 일정 있음':''}" aria-pressed="${date===selected}" class="${has?'has-event':''} ${date===today?'today':''}">${d}</button>`}).join('')}</div><div class="tool-filters">${['전체','업데이트','이벤트','패키지'].map(f=>`<button data-filter="${f}" aria-pressed="${filter===f}">${f}</button>`).join('')}</div><h3>${selected}</h3>`;
    const day=entries.filter(e=>e.date===selected);
    const activePeriods=periodsOnDate(periods,selected);
    body.innerHTML+=day.map(e=>`<article class="tool-event"><span>${esc(e.category)}</span><h4>${esc(e.title)}</h4><small>${esc(e.dateBasis)} · 게시 ${esc(e.publishedDate)}</small>${e.headings.length?'<p class="tool-muted">공식 본문 주요 항목</p><ul>'+e.headings.map(h=>`<li>${esc(h)}</li>`).join('')+'</ul>':''}<a href="${esc(e.url)}" target="_blank" rel="noopener">공식 원문 보기 ↗</a></article>`).join('') || (activePeriods.length ? '' : '<p class="tool-muted">저장된 일정이 없는 날짜입니다. 실제 일정이 없었다는 뜻은 아닙니다.</p>');
    body.innerHTML+=activePeriods.map(p=>`<article class="tool-event"><span>${esc(p.category)} · ${p.category==='패키지'?'판매 ':''}${esc(p.phase)}</span><h4>${esc(p.title)}</h4><p>${p.category==='패키지'?'판매기간':'이벤트 기간'}<br>${esc(p.startDate)} ~ ${esc(p.endDate ?? '종료일 미정')}</p><small>공식 목록에 표시된 날짜 기준 · 시작·종료 시각은 원문 확인${p.category==='패키지'?' · 아이템 삭제일과 별개':''}</small><p><a href="${esc(p.url)}" target="_blank" rel="noopener">공식 원문 보기 ↗</a></p></article>`).join('');
    body.innerHTML+=`<p class="tool-note">달력의 점은 업데이트 또는 시작·종료일입니다. 날짜를 누르면 그날 진행 중인 기간도 표시합니다.<br>제목에 적용일이 명시된 공지는 적용일에, 나머지는 게시일에 표시합니다. 목요일이라고 일정을 만들지 않습니다.<br>업데이트 확인: ${esc(new Date(calendar.checkedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))} KST<br>${Object.entries(calendar.periodCheckedAt ?? {}).map(([source,date])=>`${source==='event'?'이벤트':'패키지'} 확인: ${esc(new Date(date).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))} KST`).join('<br>')}</p>`;
    body.querySelectorAll('[data-date]').forEach(b=>b.onclick=()=>{selected=b.dataset.date;render();panel.querySelector(`[data-date="${selected}"]`).focus()});
    body.querySelectorAll('[data-month]').forEach(b=>b.onclick=()=>{const d=new Date(Date.UTC(year,month+Number(b.dataset.month),1));year=d.getUTCFullYear();month=d.getUTCMonth();selected=`${year}-${String(month+1).padStart(2,'0')}-01`;render()});
    body.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;render();panel.querySelector(`[data-filter="${filter}"]`).focus()});
  }
}
