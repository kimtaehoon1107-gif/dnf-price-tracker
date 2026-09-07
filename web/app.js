// 대시보드 + 아이템 상세. 해시 라우팅으로 한 페이지에서 처리한다.

const fmt = (n, d = 0) => n === null || n === undefined || !isFinite(n)
  ? '-' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d });
const won = (n) => !isFinite(n) || n === null ? '-'
  : n >= 100000000 ? (n / 100000000).toFixed(1) + '억'
  : n >= 10000 ? Math.round(n / 10000).toLocaleString('ko-KR') + '만' : fmt(n);
const pct = (n) => n === null || !isFinite(n) ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const cls = (n) => n === null || !isFinite(n) || Math.abs(n) < 0.005 ? 'flat' : n > 0 ? 'up' : 'down';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const css = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();

// 종결이 언제 교체됐는지. 종결은 패치로 바뀌므로 "얼마나 오래 종결이었나"가
// 곧 다음 교체가 임박했는지의 신호가 된다.
const sinceDays = (d) => d ? Math.floor((Date.now() - Date.parse(d + 'T00:00:00+09:00')) / 86400000) : null;

// 유동성 등급 — "이 아이템의 지표를 믿어도 되는가"를 한 글자로.
// 표본이 얇으면 어떤 가격 지표도 신뢰할 수 없으므로 등급을 먼저 보여준다.
function grade(it) {
  const perDay = it.span_days > 0.5 ? it.trades / it.span_days : it.trades * 2;
  return perDay >= 60 ? 'A' : perDay >= 20 ? 'B' : perDay >= 5 ? 'C' : 'D';
}

/** 14일 스파크라인. 점이 2개 미만이면 그리지 않는다. */
function sparkSVG(vals, color) {
  if (!vals || vals.length < 2) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals), r = hi - lo || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${26 - ((v - lo) / r) * 22}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8"
      vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function depthQuote(levels, target) {
  let filled = 0, cost = 0;
  for (const level of levels) {
    const take = Math.min(level.qty, target - filled);
    cost += level.price * take;
    filled += take;
    if (filled === target) break;
  }
  return { filled, avg: filled === target ? cost / target : null };
}

function depthSVG(levels) {
  const shown = [];
  let total = 0;
  for (const level of levels) {
    if (total >= 100) break;
    const qty = Math.min(level.qty, 100 - total);
    if (qty > 0) { shown.push({ price: level.price, qty }); total += qty; }
  }
  if (!shown.length) return '';

  const W = 900, H = 280, L = 88, R = 18, T = 16, B = 34;
  const plotW = W - L - R, plotH = H - T - B;
  const prices = shown.map((x) => x.price);
  const minPrice = Math.min(...prices), maxPrice = Math.max(...prices);
  const pad = minPrice === maxPrice ? Math.max(minPrice * 0.01, 1) : (maxPrice - minPrice) * 0.08;
  const lo = Math.max(0, minPrice - pad), hi = maxPrice + pad;
  const xAt = (qty) => L + qty / total * plotW;
  const yAt = (price) => T + (hi - price) / (hi - lo) * plotH;

  let cumulative = 0;
  let line = `M ${xAt(0)} ${yAt(shown[0].price)}`;
  for (let i = 0; i < shown.length; i++) {
    cumulative += shown[i].qty;
    line += ` H ${xAt(cumulative)}`;
    if (shown[i + 1]) line += ` V ${yAt(shown[i + 1].price)}`;
  }
  const area = `${line} L ${xAt(total)} ${T + plotH} L ${xAt(0)} ${T + plotH} Z`;
  const priceTicks = minPrice === maxPrice ? [minPrice] : [minPrice, (minPrice + maxPrice) / 2, maxPrice];
  const qtyTicks = [...new Set([0, 10, total])].filter((x) => x <= total);

  return `<div class="depth-chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="가격별 누적 매물, 최대 ${fmt(total)}개">
      <title>낮은 호가부터 최대 ${fmt(total)}개까지의 매물 사다리</title>
      ${priceTicks.map((p) => `<line class="depth-grid" x1="${L}" y1="${yAt(p)}" x2="${W - R}" y2="${yAt(p)}"/>
        <text class="depth-axis" x="${L - 10}" y="${yAt(p) + 4}" text-anchor="end">${fmt(p)}</text>`).join('')}
      ${[10, 100].filter((q) => q <= total).map((q) => `<line class="depth-guide" x1="${xAt(q)}" y1="${T}" x2="${xAt(q)}" y2="${T + plotH}"/>`).join('')}
      <path class="depth-fill" d="${area}"/>
      <path class="depth-line" d="${line}"/>
      ${qtyTicks.map((q) => `<text class="depth-axis" x="${xAt(q)}" y="${H - 8}" text-anchor="middle">${fmt(q)}개</text>`).join('')}
    </svg>
  </div>`;
}

function shockData(days) {
  const today = new Date(DATA.builtAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  // 당일 거래량은 아직 쌓이는 중이라 완성된 일봉과 비교하면 항상 수요 감소처럼 보인다.
  const complete = days.filter((x) => x.d < today && x.vwap > 0 && x.qty > 0).slice(-30);
  if (complete.length < 3) return null;

  const meanPrice = complete.reduce((sum, x) => sum + x.vwap, 0) / complete.length;
  const meanQty = complete.reduce((sum, x) => sum + x.qty, 0) / complete.length;
  const points = complete.map((x) => ({
    d: x.d,
    price: (x.vwap / meanPrice - 1) * 100,
    qty: (x.qty / meanQty - 1) * 100,
  }));
  return { points, latest: points.at(-1) };
}

function weekdayProfile(days, events) {
  const today = new Date(DATA.builtAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const complete = days.filter((x) => x.d < today && x.vwap > 0 && x.qty > 0);
  if (!complete.length) return { state: 'history', span: 0, remaining: 31 };

  const dayNumber = (date) => Date.parse(`${date}T12:00:00Z`) / 86400000;
  const span = dayNumber(complete.at(-1).d) - dayNumber(complete[0].d);
  if (span < 31) return { state: 'history', span, remaining: 31 - span };

  const eventDays = events.flatMap((event) => eventStages(event)
    .map((stage) => event[stage.key])
    .filter(Boolean)
    .map(dayNumber));
  const excluded = complete.filter((x) => eventDays.some((eventDay) => Math.abs(dayNumber(x.d) - eventDay) <= 3));
  const used = complete.filter((x) => !eventDays.some((eventDay) => Math.abs(dayNumber(x.d) - eventDay) <= 3));
  const groups = Array.from({ length: 7 }, (_, index) => used.filter((x) => isoDow(x.d) === index + 1));
  const counts = groups.map((group) => group.length);
  if (counts.some((count) => count < 3)) {
    return { state: 'samples', span, counts, used: used.length, excluded: excluded.length };
  }

  const mean = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  const meanPrice = mean(used, 'vwap');
  const meanQty = mean(used, 'qty');
  const labels = ['월', '화', '수', '목', '금', '토', '일'];
  return {
    state: 'ready', span, used: used.length, excluded: excluded.length,
    points: groups.map((group, index) => ({
      k: index + 1,
      label: labels[index],
      price: mean(group, 'vwap') / meanPrice * 100,
      qty: mean(group, 'qty') / meanQty * 100,
      n: group.length,
    })),
  };
}

function weekdaySVG(points, key, title) {
  const W = 420, H = 220, L = 28, R = 14, T = 34, B = 34;
  const plotW = W - L - R, plotH = H - T - B;
  const maxDeviation = Math.max(5, ...points.map((point) => Math.abs(point[key] - 100))) * 1.2;
  const low = 100 - maxDeviation, high = 100 + maxDeviation;
  const yAt = (value) => T + (high - value) / (high - low) * plotH;
  const baseline = yAt(100);
  const slot = plotW / points.length;
  const barWidth = Math.min(30, slot * 0.54);
  const aria = points.map((point) => `${point.label}요일 ${point[key].toFixed(1)}, 표본 ${point.n}일`).join(', ');

  return `<div class="weekday-chart">
    <h4>${title}</h4>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${title}. 아이템 평균 100. ${aria}`)}">
      <title>${esc(`${title} · 아이템 평균 100`)}</title>
      <rect class="weekday-thursday" x="${L + slot * 3}" y="${T - 8}" width="${slot}" height="${plotH + 25}" rx="8"/>
      <line class="weekday-baseline" x1="${L}" y1="${baseline}" x2="${W - R}" y2="${baseline}"/>
      <text class="weekday-axis" x="${L - 5}" y="${baseline + 4}" text-anchor="end">100</text>
      ${points.map((point, index) => {
        const x = L + slot * index + (slot - barWidth) / 2;
        const y = yAt(point[key]);
        const top = Math.min(y, baseline);
        const height = Math.max(2, Math.abs(y - baseline));
        return `<rect class="weekday-bar ${point[key] >= 100 ? 'above' : 'below'}" x="${x}" y="${top}" width="${barWidth}" height="${height}" rx="4">
          <title>${point.label}요일 · ${point[key].toFixed(1)} · 표본 ${point.n}일</title>
        </rect>
        <text class="weekday-value" x="${x + barWidth / 2}" y="${point[key] >= 100 ? top - 6 : top + height + 14}" text-anchor="middle">${point[key].toFixed(1)}</text>
        <text class="weekday-label${point.k === 4 ? ' thursday' : ''}" x="${x + barWidth / 2}" y="${H - 8}" text-anchor="middle">${point.label}</text>`;
      }).join('')}
    </svg>
  </div>`;
}

function shockName(point) {
  if (point.qty >= 0 && point.price >= 0) return '수요 증가';
  if (point.qty >= 0) return '공급 증가';
  if (point.price >= 0) return '공급 감소';
  return '수요 감소';
}

function shockSVG(points) {
  const W = 900, H = 360, L = 76, R = 34, T = 28, B = 52;
  const plotW = W - L - R, plotH = H - T - B;
  const xMax = Math.max(10, ...points.map((x) => Math.abs(x.qty))) * 1.12;
  const yMax = Math.max(1, ...points.map((x) => Math.abs(x.price))) * 1.12;
  const xAt = (x) => L + (x + xMax) / (2 * xMax) * plotW;
  const yAt = (y) => T + (yMax - y) / (2 * yMax) * plotH;
  const cx = xAt(0), cy = yAt(0);

  return `<div class="shock-chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="일별 가격과 거래량의 평균 대비 4분면">
      <title>가로축은 API 관측 거래량, 세로축은 VWAP의 최근 평균 대비 편차입니다.</title>
      <rect class="shock-zone demand-up" x="${cx}" y="${T}" width="${W - R - cx}" height="${cy - T}"/>
      <rect class="shock-zone supply-down" x="${L}" y="${T}" width="${cx - L}" height="${cy - T}"/>
      <rect class="shock-zone demand-down" x="${L}" y="${cy}" width="${cx - L}" height="${T + plotH - cy}"/>
      <rect class="shock-zone supply-up" x="${cx}" y="${cy}" width="${W - R - cx}" height="${T + plotH - cy}"/>
      <line class="shock-axis" x1="${L}" y1="${cy}" x2="${W - R}" y2="${cy}"/>
      <line class="shock-axis" x1="${cx}" y1="${T}" x2="${cx}" y2="${T + plotH}"/>
      <text class="shock-label" x="${L + 12}" y="${T + 20}">공급 감소</text>
      <text class="shock-label" x="${W - R - 12}" y="${T + 20}" text-anchor="end">수요 증가</text>
      <text class="shock-label" x="${L + 12}" y="${T + plotH - 10}">수요 감소</text>
      <text class="shock-label" x="${W - R - 12}" y="${T + plotH - 10}" text-anchor="end">공급 증가</text>
      ${points.map((p, i) => `<circle class="shock-point${i === points.length - 1 ? ' latest' : ''}" cx="${xAt(p.qty)}" cy="${yAt(p.price)}" r="${i === points.length - 1 ? 6 : 4}">
        <title>${p.d} · ${shockName(p)} · API 관측 거래량 ${pct(p.qty)} · 가격 ${pct(p.price)}</title>
      </circle>`).join('')}
      <text class="shock-tick" x="${L}" y="${cy + 18}" text-anchor="start">${pct(-xMax)}</text>
      <text class="shock-tick" x="${W - R}" y="${cy + 18}" text-anchor="end">${pct(xMax)}</text>
      <text class="shock-tick" x="${cx - 8}" y="${T + 4}" text-anchor="end">${pct(yMax)}</text>
      <text class="shock-tick" x="${cx - 8}" y="${T + plotH}" text-anchor="end">${pct(-yMax)}</text>
      <text class="shock-title" x="${L + plotW / 2}" y="${H - 8}" text-anchor="middle">API 관측 거래량 평균 대비</text>
      <text class="shock-title" transform="translate(15 ${T + plotH / 2}) rotate(-90)" text-anchor="middle">VWAP 평균 대비</text>
    </svg>
  </div>`;
}

const eventStages = (event) => [
  {
    key: 'starts',
    label: event.type === '패키지' ? '출시' : event.type === '퍼스트서버' ? '패치' : '적용',
  },
  ...(event.type === '패키지' ? [{ key: 'ends', label: '종료' }] : []),
];

const eventDate = (d) => d
  ? new Date(`${d}T00:00:00+09:00`).toLocaleDateString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric' })
  : '미확인';

function isoDow(d) {
  const day = new Date(`${d}T12:00:00Z`).getUTCDay();
  return day || 7;
}

function eventStageStudy(stage, days) {
  if (!stage.date) return { state: 'missing' };
  const today = new Date(DATA.builtAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const complete = days.filter((x) => x.d < today && x.vwap > 0 && x.qty > 0);
  if (!complete.length || stage.date < complete[0].d) return { state: 'before' };
  if (stage.date > today) return { state: 'scheduled' };

  const before = complete.filter((x) => x.d < stage.date).slice(-3);
  const after = complete.filter((x) => x.d >= stage.date).slice(0, 3);
  if (before.length < 3 || after.length < 3) return { state: 'waiting' };

  const weekdays = DATA.weekday ?? [];
  if (weekdays.length < 7) return { state: 'weekday' };
  const meanRet = weekdays.reduce((sum, x) => sum + x.ret, 0) / weekdays.length;
  const weekdayBy = new Map(weekdays.map((x) => [x.k, x]));
  const mean = (xs, value) => xs.reduce((sum, x) => sum + value(x), 0) / xs.length;
  const adjustedPrice = (x) => x.vwap / Math.exp(((weekdayBy.get(isoDow(x.d))?.ret ?? meanRet) - meanRet) / 100);
  const adjustedQty = (x) => x.qty / (weekdayBy.get(isoDow(x.d))?.vol || 1);

  return {
    state: 'ready',
    price: (mean(after, adjustedPrice) / mean(before, adjustedPrice) - 1) * 100,
    qty: (mean(after, adjustedQty) / mean(before, adjustedQty) - 1) * 100,
  };
}

function eventTimeline(events, days, forecast) {
  if (!days.length) return [];
  // 가격선이 과거 이벤트 때문에 눌리지 않도록 이력 시작 직전의 패치만 축에 보탠다.
  const firstDate = new Date(`${days[0].d}T12:00:00Z`);
  firstDate.setUTCDate(firstDate.getUTCDate() - 3);
  const first = firstDate.toISOString().slice(0, 10);
  const relatedFirstDate = new Date(`${days[0].d}T12:00:00Z`);
  relatedFirstDate.setUTCDate(relatedFirstDate.getUTCDate() - 45);
  const relatedFirst = relatedFirstDate.toISOString().slice(0, 10);
  const last = forecast?.points?.at(-1)?.d ?? days.at(-1).d;
  const byDate = new Map();
  for (const event of events) {
    const date = event.starts;
    const minDate = event.related_item_ids?.length ? relatedFirst : first;
    if (!date || date < minDate || date > last) continue;
    if (!byDate.has(date)) byDate.set(date, { date, events: [] });
    byDate.get(date).events.push(event);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const EVENT_TYPES = {
  퍼스트서버: { badge: '퍼', label: '퍼스트서버' },
  대규모: { badge: '대', label: '대규모' },
  주요: { badge: '주', label: '주요' },
  패키지: { badge: '패', label: '패키지 출시' },
};

const eventTypeLabel = (type) => EVENT_TYPES[type]?.label ?? type;

function renderEventRail(chart, groups) {
  const rail = document.getElementById('event-rail');
  if (!groups.length) {
    rail.hidden = true;
    return;
  }
  rail.hidden = false;
  rail.innerHTML = groups.map((group, index) => {
    const byType = new Map();
    for (const event of group.events) {
      if (!byType.has(event.type)) byType.set(event.type, []);
      byType.get(event.type).push(event);
    }
    const pins = [...byType].map(([type, events]) => {
      const meta = EVENT_TYPES[type];
      const action = type === '패키지' ? '출시' : '패치';
      const title = events.map((event) => `[${meta.label}] ${event.name}`).join('\n');
      return `<button class="event-pin ${type}" type="button" title="${esc(title)}" aria-label="${esc(`${group.date} ${action} · ${title}`)}">${meta.badge}</button>`;
    }).join('');
    return `<div class="event-pin-group" data-event-pin="${index}">${pins}</div>`;
  }).join('');
  rail.onclick = (event) => {
    if (event.target.closest('.event-pin')) document.getElementById('event-details').open = true;
  };

  requestAnimationFrame(() => {
    for (const [index, group] of groups.entries()) {
      const pin = rail.querySelector(`[data-event-pin="${index}"]`);
      const x = chart.timeScale().timeToCoordinate(group.date);
      if (x === null) { pin.hidden = true; continue; }
      const half = pin.offsetWidth / 2;
      pin.style.left = `${Math.max(half + 2, Math.min(rail.clientWidth - half - 2, x))}px`;
    }
  });
}

function eventStudyHTML(events, days) {
  if (!events.length) return '<p class="event-empty">연결된 이벤트가 아직 없습니다.</p>';
  const stateText = {
    missing: '날짜 미확인', before: '수집 시작 전', scheduled: '예정', waiting: '전후 3일 대기 중',
    weekday: '요일 표본 대기 중',
  };
  return `<div class="event-list">${events.map((event) => {
    const href = /^https?:\/\//.test(event.source_url ?? '')
      ? `<a href="${esc(event.source_url)}" target="_blank" rel="noopener">근거 보기 ↗</a>`
      : '<span class="event-source">출처 미등록</span>';
    return `<div class="event-row" id="event-${event.id}">
      <div class="event-name"><span class="tag">${esc(eventTypeLabel(event.type))}</span>${event.related_item_ids?.length ? '' : '<span class="tag g">전체</span>'}<b>${esc(event.name)}</b>${href}</div>
      <div class="event-stages">${eventStages(event).map((stage) => {
        const result = eventStageStudy({ date: event[stage.key] }, days);
        const effect = result.state === 'ready'
          ? `요일 보정 VWAP <b class="${cls(result.price)}">${pct(result.price)}</b> · API 관측 수량 <b class="${cls(result.qty)}">${pct(result.qty)}</b>`
          : stateText[result.state];
        return `<div><span>${stage.label}</span><b>${eventDate(event[stage.key])}</b><small>${effect}</small></div>`;
      }).join('')}</div>
    </div>`;
  }).join('')}</div>`;
}

// 수집이 없던 시간은 0이 아니라 공백이다. 7일 시간축을 직접 채우되,
// 관측된 0만 value: 0으로 두고 미관측 시간은 whitespace point로 남긴다.
function depletionSeries(rows) {
  const byHour = new Map(rows.map((x) => [Math.floor(Date.parse(x.t) / 3600000), x.rate]));
  const end = Math.floor(Date.parse(DATA.builtAt) / 3600000);
  const start = end - 7 * 24 + 1;
  const points = [];
  for (let hour = start; hour <= end; hour++) {
    const value = byHour.get(hour);
    points.push(value === undefined
      ? { time: hour * 3600 }
      : { time: hour * 3600, value });
  }
  return points;
}

let DATA = null;
let tab = '전체';
// 기본 정렬은 24h 거래대금. 변동률로 정렬하면 하루 한두 건 거래된 아이템의
// 의미 없는 ±40%가 맨 위를 차지한다.
let job = '딜러';
let sortKey = 'turnover';
let sortDir = -1;

async function boot() {
  DATA = await (await fetch('data/summary.json')).json();
  const b = new Date(DATA.builtAt);
  document.getElementById('built').textContent =
    b.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 기준';
  render();
  addEventListener('hashchange', render);
}

const enrich = (it) => ({
  ...it,
  chg: it.vwap24 && it.vwap_prev ? (it.vwap24 / it.vwap_prev - 1) * 100 : null,
  turnover: (it.vwap24 ?? it.last_price) * it.api_qty24,
  g: grade(it),
});

function render() {
  const id = location.hash.slice(1);
  const it = DATA.items.find((x) => x.item_id === id);
  scrollTo(0, 0);
  if (it) renderDetail(enrich(it)); else renderList();
}

// 요약 카드는 목록과 인벤토리 두 뷰가 공유한다.
// 프로젝트의 결론(레전더리 최저가·해체 차익·목요일 효과)을 첫 화면에 올린다.
function summaryCards() {
  const m = DATA.meta;
  const lg = DATA.legendary?.[0];
  const mg = DATA.margin;
  const netMargin = mg?.pkg ? (mg.partsSum * (1 - mg.fee) / mg.pkg - 1) * 100 : null;
  const w = DATA.weekday ?? [];
  const thu = (() => {
    if (!w.length) return null;
    const mean = w.reduce((a, x) => a + x.ret, 0) / w.length;
    const t = w.find((x) => x.k === 4);
    return t ? t.ret - mean : null;
  })();

  return `<div class="cards">
    <div class="card">
      <div class="k">추적 아이템</div>
      <div class="v">${m.items}<small>종</small></div>
      <div class="sub">체결 ${fmt(m.trades)}건 · ${m.lo}~${m.hi}</div>
    </div>
    ${lg ? `<div class="card hl">
      <div class="k">레전더리 카드 최저가</div>
      <div class="v">${fmt(lg.min_unit_price)}</div>
      <div class="sub">${esc(lg.min_item_name)} · ${lg.with_listings}/${lg.scanned}종 매물</div>
    </div>` : ''}
    ${netMargin !== null ? `<div class="card">
      <div class="k">패키지 해체 차익</div>
      <div class="v ${cls(netMargin)}">${pct(netMargin)}</div>
      <div class="sub">수수료 3% 반영 · 유랑악단</div>
    </div>` : ''}
    ${thu !== null ? `<div class="card">
      <div class="k">목요일 효과</div>
      <div class="v ${cls(thu)}">${pct(thu)}</div>
      <div class="sub">주간 평균 대비 · p&lt;0.05</div>
    </div>` : ''}
  </div>`;
}

function categoryTabs(cats) {
  const right = ['크리쳐', '오라', '칭호'].filter((c) => cats.includes(c));
  const left = cats.filter((c) => !right.includes(c));
  const button = (c) => `<button class="tab ${c === tab ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`;
  return `<div class="tabs">
    ${['전체', ...left].map(button).join('')}
    <div class="tabs-end">${right.map(button).join('')}</div>
  </div>`;
}

// ── 목록 ───────────────────────────────────────────────────────
function renderList() {
  const all = DATA.items.map(enrich);
  const cats = [...new Set(all.map((x) => x.category))]
    .map((c) => ({ c, sum: all.filter((x) => x.category === c).reduce((a, x) => a + x.turnover, 0) }))
    .sort((a, b) => b.sum - a.sum).map((x) => x.c);

  if (tab === '카드') { renderInventory(all, cats); return; }

  const rows = (tab === '전체' ? all : all.filter((x) => x.category === tab))
    .sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sortDir;
    });

  document.getElementById('view').innerHTML = `
    ${summaryCards()}

    ${categoryTabs(cats)}

    <div class="list">
      <div class="lh">
        <span class="r">#</span>
        <span data-k="item_name">아이템</span>
        <span class="r" data-k="last_price">현재가</span>
        <span class="r" data-k="chg">24h</span>
        <span class="r h5" data-k="turnover">관측 거래대금</span>
        <span class="r h6">14일 추이</span>
        <span class="r h7" data-k="listings">매물</span>
      </div>
      ${rows.map((r, i) => {
        const color = css(r.chg > 0 ? '--up' : r.chg < 0 ? '--down' : '--ink-4');
        const thin = r.api_qty24 < 5 && r.chg !== null;
        return `<div class="row" data-id="${r.item_id}">
          <div class="rank r">${i + 1}</div>
          <div class="nm">
            <img src="${r.img}" alt="" loading="lazy" width="32" height="32">
            <div class="t">
              <b>${esc(r.item_name)}${r.is_final ? '<span class="tag fin">종결</span>' : ''}${r.slot ? `<span class="tag">${esc(r.slot)}</span>` : ''}</b>
              <span>${esc(r.item_rarity)}${r.job_role ? ' · ' + esc(r.job_role) : ''}${r.key_stat ? ' · ' + esc(r.key_stat) : ''} · 표본 ${fmt(r.trades)} · ${r.g}등급${r.final_since ? ` · 종결 D+${sinceDays(r.final_since)}` : ''}</span>
            </div>
          </div>
          <div class="px">${fmt(r.last_price)}</div>
          <div class="chg ${thin ? 'flat' : cls(r.chg)}"${thin ? ' title="24h 표본 5개 미만 — 신뢰하기 어렵습니다"' : ''}>${pct(r.chg)}${thin ? '<span style="color:var(--ink-4)">?</span>' : ''}</div>
          <div class="dim c5">${won(r.turnover)}</div>
          <div class="c6">${sparkSVG(r.spark, color)}</div>
          <div class="dim c7">${fmt(r.listings)}</div>
        </div>`;
      }).join('')}
    </div>

    <p class="hint">
      기본 정렬은 <b>24h 거래대금</b>입니다. 변동률로 정렬하면 하루 한두 건 거래된 아이템의 의미 없는 ±40%가 맨 위를 차지합니다.
      같은 이유로 24h 표본이 5개 미만인 변동률에는 <b>?</b>를 붙였습니다.<br>
      <b>등급</b>은 일평균 체결 건수입니다 — A ≥ 60건, B ≥ 20건, C ≥ 5건, D는 그 미만.
      <b>종결</b>은 현재 기준 최상위 아이템이며, 패치로 교체되면 갱신됩니다.
    </p>`;

  document.querySelectorAll('.row').forEach((el) => {
    el.onclick = () => { location.hash = el.dataset.id; };
  });
  document.querySelectorAll('.tab').forEach((el) => {
    el.onclick = () => { tab = el.dataset.c; renderList(); scrollTo(0, 0); };
  });
  document.querySelectorAll('.lh [data-k]').forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.k;
      sortDir = sortKey === k ? -sortDir : (k === 'item_name' ? 1 : -1);
      sortKey = k;
      renderList();
    };
  });
}


// ── 인챈트 인벤토리 ────────────────────────────────────────────
// 카드는 "부위마다 무엇을 끼울까"로 보는 물건이라, 가격순 리스트보다
// 던파 장비창 배치가 실제 사용 맥락에 맞는다.
const SLOT_GROUPS = [
  ['무기', ['무기']],
  ['방어구', ['상의', '하의', '머리어깨', '벨트', '신발']],
  ['악세서리', ['팔찌', '목걸이', '반지']],
  ['특수장비', ['보조장비', '마법석', '귀걸이']],
];

function renderInventory(all, cats) {
  const cards = all.filter((x) => x.category === '카드' && x.job_role === job);
  const bySlot = new Map();
  for (const c of cards) {
    if (!bySlot.has(c.slot)) bySlot.set(c.slot, []);
    bySlot.get(c.slot).push(c);
  }
  for (const list of bySlot.values()) list.sort((a, b) => b.last_price - a.last_price);

  const total = cards.reduce((a, c) => a + (c.min_ask || c.last_price || 0), 0);

  document.getElementById('view').innerHTML = `
    ${summaryCards()}
    ${categoryTabs(cats)}

    <div class="job-sw">
      ${['딜러', '버퍼'].map((j) => `<button class="${j === job ? 'on' : ''}" data-j="${j}">${j}</button>`).join('')}
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="k">${job} 종결 인챈트 풀세트</div>
      <div class="v">${fmt(total)}<small>골드</small></div>
      <div class="sub">부위별 최저 호가 합계 · ${cards.length}종</div>
    </div>

    ${SLOT_GROUPS.map(([g, slots]) => `
      <div class="inv-group">
        <h4>${g}</h4>
        <div class="inv-grid">
          ${slots.map((sl) => {
            const list = bySlot.get(sl) ?? [];
            if (!list.length) return `<div class="slot empty">${sl}<br>미등록</div>`;
            return list.map((c) => `
              <div class="slot" data-id="${c.item_id}">
                <div class="sl">${sl}</div>
                <div class="card-row">
                  <img src="${c.img}" alt="" loading="lazy" width="30" height="30">
                  <div class="cn">
                    <b>${esc(c.item_name.replace(/ 카드$/, ''))}</b>
                    ${c.key_stat ? `<div class="ks">${esc(c.key_stat)}</div>` : ''}
                    <div class="p">${fmt(c.min_ask || c.last_price)}
                      <i class="${c.api_qty24 < 5 ? 'flat' : cls(c.chg)}">${pct(c.chg)}</i></div>
                  </div>
                </div>
              </div>`).join('');
          }).join('')}
        </div>
      </div>`).join('')}

    <p class="hint">표시 가격은 <b>최저 호가</b>이고, 없으면 최근 체결가입니다.</p>`;

  document.querySelectorAll('.slot[data-id]').forEach((el) => {
    el.onclick = () => { location.hash = el.dataset.id; };
  });
  document.querySelectorAll('.job-sw button').forEach((el) => {
    el.onclick = () => { job = el.dataset.j; renderList(); };
  });
  document.querySelectorAll('.tab').forEach((el) => {
    el.onclick = () => { tab = el.dataset.c; renderList(); scrollTo(0, 0); };
  });
}

// ── 상세 ───────────────────────────────────────────────────────
async function renderDetail(it) {
  const hasDepth = ['재료·소모품', '소울 결정'].includes(it.category);
  document.getElementById('view').innerHTML = `
    <a class="back" href="#">← 전체 목록</a>
    <div class="dh">
      <img src="${it.img}" alt="" width="48" height="48">
      <div>
        <h2>${esc(it.item_name)}${it.is_final ? '<span class="tag fin">종결</span>' : ''}</h2>
        <div class="meta">${esc(it.item_rarity)} · ${esc(it.item_type_detail)}${it.slot ? ' · ' + esc(it.slot) : ''}${it.job_role ? ' · ' + esc(it.job_role) : ''}${it.key_stat ? ' · ' + esc(it.key_stat) : ''}</div>
        ${it.final_since ? `<div class="meta">종결 지정 ${it.final_since} · <b style="color:var(--ink-2)">D+${sinceDays(it.final_since)}일차</b></div>` : ''}
      </div>
    </div>
    <div class="bigpx">${fmt(it.last_price)}<small>골드</small></div>
    <div class="bigchg ${cls(it.chg)}">${pct(it.chg)} <span style="color:var(--ink-3);font-weight:500">24시간</span></div>

    <div class="panel"><div class="kv">
      <div><div class="k">24h VWAP</div><div class="v">${fmt(it.vwap24)}</div></div>
      <div><div class="k">24h API 관측 수량</div><div class="v">${fmt(it.api_qty24)}</div></div>
      <div><div class="k">최저 호가</div><div class="v">${fmt(it.min_ask)}</div></div>
      <div><div class="k">등록 매물</div><div class="v">${fmt(it.listings)}</div></div>
      <div><div class="k">표본</div><div class="v">${fmt(it.trades)} <span style="font-size:12px;color:var(--ink-3);font-weight:500">${it.g}등급</span></div></div>
      <div><div class="k">이력</div><div class="v">${it.span_days >= 1 ? it.span_days.toFixed(1) + '일' : (it.span_days * 24).toFixed(0) + '시간'}</div></div>
    </div></div>

    <div class="panel">
      <h3>가격 · 예측</h3>
      <p class="desc" id="fc-desc">불러오는 중…</p>
      <div class="chart" id="c1"></div>
      <div class="event-rail" id="event-rail" aria-label="가격 영향 이벤트 태그" hidden></div>
      <details class="event-study" id="event-details">
        <summary><span>가격 영향 이벤트 · 이벤트 스터디</span><small id="event-count"></small><i aria-hidden="true">⌄</i></summary>
        <div class="event-body">
          <p class="desc">실제 시장 충격일인 패치·적용·출시일을 기준으로 봅니다. 패키지는 종료일도 별도로 계산합니다. 전후 수치는 요일효과를 보정한 3일 평균 비교이며, 동시 발생이 인과관계를 뜻하지는 않습니다.</p>
          <div id="event-list"></div>
        </div>
      </details>
    </div>
    <div class="panel">
      <h3>아이템별 요일 프로파일</h3>
      <p class="desc" id="weekday-desc">완료된 일봉을 분석하는 중…</p>
      <div id="weekday-profile"></div>
    </div>
    <div class="panel">
      <h3>호가–체결 갭</h3>
      <p class="desc">최저 호가가 각 관측 시점의 직전 24시간 체결 VWAP보다 얼마나 높거나 낮은지 보여줍니다. 양수면 매물 부족 또는 상승 기대, 음수면 급매 신호일 수 있습니다.</p>
      <div class="chart" id="c4"></div>
    </div>
    <div class="panel">
      <h3>가격 × API 관측 거래량 4분면</h3>
      <p class="desc" id="shock-desc">완료된 일봉을 분석하는 중… API 100건 상한에 걸린 급증 구간은 실제보다 작게 보일 수 있습니다.</p>
      <div id="c5"></div>
    </div>
    ${hasDepth ? `<div class="panel">
      <h3>매물 사다리</h3>
      <p class="desc">현재 매물을 낮은 호가부터 누적합니다. 최저가 한 건이 아니라 원하는 수량을 실제로 살 때의 평균 단가를 보여줍니다.</p>
      <div id="depth">불러오는 중…</div>
    </div>` : ''}
    <div class="panel">
      <h3>매물 소진 속도</h3>
      <p class="desc">최근 7일의 관측 소진량을 실제 수집 간격으로 나눠 시간당 환산합니다. 수량 감소는 직접 확인한 값이지만, 만료 전에 사라진 매물은 판매와 취소를 구분할 수 없는 추정치입니다. 빈 구간은 수집되지 않은 시간입니다.</p>
      <div class="kv depth-kv" id="depletion-kv"></div>
      <div class="chart" id="c6"></div>
    </div>
    <div class="panel"><h3>최근 7일 · 시간별 VWAP</h3><div class="chart" id="c3"></div></div>
    <div class="panel"><h3>일별 API 관측 체결 수량</h3><div class="chart sm" id="c2"></div></div>`;

  const s = await (await fetch(`data/series/${it.item_id}.json`)).json();
  if (hasDepth) {
    const depth = s.depth ?? [];
    const q10 = depthQuote(depth, 10), q100 = depthQuote(depth, 100);
    const totalQty = depth.reduce((sum, level) => sum + level.qty, 0);
    const quote = (q, target) => q.avg !== null
      ? `<div class="v">${fmt(q.avg)}<small> 골드</small></div>`
      : `<div class="v flat">매물 부족</div><div class="depth-sub">${fmt(q.filled)}/${target}개</div>`;
    document.getElementById('depth').innerHTML = depth.length ? `
      <div class="kv depth-kv">
        <div><div class="k">10개 구매 평균</div>${quote(q10, 10)}</div>
        <div><div class="k">100개 구매 평균</div>${quote(q100, 100)}</div>
        <div><div class="k">현재 열린 수량</div><div class="v">${fmt(totalQty)}<small> 개</small></div></div>
      </div>
      ${depthSVG(depth)}`
      : '<p style="color:var(--ink-3);margin:0">현재 열린 매물이 없습니다.</p>';
  }
  const opts = {
    layout: { background: { color: 'transparent' }, textColor: css('--ink-3'), fontFamily: 'Pretendard, system-ui, sans-serif' },
    grid: { vertLines: { visible: false }, horzLines: { color: css('--line') } },
    // 가격대가 수십 배 차이 나는 아이템이 섞여 있고 예측 구간도 넓다.
    // 로그 스케일이라야 실측 구간이 눌리지 않는다.
    rightPriceScale: { borderVisible: false, mode: 1 },
    timeScale: { borderVisible: false },
    crosshair: { mode: 0 },
    localization: { locale: 'ko-KR', priceFormatter: (v) => fmt(v) },
  };

  const d = s.daily ?? [];
  const desc = document.getElementById('fc-desc');
  const shock = shockData(d);
  const depletion = s.depletion ?? [];
  const firstDay = d[0]?.d;
  const lastDay = d.at(-1)?.d;
  const events = (s.events ?? []).filter((event) => {
    if (!EVENT_TYPES[event.type]) return false;
    if (event.related_item_ids?.length) return true;
    return firstDay && lastDay && event.starts >= firstDay && event.starts <= lastDay;
  });
  document.getElementById('event-count').textContent = `${events.length}건`;
  document.getElementById('event-list').innerHTML = eventStudyHTML(events, d);

  const weekday = weekdayProfile(d, events);
  const weekdayDesc = document.getElementById('weekday-desc');
  const weekdayEl = document.getElementById('weekday-profile');
  if (weekday.state === 'ready') {
    const thursday = weekday.points[3];
    weekdayDesc.innerHTML =
      `완료 일봉 <b>${weekday.used}일</b>을 사용해 아이템 평균을 100으로 환산했습니다. ` +
      `패치·출시·종료 전후 3일 <b>${weekday.excluded}일</b>은 제외했습니다. ` +
      `목요일은 가격 <b>${thursday.price.toFixed(1)}</b> · API 관측 수량 <b>${thursday.qty.toFixed(1)}</b>입니다.`;
    weekdayEl.innerHTML = `<div class="weekday-grid">
      ${weekdaySVG(weekday.points, 'price', '가격 지수')}
      ${weekdaySVG(weekday.points, 'qty', 'API 관측 수량 지수')}
    </div>`;
  } else if (weekday.state === 'history') {
    weekdayDesc.textContent = `최소 31일의 이력이 필요합니다. 완료 일봉 범위는 현재 ${weekday.span}일이며 ${weekday.remaining}일 더 필요합니다.`;
    weekdayEl.innerHTML = '<p class="weekday-empty">충분한 이력이 쌓이면 월요일부터 일요일까지의 패턴을 표시합니다.</p>';
  } else {
    const labels = ['월', '화', '수', '목', '금', '토', '일'];
    weekdayDesc.textContent =
      `31일 이력은 충족했지만 이벤트 구간을 제외한 요일별 표본이 부족합니다. ` +
      `${labels.map((label, index) => `${label} ${weekday.counts[index]}일`).join(' · ')} (요일당 최소 3일)`;
    weekdayEl.innerHTML = `<p class="weekday-empty">사용 가능 ${weekday.used}일 · 이벤트 전후 제외 ${weekday.excluded}일</p>`;
  }

  if (depletion.length) {
    const cutoff = Date.parse(DATA.builtAt) - 24 * 3600000;
    const recent = depletion.filter((x) => Date.parse(x.t) >= cutoff);
    const sum = (key) => recent.reduce((total, x) => total + x[key], 0);
    const observedHours = sum('observed_min') / 60;
    const qty = sum('qty');
    document.getElementById('depletion-kv').innerHTML = `
      <div><div class="k">24h 관측 소진</div><div class="v">${fmt(qty)}<small> 개</small></div></div>
      <div><div class="k">시간당 평균</div><div class="v">${observedHours ? fmt(qty / observedHours) : '-'}<small> 개/시간</small></div></div>
      <div><div class="k">수량 감소 확인</div><div class="v">${fmt(sum('partial'))}<small> 개</small></div></div>
      <div><div class="k">조기 소멸 추정</div><div class="v">${fmt(sum('vanished'))}<small> 개</small></div></div>`;

    const c6 = LightweightCharts.createChart(document.getElementById('c6'), {
      ...opts, height: 300, rightPriceScale: { borderVisible: false, mode: 0 },
      localization: { locale: 'ko-KR', priceFormatter: (v) => `${fmt(v)}개/h` },
    });
    c6.addAreaSeries({
      lineColor: css('--gold'), topColor: css('--gold') + '33', bottomColor: css('--gold') + '08',
      lineWidth: 2, priceFormat: { type: 'custom', formatter: (v) => `${fmt(v)}개/h` },
    }).setData(depletionSeries(depletion));
    c6.timeScale().fitContent();
  } else {
    document.getElementById('depletion-kv').innerHTML = '';
    document.getElementById('c6').innerHTML = '<p style="color:var(--ink-3);margin:0">소진 속도를 계산할 연속 매물 관측이 아직 없습니다.</p>';
  }

  if (shock) {
    const latest = shock.latest;
    document.getElementById('shock-desc').innerHTML =
      `최근 ${shock.points.length}개 완료 일봉의 평균을 기준으로 봅니다. 마지막 완료일 <b>${latest.d}</b>은 ` +
      `<b>${shockName(latest)}</b> 구역입니다 · API 관측 거래량 ${pct(latest.qty)}, 가격 ${pct(latest.price)}. ` +
      '100건 상한에 걸린 날의 실제 거래량은 더 클 수 있습니다.';
    document.getElementById('c5').innerHTML = shockSVG(shock.points);
  } else {
    document.getElementById('shock-desc').textContent =
      '당일을 제외한 완료 일봉이 3일 이상 쌓이면 분류합니다. API 100건 상한에 걸린 급증 구간은 실제보다 작게 보일 수 있습니다.';
    document.getElementById('c5').innerHTML = '<p style="color:var(--ink-3);margin:0">아직 비교할 완료 일봉이 부족합니다.</p>';
  }

  if (d.length >= 2) {
    const c1 = LightweightCharts.createChart(document.getElementById('c1'), { ...opts, height: 300 });
    const timeline = eventTimeline(events, d, s.forecast);
    const priceSeries = c1.addCandlestickSeries({
      upColor: css('--up'), downColor: css('--down'), borderVisible: false,
      wickUpColor: css('--up'), wickDownColor: css('--down'),
    });
    priceSeries.setData(d.map((x) => ({ time: x.d, open: x.o, high: x.h, low: x.l, close: x.c })));
    if (timeline.length) {
      c1.addLineSeries({
        lineVisible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      }).setData(timeline.map((x) => ({ time: x.date, value: d[0].vwap })));
    }

    if (s.forecast) {
      const f = s.forecast;
      // 캔들은 종가, 예측은 VWAP 기준이다. 서로 다른 값을 억지로 이으면
      // 가짜 급등락처럼 보이므로 점선은 첫 예측일부터 시작한다.
      const band = (key, w) => c1.addLineSeries({
        color: css('--blue'), lineWidth: w, lineStyle: 2,
        crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false,
      }).setData(f.points.map((p) => ({ time: p.d, value: p[key] })));
      band('hi', 1); band('lo', 1); band('mid', 2);

      const p0 = f.points[0];
      desc.innerHTML =
        `캔들은 일별 시가·고가·저가·종가이며 오늘 봉은 수집 중입니다. 점선은 다음 날부터의 VWAP 기준 <b>${f.horizonDays}일 예측</b>입니다. ` +
        `내일 예상 <b>${fmt(p0.mid)}</b>, 80% 구간 ${fmt(p0.lo)}~${fmt(p0.hi)}. ` +
        (f.vsNaive !== null
          ? `백테스트에서 naive(마지막 값 유지) 대비 MAPE가 <b class="${f.vsNaive > 0 ? 'up' : 'down'}">${f.vsNaive.toFixed(1)}%</b> ${f.vsNaive > 0 ? '개선' : '악화'}됐고 구간 커버리지는 ${f.coverage?.toFixed(0)}%입니다.`
          : '표본이 얇아 백테스트는 생략했습니다.') +
        `<br><span style="color:var(--ink-4)">모델 — ${esc(f.method)}</span>`;
    } else {
      desc.textContent = '캔들은 일별 시가·고가·저가·종가이며 오늘 봉은 수집 중입니다. 예측에는 일봉이 최소 10일 필요합니다.';
    }
    c1.timeScale().fitContent();
    renderEventRail(c1, timeline);

    const c2 = LightweightCharts.createChart(document.getElementById('c2'), { ...opts, height: 130 });
    c2.addHistogramSeries({ color: css('--blue') }).setData(d.map((x) => ({ time: x.d, value: x.qty })));
    c2.timeScale().fitContent();
  } else {
    document.getElementById('c1').innerHTML = '<p style="color:var(--ink-3);margin:0">일봉을 그릴 만큼 데이터가 모이지 않았습니다.</p>';
    desc.textContent = '';
  }

  if (s.hourly?.length) {
    const c3 = LightweightCharts.createChart(document.getElementById('c3'), { ...opts, height: 300 });
    c3.addAreaSeries({
      lineColor: css('--blue'), topColor: css('--blue') + '33', bottomColor: css('--blue') + '08', lineWidth: 2,
    }).setData(s.hourly.map((h) => ({ time: Math.floor(Date.parse(h.t) / 1000), value: h.vwap })));
    c3.timeScale().fitContent();
  }

  if (s.askGap?.length) {
    const c4 = LightweightCharts.createChart(document.getElementById('c4'), {
      ...opts, height: 300, rightPriceScale: { borderVisible: false },
      localization: { locale: 'ko-KR', priceFormatter: (v) => pct(v) },
    });
    c4.addBaselineSeries({
      baseValue: { type: 'price', price: 0 },
      topLineColor: css('--up'), topFillColor1: css('--up') + '33', topFillColor2: css('--up') + '08',
      bottomLineColor: css('--down'), bottomFillColor1: css('--down') + '08', bottomFillColor2: css('--down') + '33',
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v) => pct(v) },
    }).setData(s.askGap.map((x) => ({ time: Math.floor(Date.parse(x.t) / 1000), value: x.gap })));
    c4.timeScale().fitContent();
  } else {
    document.getElementById('c4').innerHTML = '<p style="color:var(--ink-3);margin:0">비교할 호가와 직전 24시간 체결 데이터가 아직 없습니다.</p>';
  }
}

boot();
