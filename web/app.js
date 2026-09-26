// 대시보드 + 아이템 상세. 해시 라우팅으로 한 페이지에서 처리한다.

import { askGap, representativePrice, matchesCategory, summarizeWeekdays, pricePosition, candleZoom } from './metrics.js?v=20260927-candle-zoom';
import * as packageUI from './package.js?v=20260918';

const fmt = (n, d = 0) => n === null || n === undefined || !isFinite(n)
  ? '-' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d });
const won = (n) => !isFinite(n) || n === null ? '-'
  : n >= 100000000 ? (n / 100000000).toFixed(1) + '억'
  : n >= 10000 ? Math.round(n / 10000).toLocaleString('ko-KR') + '만' : fmt(n);
const pct = (n) => n === null || !isFinite(n) ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const cls = (n) => n === null || !isFinite(n) || Math.abs(n) < 0.005 ? 'flat' : n > 0 ? 'up' : 'down';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const css = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
const priceTime = (value) => value ? new Date(value).toLocaleString('ko-KR', {
  timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}) : '기록 없음';

// 목록의 거래 시각. 터치 화면에는 툴팁이 없으므로 화면에 직접 쓴다.
// 기준일과 같은 날이면 시각만, 아니면 날짜만 보여 줘 폭을 아낀다.
const tradeClock = (value, asOf) => {
  if (!value) return '';
  const day = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  return day(value) === day(asOf)
    ? new Date(value).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })
    : day(value).slice(5).replace('-', '.');
};

// 카드 목록에서는 같은 능력치 이름을 반복하지 않고 0업→맥스업 변화만 압축한다.
// 이름이나 순서가 달라지면 억지로 합치지 않고 두 단계의 원문을 모두 보여준다.
function statTransition(base, max) {
  if (!base) return max ? `맥스업 ${max}` : '';
  if (!max || base === max) return base;
  const parse = (text) => text.split(' · ').map((part) => {
    const match = part.match(/^(.*?)\s+([+-]?\d+(?:\.\d+)?%?)$/);
    return match ? { name: match[1], value: match[2] } : null;
  });
  const from = parse(base), to = parse(max);
  if (from.some((part) => !part) || to.some((part) => !part) ||
      from.length !== to.length || from.some((part, i) => part.name !== to[i].name)) {
    return `0업 ${base} → 맥스업 ${max}`;
  }
  return from.map((part, i) => `${part.name} ${part.value === to[i].value
    ? part.value : `${part.value}→${to[i].value}`}`).join(' · ');
}

// KST 기준일을 D+0으로 센다. 경과일만으로 다음 성능 갱신 시점을 예측하지 않는다.
const sinceDays = (d) => d ? Math.floor((Date.now() - Date.parse(d + 'T00:00:00+09:00')) / 86400000) : null;

// 유동성 등급 — "이 아이템의 지표를 믿어도 되는가"를 한 글자로.
// 표본이 얇으면 어떤 가격 지표도 신뢰할 수 없으므로 등급을 먼저 보여준다.
function grade(it) {
  if (it.price_basis === 'ask0') return null;
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

function weekdaySVG(points, key, title, baselineLabel = '아이템 평균 100', reference = 100) {
  const W = 420, H = 220, L = 28, R = 14, T = 34, B = 34;
  const plotW = W - L - R, plotH = H - T - B;
  const maxDeviation = Math.max(5, ...points.map((point) => Math.abs((point[key] ?? reference) - reference))) * 1.2;
  const low = reference - maxDeviation, high = reference + maxDeviation;
  const yAt = (value) => T + (high - value) / (high - low) * plotH;
  const baseline = yAt(reference);
  const slot = plotW / points.length;
  const barWidth = Math.min(30, slot * 0.54);
  const aria = points.map((point) => `${point.label}요일 ${point[key] === null ? '관측 없음' : point[key].toFixed(1)}, 표본 ${point.n}일`).join(', ');

  return `<div class="weekday-chart">
    <h4>${title}</h4>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${title}. ${baselineLabel}. ${aria}`)}">
      <title>${esc(`${title} · ${baselineLabel}`)}</title>
      <rect class="weekday-thursday" x="${L + slot * 3}" y="${T - 8}" width="${slot}" height="${plotH + 25}" rx="8"/>
      <line class="weekday-baseline" x1="${L}" y1="${baseline}" x2="${W - R}" y2="${baseline}"/>
      <text class="weekday-axis" x="${L - 5}" y="${baseline + 4}" text-anchor="end">${reference}</text>
      ${points.map((point, index) => {
        const x = L + slot * index + (slot - barWidth) / 2;
        if (point[key] === null) return `<text class="weekday-value" x="${x + barWidth / 2}" y="${baseline - 8}" text-anchor="middle">—</text><text class="weekday-label" x="${x + barWidth / 2}" y="${H - 8}" text-anchor="middle">${point.label}</text>`;
        const y = yAt(point[key]);
        const top = Math.min(y, baseline);
        const height = Math.max(2, Math.abs(y - baseline));
        return `<rect class="weekday-bar ${point[key] >= reference ? 'above' : 'below'}" x="${x}" y="${top}" width="${barWidth}" height="${height}" rx="4">
          <title>${point.label}요일 · ${point[key].toFixed(1)} · 표본 ${point.n}일</title>
        </rect>
        <text class="weekday-value" x="${x + barWidth / 2}" y="${point[key] >= reference ? top - 6 : top + height + 14}" text-anchor="middle">${point[key].toFixed(1)}</text>
        <text class="weekday-label${point.k === 4 ? ' thursday' : ''}" x="${x + barWidth / 2}" y="${H - 8}" text-anchor="middle">${point.label}</text>`;
      }).join('')}
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

function eventStageStudy(stage, days, priceBasis) {
  if (!stage.date) return { state: 'missing' };
  const today = new Date(DATA.builtAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const complete = days.filter((x) => x.d < today && x.vwap > 0 && (priceBasis !== 'trade' || x.qty > 0));
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
    qty: priceBasis !== 'trade' ? null : (mean(after, adjustedQty) / mean(before, adjustedQty) - 1) * 100,
  };
}

function eventTimeline(events, days) {
  if (!days.length) return [];
  // 가격선이 과거 이벤트 때문에 눌리지 않도록 이력 시작 직전의 패치만 축에 보탠다.
  const firstDate = new Date(`${days[0].d}T12:00:00Z`);
  firstDate.setUTCDate(firstDate.getUTCDate() - 3);
  const first = firstDate.toISOString().slice(0, 10);
  const relatedFirstDate = new Date(`${days[0].d}T12:00:00Z`);
  relatedFirstDate.setUTCDate(relatedFirstDate.getUTCDate() - 45);
  const relatedFirst = relatedFirstDate.toISOString().slice(0, 10);
  const last = days.at(-1).d;
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

function eventStudyHTML(events, days, priceBasis) {
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
        const result = eventStageStudy({ date: event[stage.key] }, days, priceBasis);
        const effect = result.state === 'ready'
          ? priceBasis !== 'trade'
            ? `요일 보정 ${priceBasis === 'askMax' ? '맥스업' : '0업'} 최저호가 <b class="${cls(result.price)}">${pct(result.price)}</b>`
            : `요일 보정 VWAP <b class="${cls(result.price)}">${pct(result.price)}</b> · API 관측 수량 <b class="${cls(result.qty)}">${pct(result.qty)}</b>`
          : stateText[result.state];
        return `<div><span>${stage.label}</span><b>${eventDate(event[stage.key])}</b><small>${effect}</small></div>`;
      }).join('')}</div>
    </div>`;
  }).join('')}</div>`;
}

// 수집이 없던 시간은 0이 아니라 공백이다. 7일 시간축을 직접 채우되,
// 관측된 0만 value: 0으로 두고 미관측 시간은 whitespace point로 남긴다.
function observedHourlySeries(rows, key, hours = 7 * 24, asOf = DATA.builtAt) {
  const byHour = new Map(rows.map((x) => [Math.floor(Date.parse(x.t) / 3600000), x[key]]));
  const end = Math.floor(Date.parse(asOf) / 3600000);
  const start = end - hours + 1;
  const points = [];
  for (let hour = start; hour <= end; hour++) {
    const value = byHour.get(hour);
    points.push(value === undefined
      ? { time: hour * 3600 }
      : { time: hour * 3600, value });
  }
  return points;
}

// 미관측 시간을 가로질러 가격선을 이으면 점검 중에도 관측한 것처럼 보인다.
function hourlyPriceSegments(points) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (point.value === undefined) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

let DATA = null;
const packageState = packageUI.initialPackageState();
let tab = '전체';
// 기본 정렬은 24h 거래대금. 변동률로 정렬하면 하루 한두 건 거래된 아이템의
// 의미 없는 ±40%가 맨 위를 차지한다.
let job = '전체';
let sortKey = 'turnover';
let sortDir = -1;
let cardMode = 'zero';
let detailItemId = null;
let legendaryChart = null;
let legendaryForecastCleanup = null;
let weekdayBasis = 'trade';
let weekdayExpanded = true;

function renderDataStatus(now = Date.now()) {
  const time = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' KST' : '기록 없음';
  const last = DATA.collection?.last_success;
  const age = now - Date.parse(last), priceAge = now - Date.parse(DATA.priceAsOf);
  const hours = Math.max(0, Math.floor(age / 3600000)), minutes = Math.max(0, Math.floor(age / 60000) % 60);
  const known = Number.isFinite(age) && Number.isFinite(priceAge);
  const stale = !known || age >= 3 * 3600000 || priceAge >= 3 * 3600000;
  // 헤더에는 기준 시각과 경과만 짧게 두고, 문장 설명은 칩에 올렸을 때 펼친다.
  // 오래된 상태는 색만으로 전하지 않는다 — 글자로도 바로 보여준다.
  document.getElementById('data-asof').textContent = !known ? '⚠ 기준 시각 확인 불가'
    : stale ? '⚠ 오래된 데이터'
    : `${new Date(DATA.priceAsOf).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} 기준`;
  const ageEl = document.getElementById('data-age');
  if (ageEl) ageEl.textContent = Number.isFinite(age) ? `${hours ? `${hours}시간 ` : ''}${minutes}분 전` : '';
  const status = document.getElementById('data-freshness');
  status.classList.toggle('stale', stale);
  document.getElementById('data-status')?.classList.toggle('stale', stale);
  // 정적 화면에 남은 기록만으로 현재 수집기 중단을 단정하지 않는다.
  status.textContent = `가격 계산 기준: ${time(DATA.priceAsOf)}. 표시 데이터의 마지막 정상 수집: ${time(last)}` +
    (Number.isFinite(age) ? ` · ${hours}시간 ${minutes}분 경과` : '') +
    (stale ? ' · ⚠ 데이터가 오래됐거나 기준 시각을 확인할 수 없습니다. 새로고침해 최신 상태를 확인하세요.'
      : '. 사이트는 매시간 갱신되며 실시간 가격이 아닙니다.');
}

async function boot() {
  const response = await fetch('data/summary.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`요약 데이터 HTTP ${response.status}`);
  DATA = await response.json();
  renderDataStatus();
  setInterval(renderDataStatus, 60000);
  render();
  addEventListener('hashchange', render);
}

const enrich = (it) => ({
  ...it,
  display_price: representativePrice(it),
  chg: it.vwap24 && it.vwap_prev ? (it.vwap24 / it.vwap_prev - 1) * 100 : null,
  max_chg: it.max_vwap24 && it.max_vwap_prev ? (it.max_vwap24 / it.max_vwap_prev - 1) * 100 : null,
  turnover: it.price_basis === 'ask0' ? 0 : (it.vwap24 ?? it.last_price) * it.api_qty24,
  gap: askGap(it),
  g: grade(it),
});

function upgradeEconomics(it) {
  if (it.price_basis !== 'ask0' || !it.max_upgrade) return null;
  const floor = DATA.legendary?.[0]?.min_unit_price ?? null;
  const expectedCards = it.max_upgrade * 2.5;
  const materialCost = floor ? floor * expectedCards : null;
  const premium = it.last_price > 0 && it.max_last_price > 0 ? it.max_last_price - it.last_price : null;
  return {
    floor, expectedCards, materialCost, premium,
    expectedTotal: materialCost !== null && it.last_price > 0 ? it.last_price + materialCost : null,
    difference: materialCost !== null && premium !== null ? premium - materialCost : null,
  };
}

function upgradeEconomicsHTML(it) {
  const e = upgradeEconomics(it);
  if (!e) return '';
  const verdict = e.difference === null
    ? '0업과 맥스업 매물이 모두 확인되면 어느 쪽이 유리한지 계산합니다.'
    : e.difference > 0
      ? `기대값상 직접 강화가 <b>${fmt(e.difference)}골드 저렴</b>합니다.`
      : e.difference < 0
        ? `기대값상 맥스업 구매가 <b>${fmt(Math.abs(e.difference))}골드 저렴</b>합니다.`
        : '기대값상 두 방법의 비용이 같습니다.';
  return `<div class="panel upgrade-economics">
    <h3>맥스업 구매 vs 직접 강화</h3>
    <div class="kv">
      <div><div class="k">0업 최저호가</div><div class="v">${fmt(it.last_price)}</div></div>
      <div><div class="k">${it.max_upgrade}업 최저호가</div><div class="v">${fmt(it.max_last_price)}</div></div>
      <div><div class="k">맥스업 프리미엄</div><div class="v ${cls(e.premium)}">${e.premium === null ? '-' : `${e.premium >= 0 ? '+' : ''}${fmt(e.premium)}`}</div></div>
      <div><div class="k">기대 재료 카드</div><div class="v">${fmt(e.expectedCards, 1)}<small>장</small></div></div>
      <div><div class="k">직접 강화 재료 기대비용</div><div class="v">${fmt(e.materialCost)}</div></div>
      <div><div class="k">직접 강화 총 기대비용</div><div class="v">${fmt(e.expectedTotal)}</div></div>
    </div>
    <div class="upgrade-verdict">${verdict}</div>
    <p class="desc">현재 레전더리 0업 카드 최저가 <b>${fmt(e.floor)}</b>를 재료 단가로 사용합니다. 1장 40%와 2장 80%는 성공 1회당 기대 소모량이 모두 2.5장이고, 3장 100%는 3장이라 기대비용은 2.5장 전략으로 계산했습니다. 실패해도 강화 대상 카드는 유지된다는 전제이며 실제 비용은 운에 따라 달라집니다.</p>
  </div>`;
}

function render() {
  legendaryForecastCleanup?.();
  legendaryForecastCleanup = null;
  legendaryChart?.remove();
  legendaryChart = null;
  const id = location.hash.slice(1);
  const it = DATA.items.find((x) => x.item_id === id);
  scrollTo(0, 0);
  if (it || id === 'legendary-card') {
    if (detailItemId !== id) cardMode = 'zero';
    detailItemId = id;
    (it ? renderDetail(enrich(it)) : renderLegendary()).catch((error) => {
      if (location.hash.slice(1) !== id) return;
      console.error(error);
      document.getElementById('view').innerHTML = `
        <a class="back" href="#">← 전체 목록</a>
        <div class="panel"><h3>시계열 데이터를 불러오지 못했습니다</h3>
        <p class="desc">잠시 뒤 다시 시도해 주세요.</p></div>`;
    });
  } else {
    detailItemId = null;
    renderList();
  }
}

// 요약 카드는 목록과 인벤토리 두 뷰가 공유한다.
// 서로 다른 가격 기준과 표본 상태를 첫 화면에서 구분해 보여준다.
function summaryCards() {
  const m = DATA.meta;
  const lg = DATA.legendary?.[0];
  const trend = selectedWeekday();

  return `<div class="cards">
    <div class="card">
      <div class="k">추적 아이템</div>
      <div class="v">${m.items}<small>종</small></div>
      <div class="sub">체결 ${fmt(m.trades)}건 · ${m.lo}~${m.hi}</div>
    </div>
    ${lg ? `<a class="card hl" href="#legendary-card">
      <div class="k">레전더리 0업 카드</div>
      <div class="v">${fmt(lg.p10)}</div>
      <div class="sub">저가 기준 P10 · 그래프 보기 →<br>최저 ${fmt(lg.min_unit_price)} · 매물 ${lg.with_listings}/${lg.scanned}종</div>
    </a>` : ''}
    ${weekdayReady() ? `<button type="button" class="card weekday-summary" data-weekday-open>
      <span class="k">요일별 가격 트렌드</span>
      <span class="weekday-days">${['월', '화', '수', '목', '금', '토', '일'].map(d => `<span${d === '목' ? ' class="thu"' : ''}>${d}</span>`).join('')}</span>
      <span class="sub">${esc(tab)} · ${trend.eligibleItems ? `조건 충족 ${trend.eligibleItems}/${trend.candidates}종` : `표본 수집 중 · 최대 ${trend.maxWeeks}/4주`}</span>
      <span class="sub">${WEEKDAY_BASES[trend.basis]} · 월~일 비교 보기 ↓</span>
    </button>` : ''}
  </div>`;
}

// 조건을 채운 종목이 하나도 없으면 첫 화면에서 자리를 차지하지 않는다.
// 표본 대기 상태는 분석 페이지 한계 절에서 계속 공개한다.
const weekdayReady = () => weekdayGroups().some((g) => g.eligibleItems > 0);

const WEEKDAY_BASES = { trade: '일반 아이템 체결가', ask0: '카드 0업 호가', askMax: '카드 맥스업 호가' };

function weekdayGroups() {
  const ids = (DATA.items ?? []).filter((it) => matchesCategory(it, tab)
    && (tab !== '카드' || job === '전체' || it.job_role === job)).map((it) => it.item_id);
  return Object.keys(WEEKDAY_BASES).map((basis) => summarizeWeekdays(DATA.weekdayTrends?.items ?? [], ids, basis))
    .filter((g) => g.candidates > 0);
}

function selectedWeekday() {
  const groups = weekdayGroups();
  return groups.find((g) => g.basis === weekdayBasis) ?? groups[0]
    ?? summarizeWeekdays([], [], tab === '카드' ? 'ask0' : 'trade');
}

function weekdayTrendHTML() {
  if (!weekdayReady()) return '';
  const group = selectedWeekday(), groups = weekdayGroups();
  return `<details class="panel weekday-trend" id="weekday-trend" ${weekdayExpanded ? 'open' : ''}>
    <summary><span>요일별 가격 트렌드 <small>${esc(tab)}${tab === '카드' ? ` · ${esc(job)}` : ''}</small></span><span aria-hidden="true">⌄</span></summary>
    <div class="weekday-bases" role="group" aria-label="요일 트렌드 가격 기준">
      ${groups.map((g) => `<button type="button" class="chart-toggle${g.basis === group.basis ? ' on' : ''}" data-weekday-basis="${g.basis}" aria-pressed="${g.basis === group.basis}">${WEEKDAY_BASES[g.basis]}</button>`).join('')}
    </div>
    <p class="desc">${group.eligibleItems ? `완료 4주 이상인 ${group.eligibleItems}/${group.candidates}종 · 사용 기간 ${group.from} ~ ${group.to}`
      : `표본 수집 중 · 완료 4주를 갖춘 종목 ${group.eligibleItems}/${group.candidates}종 · 종목당 최대 ${group.maxWeeks}/4주`}
      ${group.basis === 'trade' ? ' · 하루 체결 5건 이상' : ' · 하루 호가 18시간 이상 관측'}</p>
    ${group.eligibleItems ? `<div class="weekday-grid">
      ${weekdaySVG(group.points, 'price', '요일별 가격 수준', '종목별 해당 주 평균 100')}
      ${weekdaySVG(group.points.map((p) => ({ ...p, n: p.changeN })), 'change', '전날 대비 변화율 (%)', '실제 전날 가격 대비 변화율', 0)}
    </div>` : `<p class="weekday-empty">월~일을 모두 관측한 주가 종목별로 4주 쌓이면 그래프가 표시됩니다. 지금은 요일별 유효 관측 수를 확인할 수 있습니다.</p>`}
    ${group.eligibleItems ? `<div class="legendary-weekday-table"><table><thead><tr><th>요일</th><th>가격 수준<br>주평균 100</th><th>전날 대비</th><th>계산 표본<br>가격 / 변화</th><th>유효 관측</th></tr></thead><tbody>
      ${group.points.map((p) => `<tr${p.k === 4 ? ' class="weekday-thu-row"' : ''}><th>${p.label}</th>
        <td>${fmt(p.price, 1)}</td><td class="${cls(p.change)}">${pct(p.change)}</td>
        <td title="가격 ${group.eligibleItems}종 · 변화 ${p.changeItems}종">${p.n} / ${p.changeN}</td><td>${p.availableN}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="weekday-samples" role="list" aria-label="요일별 유효 관측 수">
      ${group.points.map(p => `<div role="listitem"${p.k === 4 ? ' class="weekday-thu-row"' : ''}><span>${p.label}</span><b>${p.availableN}</b></div>`).join('')}
    </div>`}
    <p class="hint">가격은 각 종목의 주평균을 100으로 맞춘 뒤 종목별 요일 평균에 같은 비중을 줍니다.
      전날 대비는 실제 전날에도 유효 관측이 있을 때만 계산하므로 가격 수준과 방향이 다를 수 있습니다.
      표본 단위는 종목·일이며 독립 표본 수가 아닙니다. 유효 관측에는 아직 4주를 채우지 못한 종목도 포함됩니다.
      목요일은 비교를 위한 강조입니다. 관측된 패턴이며 요일 효과의 유의성·인과관계를 검증한 결과는 아닙니다.
      <a href="guide.html#weekday">계산 기준 보기 →</a></p>
  </details>`;
}

function bindWeekdayTrend() {
  const panel = document.getElementById('weekday-trend');
  if (!panel) return;
  panel.ontoggle = () => { weekdayExpanded = panel.open; };
  document.querySelectorAll('[data-weekday-open]').forEach((el) => {
    el.onclick = () => { panel.open = true; weekdayExpanded = true; panel.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  });
  document.querySelectorAll('[data-weekday-basis]').forEach((el) => {
    el.onclick = () => { weekdayBasis = el.dataset.weekdayBasis; renderList(); };
  });
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

function cardJobTabs() {
  return `<div class="job-sw">
    ${['전체', '딜러', '버퍼'].map((j) => `<button class="${j === job ? 'on' : ''}" data-j="${j}">${j}</button>`).join('')}
  </div>`;
}

// ── 목록 ───────────────────────────────────────────────────────
function renderList() {
  const all = DATA.items.map(enrich);
  const lg = DATA.legendary?.[0];
  const cats = [...new Set(all.map((x) => x.category))]
    .map((c) => ({ c, sum: all.filter((x) => matchesCategory(x, c)).reduce((a, x) => a + x.turnover, 0) }))
    .sort((a, b) => b.sum - a.sum).map((x) => x.c);

  if (tab === '카드' && job !== '전체') { renderInventory(all, cats); return; }

  const rows = all.filter((x) => matchesCategory(x, tab))
    .sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sortDir;
    });

  document.getElementById('view').innerHTML = `
    ${summaryCards()}

    ${categoryTabs(cats)}
    ${tab === '카드' ? cardJobTabs() : ''}
    ${tab === '유랑악단 패키지' ? packageUI.packagePanelHTML(DATA, packageState) : ''}
    ${weekdayTrendHTML()}
    ${tab === '실반 하모니 박스' ? `<p class="desc">실반 멜로디 카드와 선택한 개봉 보상 4종의 시세입니다. 실반 하모니 박스는 NPC 개봉 메뉴로, 별도 거래 가격이 없습니다. <a href="https://df.nexon.com/pg/forestbandpkg" target="_blank" rel="noopener">공식 안내 ↗</a></p>` : ''}

    <div class="list">
      <div class="lh">
        <span class="r">#</span>
        <span data-k="item_name">아이템</span>
        <span class="r" data-k="display_price" title="일반 아이템: 최근 1시간 수량 가중평균 · 카드: 0업 최저호가">1h VWAP · 호가</span>
        <span class="r" data-k="chg">24h</span>
        <span class="r h5" data-k="turnover">관측 거래대금</span>
        <span class="r h6">14일 추이</span>
        <span class="r h7" data-k="gap" title="현재 최저 호가를 24시간 VWAP과 비교한 값">호가 갭</span>
      </div>
      ${lg && ['전체', '카드'].includes(tab) ? `<a class="row legendary-row" href="#legendary-card">
        <div class="rank r">지수</div>
        <div class="nm"><div class="legendary-icon" aria-hidden="true">0업</div><div class="t">
          <b>레전더리 카드 재료 시세<span class="tag">0업</span></b>
          <span>종류별 최저호가의 P10 · 매물 확인 ${lg.with_listings}/${lg.scanned}종</span>
        </div></div>
        <div class="px"><b>${fmt(lg.p10)}</b><small class="flat">P10 · 골드</small></div>
        <div class="chg flat">-</div><div class="dim c5">—</div>
        <div class="dim c6">그래프 보기 →</div><div class="dim c7">—<small>매물 ${fmt(lg.total_listings)}</small></div>
      </a>` : ''}
      ${rows.map((r, i) => {
        const color = css(r.chg > 0 ? '--up' : r.chg < 0 ? '--down' : '--ink-4');
        const thin = r.price_basis === 'trade' && r.api_qty24 < 5 && r.chg !== null;
        const isCard = r.price_basis === 'ask0';
        // 좁은 화면에서는 시각을 한 줄 아래로 내려 이름 칸 폭을 지킨다.
        const clockTag = (t) => `<span class="sep"> · </span><span class="clock">${tradeClock(t, DATA.priceAsOf)}</span>`;
        const shownStat = isCard ? statTransition(r.key_stat, r.key_stat_max) : r.key_stat;
        // 목록에는 고르는 데 필요한 것만 남긴다. 관측 수·종결 경과일은 상세 화면에 있다.
        const sub = isCard
          ? [r.job_role, shownStat, r.max_last_price ? `맥스업 ${fmt(r.max_last_price)}` : null]
          : [r.item_rarity, shownStat, `${r.g}등급 · 표본 ${fmt(r.trades)}`];
        return `<a class="row" href="#${r.item_id}">
          <div class="rank r">${i + 1}</div>
          <div class="nm">
            <img src="${r.img}" alt="" loading="lazy" width="32" height="32">
            <div class="t">
              <b>${esc(r.item_name)}${r.is_final ? '<span class="tag fin">종결</span>' : ''}${isCard ? '<span class="tag">0업</span>' : ''}${r.slot ? `<span class="tag">${esc(r.slot)}</span>` : ''}</b>
              <span>${sub.filter(Boolean).map(esc).join(' · ')}</span>
            </div>
          </div>
          <div class="px">${isCard
            ? `<b title="0업 최저호가">${r.display_price === null ? '-' : fmt(r.display_price)}</b>${r.display_price === null ? '<small class="flat">매물 없음</small>' : ''}`
            : r.vwap1h == null
              ? `<b class="flat nov" title="최근 1시간 관측 체결이 없어 평균을 표시하지 않습니다">1h 체결 없음</b>
                 <small class="flat" title="${priceTime(r.last_trade_at)} KST">최근 ${r.last_trade_at ? `${fmt(r.last_price)}${clockTag(r.last_trade_at)}` : '-'}</small>`
              : `<b title="최근 1시간 ${fmt(r.trades1h)}건 · ${fmt(r.api_qty1h)}개로 계산">${fmt(r.display_price)}</b>
                 <small class="flat" title="${priceTime(r.last_trade_at)} KST">체결 ${fmt(r.last_price)}${clockTag(r.last_trade_at)}</small>`}
          </div>
          <div class="chg ${thin ? 'flat' : cls(r.chg)}"${thin ? ' title="24h 표본 5개 미만 — 신뢰하기 어렵습니다"' : ''}>${pct(r.chg)}${thin ? '<span style="color:var(--ink-4)">?</span>' : ''}</div>
          <div class="dim c5">${isCard ? '—' : won(r.turnover)}</div>
          <div class="c6">${sparkSVG(r.spark, color)}</div>
          <div class="dim c7">${r.gap === null ? '—'
            : `<b class="${cls(r.gap)}" title="최저호가 ${fmt(r.min_ask)} · 24h VWAP ${fmt(r.vwap24)} 대비">${pct(r.gap)}</b>`}<small>매물 ${fmt(r.listings)}</small></div>
        </a>`;
      }).join('')}
    </div>

    <p class="hint">
      <b>1h VWAP</b>은 ${priceTime(DATA.priceAsOf)} KST 기준 직전 60분의 총 거래금액을 총수량으로 나눈 값입니다. 1시간 내 관측 체결이 없으면 평균을 표시하지 않고 최근 체결가를 따로 보여줍니다. 둘째 줄의 시각은 최근 체결의 KST 시각이며, 오늘이 아니면 날짜로 표시합니다. 표본이 적거나 고가 대량 체결이 있으면 평균도 크게 움직일 수 있습니다.<br>
      기본 정렬은 <b>24h 거래대금</b>입니다. 변동률로 정렬하면 하루 한두 건 거래된 아이템의 의미 없는 ±40%가 맨 위를 차지합니다.
      같은 이유로 24h 표본이 5개 미만인 변동률에는 <b>?</b>를 붙였습니다.<br>
      <b>호가 갭</b>은 현재 최저 호가를 <b>24시간 VWAP</b>과 비교한 값입니다. 카드는 대표 가격 자체가 호가라 표시하지 않으며, 체결가를 관측하지 않아 거래대금도 없습니다.<br>
      <b>등급</b>은 일평균 체결 건수입니다 — A ≥ 60건, B ≥ 20건, C ≥ 5건, D는 그 미만.
      <b>카드</b>는 0업 최저호가만 표시하며 체결 등급을 매기지 않습니다.
      <b>종결</b>은 현재 기준 최상위 아이템이며, 패치로 교체되면 갱신됩니다.
    </p>`;

  bindWeekdayTrend();
  packageUI.bindPackagePanel(DATA, packageState);
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
  document.querySelectorAll('.job-sw button').forEach((el) => {
    el.onclick = () => { job = el.dataset.j; renderList(); };
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

    ${cardJobTabs()}
    ${weekdayTrendHTML()}

    <div class="card" style="margin-bottom:20px">
      <div class="k">${job} 종결 인챈트 풀세트</div>
      <div class="v">${fmt(total)}<small>골드</small></div>
      <div class="sub">0업 기준 부위별 최저 호가 합계 · ${cards.length}종</div>
    </div>

    ${SLOT_GROUPS.map(([g, slots]) => `
      <div class="inv-group">
        <h4>${g}</h4>
        <div class="inv-grid">
          ${slots.map((sl) => {
            const list = bySlot.get(sl) ?? [];
            if (!list.length) return `<div class="slot empty">${sl}<br>미등록</div>`;
            return list.map((c) => `
              <a class="slot" href="#${c.item_id}">
                <div class="sl">${sl}</div>
                <div class="card-row">
                  <img src="${c.img}" alt="" loading="lazy" width="30" height="30">
                  <div class="cn">
                     <b>${esc(c.item_name.replace(/ 카드$/, ''))}</b>
                     ${c.key_stat ? `<div class="ks">부여 능력치 · ${esc(statTransition(c.key_stat, c.key_stat_max))}</div>` : ''}
                     <div class="price-mode"><span>0업</span><b>${fmt(c.min_ask)}</b><i class="${cls(c.chg)}">${pct(c.chg)}</i></div>
                     <div class="price-mode"><span>${c.max_upgrade ? `${c.max_upgrade}업` : '맥스업'}</span><b>${fmt(c.max_min_ask)}</b><i class="${cls(c.max_chg)}">${pct(c.max_chg)}</i></div>
                     ${(() => {
                       const e = upgradeEconomics(c);
                       if (!e || e.difference === null) return '<div class="upgrade-hint">비교 데이터 대기 중</div>';
                       return `<div class="upgrade-hint ${e.difference > 0 ? 'self' : 'max'}">${e.difference > 0 ? '직접 강화' : '맥스업 구매'} 기대값 유리 · ${fmt(Math.abs(e.difference))}</div>`;
                     })()}
                   </div>
                </div>
              </a>`).join('');
          }).join('')}
        </div>
      </div>`).join('')}

    <p class="hint">0업과 맥스업 최저호가를 분리해 표시합니다. 유리한 선택은 현재 레전더리 0업 카드 최저가와 단계당 기대 재료 2.5장을 사용한 <b>기대값</b>이며, 실제 강화 비용은 운에 따라 달라집니다.</p>`;

  document.querySelectorAll('.job-sw button').forEach((el) => {
    el.onclick = () => { job = el.dataset.j; renderList(); };
  });
  bindWeekdayTrend();
  document.querySelectorAll('.tab').forEach((el) => {
    el.onclick = () => { tab = el.dataset.c; renderList(); scrollTo(0, 0); };
  });
}

// ── 차트 툴팁 ──────────────────────────────────────────────────
// LightweightCharts는 크로스헤어만 주고 값 말풍선은 주지 않는다.
// 차트 위에 절대배치 div를 띄우고 크로스헤어가 움직일 때마다 채운다.

/** 일봉은 'YYYY-MM-DD' 문자열, 장중 차트는 UNIX 초로 들어온다. */
const tipTime = (time) => typeof time === 'number'
  ? new Date(time * 1000).toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  : String(time);

/** rows는 [라벨, 값, 클래스?] 배열. 값에는 fmt·pct가 만든 숫자 문자열만 넣는다. */
const tipRows = (time, rows) => `<div class="tt">${esc(tipTime(time))}</div>` +
  rows.filter(Boolean).map(([label, value, cl]) =>
    `<div class="tr"><span>${esc(label)}</span><b class="${cl ?? ''}">${value}</b></div>`).join('');

function attachTooltip(chart, container, format) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.style.position = 'relative';
  container.append(tip);
  chart.subscribeCrosshairMove((param) => {
    if (!param.point || param.time === undefined) { tip.hidden = true; return; }
    const html = format(param);
    if (!html) { tip.hidden = true; return; }
    tip.innerHTML = html;
    tip.hidden = false;
    // 오른쪽 끝에서 잘리지 않도록 넘치면 커서 왼쪽에 붙인다.
    const width = tip.offsetWidth;
    const max = container.clientWidth - width - 8;
    tip.style.left = `${Math.max(8, Math.min(param.point.x + 16, max))}px`;
    tip.style.top = '10px';
  });
}

/** 시각(초) → 원본 행. 차트는 값만 알고 있어 원자료를 되찾으려면 필요하다. */
const bySecond = (rows, key) =>
  new Map(rows.map((row) => [Math.floor(Date.parse(row[key]) / 1000), row]));

// ── 레전더리 재료 시세 ─────────────────────────────────────────
async function renderLegendary() {
  const view = document.getElementById('view');
  view.innerHTML = '<a class="back" href="#">← 전체 목록</a><div class="panel">레전더리 카드 시세를 불러오는 중…</div>';
  const response = await fetch('data/legendary.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`레전더리 시계열 HTTP ${response.status}`);
  const data = await response.json();
  if (location.hash.slice(1) !== 'legendary-card') return;
  const latest = data.hourly.at(-1);
  if (!latest) {
    view.innerHTML = '<a class="back" href="#">← 전체 목록</a><div class="panel"><h3>레전더리 카드 재료 시세 · 0업</h3><p>0업 가격 관측 기록이 아직 없습니다.</p></div>';
    return;
  }
  const weekday = data.weekday;
  const stale = Date.parse(data.asOf) - Date.parse(latest.captured_at) > 2 * 3600000;
  view.innerHTML = `
    <a class="back" href="#">← 전체 목록</a>
    <div class="dh"><div class="legendary-icon" aria-hidden="true">0업</div><div>
      <h2>레전더리 카드 재료 시세<span class="tag">0업</span></h2>
      <div class="meta">강화·합성 재료의 저가 호가 지표 · ${latest.scanned}종 대상</div>
    </div></div>
    <div class="bigpx">${fmt(latest.p10)}<small> 골드</small></div>
    <div class="bigchg flat">저가 기준가 P10 · 마지막 관측 ${priceTime(latest.captured_at)} KST${stale ? ' · 관측 지연' : ''}</div>
    <div class="panel"><div class="kv">
      <div><div class="k">전체 최저호가</div><div class="v">${fmt(latest.min_unit_price)}<small> 골드</small></div></div>
      <div><div class="k">종류별 최저호가 중앙값</div><div class="v">${fmt(latest.median)}<small> 골드</small></div></div>
      <div><div class="k">관측 매물</div><div class="v">${fmt(latest.total_listings)}<small> 건</small></div></div>
      <div><div class="k">매물 확인 / 대상</div><div class="v">${latest.with_listings} / ${latest.scanned}<small> 종</small></div></div>
    </div><p class="hint">최저가 카드: ${esc(latest.min_item_name)} · 관측 기간 ${data.daily[0].d}~${data.daily.at(-1).d} · ${fmt(data.observations)}회 수집</p></div>
    <div class="panel" id="legendary-panel">
      <div class="panel-head"><h3>가격과 관측 매물</h3><div class="legendary-ranges" role="group" aria-label="레전더리 차트 기간">
        ${[['7', '7일'], ['30', '30일'], ['all', '전체']].map(([value, label]) => `<button class="chart-toggle${value === '7' ? ' on' : ''}" data-range="${value}" aria-pressed="${value === '7'}">${label}</button>`).join('')}
      </div></div>
      <p class="desc">각 시간의 마지막 관측을 비교합니다. 가격은 왼쪽 골드, 매물은 오른쪽 건수이며, 신규 등록량이나 체결량은 아닙니다.</p>
      <div class="stock-legend"><span><i class="stock-price-key"></i>P10</span><span><i class="stock-min-key"></i>최저호가</span><span><i class="stock-qty-key"></i>관측 매물 건수</span><span>시간 · KST</span></div>
      <div class="chart" id="legendary-chart"></div>
      <p class="hint">빈 시간은 미관측이며 0건과 구분합니다. 현재 시간은 수집 중입니다. 가격과 매물의 동시 변화만으로 원인을 확정하지 않습니다.</p>
    </div>
    <div class="panel research-page">
      <label class="research-label" for="legendary-target">예측할 가격 기준</label>
      <select class="research-select" id="legendary-target"><option value="legendary-min">전체 최저호가 · 일평균</option><option value="legendary-p10">P10 · 일평균</option></select>
      <div id="legendary-forecast"><p class="desc">저장된 예측을 불러오는 중입니다.</p></div>
      <div class="research-links"><a href="research.html">종류별 지수·예측 →</a><a href="research.html#package">패키지 이벤트 관측 →</a></div>
    </div>
    <div class="panel" id="legendary-weekday">
      <h3>요일별 재료 가격 흐름</h3>
      <p class="desc">${weekday.ready
        ? `완료 ${weekday.weeks}주를 비교합니다. 일평균 P10을 해당 주 평균 100으로 환산하고, 전날 대비 변화율도 함께 표시합니다.`
        : `표본을 모으는 중입니다. 월~일을 모두 관측한 완료 주 ${weekday.weeks}/${weekday.minWeeks}주 · 하루 ${weekday.minHours}시간 이상 관측한 날 ${weekday.eligibleDays}일.`}</p>
      ${weekday.ready ? `${weekdaySVG(weekday.points, 'price', '주평균 대비 P10 가격 수준', '해당 주 평균 100')}
        <div class="legendary-weekday-table"><table><thead><tr><th>요일</th><th>가격 지수</th><th>전날 대비</th><th>표본 일수</th></tr></thead><tbody>
          ${weekday.points.map((point) => `<tr><th>${point.label}</th><td>${fmt(point.price, 1)}</td><td class="${cls(point.change)}">${pct(point.change)}</td><td>가격 ${point.n} · 변화 ${point.changeN}</td></tr>`).join('')}
        </tbody></table></div>`
        : `<p class="weekday-empty">요일별 사용 가능 표본: ${['월', '화', '수', '목', '금', '토', '일'].map((label, index) => `${label} ${weekday.counts[index]}일`).join(' · ')}<br>조건이 충족되면 그래프가 자동으로 표시됩니다.</p>`}
      <p class="hint">당일과 관측 ${weekday.minHours}시간 미만인 날은 제외합니다. 일평균은 시간별 마지막 가격에 같은 비중을 줍니다. 패치·이벤트를 포함한 관측 패턴이며, 요일 자체의 효과나 통계적 유의성을 검증한 결과는 아닙니다.</p>
    </div>
    <div class="panel"><h3>이 가격을 읽는 방법</h3>
      <p class="desc">P10은 매물이 확인된 카드 종류별 0업 최저호가를 싼 순서로 정렬한 10% 지점입니다. 매물 수나 체결 수량으로 가중한 평균가가 아닙니다. 최저호가는 그중 가장 싼 한 매물의 가격입니다.</p>
      <p class="hint">등록된 ${latest.scanned}종을 대상으로 하며 카드 종류별 API 응답은 최대 400건입니다. 매물 소멸이나 개별 조회 실패로 관측되는 종류가 바뀌어도 P10과 매물 건수가 변할 수 있습니다. 툴팁의 매물 확인 종수를 함께 확인하세요.</p>
    </div>`;

  const box = document.getElementById('legendary-chart');
  const chart = LightweightCharts.createChart(box, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: css('--ink-3'), fontFamily: 'Pretendard, system-ui, sans-serif' },
    grid: { vertLines: { visible: false }, horzLines: { color: css('--line') } },
    leftPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.25 } },
    rightPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.35, bottom: 0.05 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false,
      tickMarkFormatter: (time, type) => new Date(time * 1000).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul', ...(type <= 2 ? { month: 'numeric', day: 'numeric' } : { hour: '2-digit', minute: '2-digit', hour12: false }),
      }) },
    crosshair: { mode: 0 }, localization: { locale: 'ko-KR', timeFormatter: tipTime },
  });
  legendaryChart = chart;
  const end = Math.floor(Date.parse(data.asOf) / 3600000) * 3600;
  const start = Math.floor(Date.parse(data.hourly[0].t) / 3600000) * 3600;
  const hours = (end - start) / 3600 + 1;
  chart.addHistogramSeries({ priceScaleId: 'right', color: css('--blue') + '55', priceLineVisible: false,
    priceFormat: { type: 'custom', minMove: 1, formatter: (value) => `${fmt(value)}건` },
  }).setData(observedHourlySeries(data.hourly, 'total_listings', hours, data.asOf));
  for (const [key, color] of [['min_unit_price', css('--gold')], ['p10', css('--ink')]]) {
    const segments = hourlyPriceSegments(observedHourlySeries(data.hourly, key, hours, data.asOf));
    for (const [index, segment] of segments.entries()) {
      chart.addLineSeries({ priceScaleId: 'left', color, lineWidth: 2,
        pointMarkersVisible: segment.length === 1, pointMarkersRadius: 3,
        priceLineVisible: false, lastValueVisible: index === segments.length - 1,
        priceFormat: { type: 'custom', minMove: 1, formatter: (value) => fmt(value) },
      }).setData(segment);
    }
  }
  const at = bySecond(data.hourly, 't');
  attachTooltip(chart, box, (param) => {
    const row = at.get(param.time);
    return tipRows(param.time, row ? [
      ['P10', `${fmt(row.p10)}골드`], ['최저호가', `${fmt(row.min_unit_price)}골드`],
      ['최저가 카드', esc(row.min_item_name)], ['관측 매물', `${fmt(row.total_listings)}건`],
      ['매물 확인 / 대상', `${row.with_listings} / ${row.scanned}종`],
      ['실제 관측 · KST', priceTime(row.captured_at)],
    ] : [['가격 · 매물', '미관측']]);
  });
  const setRange = (value) => {
    chart.timeScale().setVisibleRange({ from: Math.min(end - 3600, value === 'all' ? start : Math.max(start, end - (Number(value) * 24 - 1) * 3600)), to: end });
    document.querySelectorAll('[data-range]').forEach((button) => {
      const active = button.dataset.range === value;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };
  document.querySelectorAll('[data-range]').forEach((button) => { button.onclick = () => setRange(button.dataset.range); });
  setRange('7');
  try {
    const researchResponse = await fetch('data/research.json', { cache: 'no-cache' });
    if (!researchResponse.ok) throw new Error('예측 응답 실패');
    const research = await researchResponse.json();
    const { renderForecast } = await import('./research-ui.js?v=20260920-data');
    if (location.hash.slice(1) !== 'legendary-card' || legendaryChart !== chart) return;
    const drawForecast = () => {
      legendaryForecastCleanup?.();
      const series = research.series.find((s) => s.id === document.getElementById('legendary-target').value);
      legendaryForecastCleanup = renderForecast(document.getElementById('legendary-forecast'), series, research);
    };
    document.getElementById('legendary-target').onchange = drawForecast;
    drawForecast();
  } catch (error) {
    if (location.hash.slice(1) === 'legendary-card' && legendaryChart === chart) {
      document.getElementById('legendary-forecast').textContent = '저장된 예측을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
    }
    console.error(error);
  }
}

// ── 상세 ───────────────────────────────────────────────────────
async function renderDetail(it) {
  const baseItem = it;
  const hasDepth = ['재료·소모품', '소울 결정'].includes(it.category);
  const isZeroCard = it.price_basis === 'ask0';
  const showingMax = isZeroCard && cardMode === 'max';
  const cardTier = showingMax ? `${it.max_upgrade ?? '맥스'}업` : '0업';
  const selectedKeyStat = showingMax ? (it.key_stat_max ?? it.key_stat) : it.key_stat;
  if (showingMax) {
    it = {
      ...it,
      last_price: it.max_last_price,
      vwap24: it.max_vwap24,
      vwap_prev: it.max_vwap_prev,
      min_ask: it.max_min_ask,
      median_ask: it.max_median_ask,
      listings: it.max_listings,
      trades: it.max_trades,
      span_days: it.max_span_days,
      chg: it.max_chg,
    };
  }
  document.getElementById('view').innerHTML = `
    <a class="back" href="#">← 전체 목록</a>
    <div class="dh">
      <img src="${it.img}" alt="" width="48" height="48">
      <div>
        <h2>${esc(it.item_name)}${it.is_final ? '<span class="tag fin">종결</span>' : ''}${isZeroCard ? `<span class="tag">${cardTier}</span>` : ''}</h2>
        <div class="meta">${esc(it.item_rarity)} · ${esc(it.item_type_detail)}${it.slot ? ' · ' + esc(it.slot) : ''}${it.job_role ? ' · ' + esc(it.job_role) : ''}${selectedKeyStat ? ' · 부여 능력치 ' + esc(selectedKeyStat) : ''}</div>
        ${it.is_final && it.final_since ? `<div class="meta">${it.category === '칭호' ? '종결 성능 최초 등장' : '종결 지정'} ${it.final_since} · <b style="color:var(--ink-2)">D+${sinceDays(it.final_since)}</b></div>` : ''}
      </div>
    </div>
    ${it.category === '칭호' && it.is_final && it.final_since ? `<p class="price-meta">칭호 D+는 같은 종결 성능 등급이 처음 등장한 날부터 계산합니다. 상품별 출시일과는 다릅니다.<br>일반형은 프로스트의 전설, 플래티넘형은 프로스트의 전설 플래티넘을 기준으로 합니다. <a href="https://df.nexon.com/community/news/seriashop/541?category=2" target="_blank" rel="noopener noreferrer">최초 출시 안내 ↗</a></p>` : ''}
    ${isZeroCard ? `<div class="upgrade-sw" role="group" aria-label="카드 업그레이드 단계">
      <button class="${showingMax ? '' : 'on'}" data-card-mode="zero" type="button">0업</button>
      <button class="${showingMax ? 'on' : ''}" data-card-mode="max" type="button">맥스업${baseItem.max_upgrade ? ` (${baseItem.max_upgrade}업)` : ''}</button>
    </div>` : ''}
    <div class="price-meta price-basis">${isZeroCard ? `${cardTier} 최저호가` : '최근 1시간 수량 가중평균 (VWAP)'}</div>
    <div class="bigpx">${fmt(representativePrice(it))}${representativePrice(it) == null ? '' : '<small>골드</small>'}</div>
    ${isZeroCard && representativePrice(it) == null ? `<div class="price-meta">${it.listings === 0 ? '현재 관측 매물 없음' : '현재 호가 관측 없음'}</div>` : ''}
    ${isZeroCard ? '' : `<div class="price-meta">최근 체결 ${it.last_trade_at ? `${fmt(it.last_price)}골드 · ${priceTime(it.last_trade_at)} KST` : '기록 없음'}</div>
      <div class="price-meta">${it.vwap1h == null ? '최근 1시간 관측 체결 없음' : `최근 1시간 ${fmt(it.trades1h)}건 · ${fmt(it.api_qty1h)}개로 계산`} · ${priceTime(DATA.priceAsOf)} KST 기준</div>`}
    <div class="bigchg ${cls(it.chg)}">${it.chg === null
      ? (isZeroCard ? '24h 평균 변화 비교 불가' : '데이터 없음')
      : `${pct(it.chg)} <span style="color:var(--ink-3);font-weight:500">24h 평균 변화</span>`}</div>

    <div class="panel"><div class="kv">${isZeroCard ? `
      <div><div class="k">24h 평균 ${cardTier} 최저호가</div><div class="v">${fmt(it.vwap24)}</div></div>
      <div><div class="k">현재 ${cardTier} 최저호가</div><div class="v">${fmt(it.min_ask)}</div></div>
      <div><div class="k">${cardTier} 등록 매물</div><div class="v">${fmt(it.listings)}</div></div>
      <div><div class="k">${cardTier} 가격 관측</div><div class="v">${fmt(it.trades)}</div></div>
      <div><div class="k">가격 기준</div><div class="v">${cardTier}만</div></div>
      <div><div class="k">이력</div><div class="v">${it.span_days >= 1 ? it.span_days.toFixed(1) + '일' : (it.span_days * 24).toFixed(0) + '시간'}</div></div>` : `
      <div><div class="k">24h VWAP</div><div class="v">${fmt(it.vwap24)}</div></div>
      <div id="price-position"><div class="k">관측일 대비 가격 위치</div><div class="v flat">…</div></div>
      <div><div class="k">24h API 관측 수량</div><div class="v">${fmt(it.api_qty24)}</div></div>
      <div><div class="k">최저 호가</div><div class="v">${fmt(it.min_ask)}</div></div>
      <div><div class="k">등록 매물</div><div class="v">${fmt(it.listings)}</div></div>
      <div><div class="k">표본</div><div class="v">${fmt(it.trades)} <span style="font-size:12px;color:var(--ink-3);font-weight:500">${it.g}등급</span></div></div>
      <div><div class="k">이력</div><div class="v">${it.span_days >= 1 ? it.span_days.toFixed(1) + '일' : (it.span_days * 24).toFixed(0) + '시간'}</div></div>`}
    </div></div>

    ${isZeroCard ? upgradeEconomicsHTML(baseItem) : ''}

    <div class="panel">
      <div class="panel-head price-chart-head">
        <h3>${isZeroCard ? `${cardTier} 최저호가` : '가격 · 체결 수량'}</h3>
        <div class="price-chart-controls">
          ${isZeroCard ? '' : '<button class="chart-toggle" id="price-zoom" type="button" aria-pressed="true">가격 축 확대</button><button class="chart-toggle" id="price-full" type="button" aria-pressed="false">전체 범위</button>'}
          <button class="chart-toggle" id="candle-toggle" type="button" aria-pressed="true">캔들 켜짐</button>
        </div>
      </div>
      <p class="desc" id="fc-desc">불러오는 중…</p>
      ${isZeroCard ? '' : '<p class="desc price-scale-status" id="price-scale-status" aria-live="polite"></p>'}
      <div class="chart${isZeroCard ? '' : ' tall'}" id="c1"></div>
      <div class="event-rail" id="event-rail" aria-label="가격 영향 이벤트 태그" hidden></div>
      <details class="event-study" id="event-details">
        <summary><span>가격 영향 이벤트 · 이벤트 스터디</span><small id="event-count"></small><i aria-hidden="true">⌄</i></summary>
        <div class="event-body">
          <p class="desc">실제 시장 충격일인 패치·적용·출시일을 기준으로 봅니다. 패키지는 종료일도 별도로 계산합니다. 전후 수치는 요일효과를 보정한 3일 평균 비교이며, 동시 발생이 인과관계를 뜻하지는 않습니다.${isZeroCard ? ` 카드 가격은 ${cardTier} 최저호가만 사용합니다.` : ''}</p>
          <div id="event-list"></div>
        </div>
      </details>
    </div>
    <div class="panel" id="stock-panel">
      <h3>최근 7일 · ${isZeroCard ? `${cardTier} ` : ''}가격과 매물 잔량</h3>
      <p class="desc">${isZeroCard ? '선택한 단계의 시간별 평균 최저호가와' : '시간별 체결 수량 가중평균(VWAP)과'} 각 시간의 마지막 매물 잔량을 같은 시간축에서 비교합니다. 현재 시간은 수집 중입니다.</p>
      <div class="kv depth-kv" id="stock-kv"></div>
      <div class="stock-legend"><span><i class="stock-price-key"></i>${isZeroCard ? `${cardTier} 평균 최저호가` : '체결 VWAP'} · 왼쪽 골드</span><span><i class="stock-qty-key"></i>매물 잔량 · 오른쪽 개</span><span>시간 · KST</span></div>
      <div class="chart" id="stock-chart"></div>
      <p class="hint">빈 구간은 해당 자료가 없는 시간이며 0개와 구분합니다. 잔량은 신규 등록량이나 체결량이 아닙니다. 가격과 잔량의 동시 변화만으로 원인을 확정할 수는 없습니다.<br>매물 API는 최대 400건을 반환하므로 전체 물량보다 적을 수 있습니다.${isZeroCard ? ' 카드 단계는 같은 응답 안에서 구분합니다.' : ''}</p>
    </div>
    ${isZeroCard ? '' : `<div class="panel">
      <h3>호가–체결 갭</h3>
      <p class="desc">각 관측 시점의 최저 호가를 직전 24시간 체결 VWAP과 비교합니다. 양수면 지금 호가가 최근 체결가보다 높고, 음수면 낮습니다. 호가와 최근 체결가의 차이일 뿐이며, 이것만으로 매수 시점이나 다음 가격 방향을 판단할 수는 없습니다.</p>
      <div class="chart" id="c4"></div>
    </div>`}
    ${hasDepth ? `<div class="panel">
      <h3>매물 사다리</h3>
      <p class="desc">현재 매물을 낮은 호가부터 누적합니다. 최저가 한 건이 아니라 원하는 수량을 실제로 살 때의 평균 단가를 보여줍니다.</p>
      <div id="depth">불러오는 중…</div>
    </div>` : ''}
    ${isZeroCard ? '' : `<div class="panel" id="weekday-panel">
      <h3>아이템별 요일 프로파일</h3>
      <p class="desc" id="weekday-desc">완료된 일봉을 분석하는 중…</p>
      <div id="weekday-profile"></div>
    </div>`}`;

  document.querySelectorAll('.upgrade-sw button').forEach((button) => {
    button.onclick = () => {
      cardMode = button.dataset.cardMode;
      renderDetail(baseItem).catch(console.error);
    };
  });

  const response = await fetch(`data/series/${it.item_id}.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`시계열 데이터 HTTP ${response.status}`);
  const rawSeries = await response.json();
  const s = showingMax
    ? { ...rawSeries, ...rawSeries.max, stock: rawSeries.max?.stock ?? [], events: rawSeries.events ?? [], askGap: [] }
    : rawSeries;
  // 해시가 바뀐 사이 이전 요청이 늦게 도착하면 새 상세 화면을 덮지 않는다.
  if (location.hash.slice(1) !== it.item_id || cardMode !== (showingMax ? 'max' : 'zero')) return;
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
    layout: { background: { color: 'transparent' }, textColor: css('--ink-3'), fontFamily: 'Pretendard, system-ui, sans-serif', attributionLogo: false },
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
  const positionEl = document.getElementById('price-position');
  if (positionEl) {
    const today = new Date(DATA.builtAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const pos = pricePosition(d, it.vwap24, today);
    const md = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
    positionEl.innerHTML = pos.ready
      ? `<div class="k">최근 ${pos.days}개 관측일 대비</div>
         <div class="v">${pos.percentile <= 50 ? `하위 ${Math.max(1, Math.round(pos.percentile))}%` : `상위 ${Math.max(1, Math.round(100 - pos.percentile))}%`}</div>
         <div class="pos-bar" title="관측일 VWAP ${fmt(pos.low)} ~ ${fmt(pos.high)}"><i style="left:${pos.percentile.toFixed(1)}%"></i></div>
         <div class="depth-sub">24h 평균가 기준 · ${md(pos.from)}~${md(pos.to)}</div>`
      : `<div class="k">관측일 대비 가격 위치</div><div class="v flat">${it.vwap24 > 0 ? `${pos.days}/${pos.min}개` : '-'}</div>
         <div class="depth-sub">${it.vwap24 > 0 ? `관측일 ${pos.min}개부터 계산` : '24h 체결 없음'}</div>`;
  }
  const stock = s.stock ?? [];
  const stockAt = bySecond(stock, 't');
  const firstDay = d[0]?.d;
  const lastDay = d.at(-1)?.d;
  const events = (s.events ?? []).filter((event) => {
    if (!EVENT_TYPES[event.type]) return false;
    if (event.related_item_ids?.length) return true;
    return firstDay && lastDay && event.starts >= firstDay && event.starts <= lastDay;
  });
  document.getElementById('event-count').textContent = `${events.length}건`;
  document.getElementById('event-list').innerHTML = eventStudyHTML(events, d, s.priceBasis);

  if (!isZeroCard) {
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
  if (weekday.state !== 'ready') document.getElementById('view').append(document.getElementById('weekday-panel'));
  }

  const hourly = s.hourly ?? [];
  if (stock.length || hourly.length) {
    const latest = stock.at(-1);
    document.getElementById('stock-kv').innerHTML = `
      <div><div class="k">최근 관측 잔량</div><div class="v">${fmt(latest?.qty)}<small> 개</small></div></div>
      <div><div class="k">관측 매물</div><div class="v">${fmt(latest?.listings)}<small> 건</small></div></div>
      <div><div class="k">마지막 매물 관측 · KST</div><div class="v">${priceTime(latest?.observed_at)}</div></div>`;
    const stockBox = document.getElementById('stock-chart');
    const stockChart = LightweightCharts.createChart(stockBox, {
      ...opts, height: 360,
      leftPriceScale: { visible: true, borderVisible: false, mode: 0, scaleMargins: { top: 0.08, bottom: 0.22 } },
      rightPriceScale: { visible: true, borderVisible: false, mode: 0, scaleMargins: { top: 0.3, bottom: 0.05 } },
      timeScale: {
        borderVisible: false, timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (time, type) => new Date(time * 1000).toLocaleString('ko-KR', {
          timeZone: 'Asia/Seoul', ...(type <= 2 ? { month: 'numeric', day: 'numeric' } : { hour: '2-digit', minute: '2-digit', hour12: false }),
        }),
      },
      localization: { locale: 'ko-KR', timeFormatter: tipTime },
    });
    const stockPoints = observedHourlySeries(stock, 'qty');
    const pricePoints = observedHourlySeries(hourly, 'vwap');
    stockChart.addHistogramSeries({
      priceScaleId: 'right', color: css('--blue') + '55', priceLineVisible: false,
      priceFormat: { type: 'custom', minMove: 1, formatter: (v) => `${fmt(v)}개` },
    }).setData(stockPoints);
    const segments = hourlyPriceSegments(pricePoints);
    for (const [index, segment] of segments.entries()) {
      stockChart.addLineSeries({
        priceScaleId: 'left', color: css('--ink'), lineWidth: 2,
        pointMarkersVisible: segment.length === 1, pointMarkersRadius: 3,
        priceLineVisible: false, lastValueVisible: index === segments.length - 1,
        priceFormat: { type: 'custom', minMove: 1, formatter: (v) => fmt(v) },
      }).setData(segment);
    }
    const hourlyAt = bySecond(hourly, 't');
    attachTooltip(stockChart, stockBox, (param) => {
      const row = stockAt.get(param.time);
      const price = hourlyAt.get(param.time);
      return tipRows(param.time, [
        [isZeroCard ? `${cardTier} 평균 최저호가` : '체결 VWAP', price ? `${fmt(price.vwap)}골드` : '가격 관측 없음'],
        !isZeroCard && price ? ['관측 체결 수량', `${fmt(price.qty)}개`] : null,
        ['매물 잔량', row ? `${fmt(row.qty)}개` : '매물 미관측'],
        row ? ['관측 매물', `${fmt(row.listings)}건`] : null,
        row ? ['관측 시점 최저호가', row.min_ask === null ? '매물 없음' : `${fmt(row.min_ask)}골드`] : null,
        row ? ['매물 관측 · KST', priceTime(row.observed_at)] : null,
      ]);
    });
    const firstObserved = [...stockPoints, ...pricePoints].filter((point) => point.value !== undefined);
    const end = stockPoints.at(-1).time;
    stockChart.timeScale().setVisibleRange({ from: Math.min(end - 3600, ...firstObserved.map((point) => point.time)), to: end });
  } else {
    document.getElementById('stock-chart').innerHTML = '<p style="color:var(--ink-3);margin:0">최근 7일의 가격과 매물 잔량 관측 기록이 없습니다.</p>';
  }

  if (d.length >= 2) {
    const box1 = document.getElementById('c1');
    const c1 = LightweightCharts.createChart(box1, { ...opts, height: isZeroCard ? 300 : 340 });
    const timeline = eventTimeline(events, d);
    if (!isZeroCard) {
      // 거래량은 별도 패널 대신 가격 아래 띠에 둔다. 같은 날짜축에서 가격과 함께 읽힌다.
      c1.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } });
      c1.addHistogramSeries({
        priceScaleId: 'volume', color: css('--blue') + '40', priceLineVisible: false, lastValueVisible: false,
        priceFormat: { type: 'custom', minMove: 1, formatter: (v) => `${fmt(v)}개` },
      }).setData(d.map((x) => ({ time: x.d, value: x.qty })));
      c1.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }
    const candleSeries = c1.addCandlestickSeries({
      upColor: css('--up'), downColor: css('--down'), borderVisible: false,
      wickUpColor: css('--up'), wickDownColor: css('--down'),
    });
    const zoom = isZeroCard ? null : candleZoom(d);
    let zoomed = !!zoom && localStorage.getItem('dnf-price-scale') !== 'full';
    const updatePriceScale = () => {
      c1.priceScale('right').applyOptions({ mode: zoomed ? 0 : 1, autoScale: true });
      candleSeries.setData(zoomed ? zoom.candles : d.map(x => ({ time: x.d, open: x.o, high: x.h, low: x.l, close: x.c })));
      // 화살표는 표시 범위 밖으로 이어지는 꼬리. 툴팁은 원본 일봉을 사용한다.
      const markers = zoomed ? d.flatMap(day => [
        ...(day.h > zoom.max ? [{ time: day.d, position: 'aboveBar', shape: 'arrowUp', size: 0.5, color: css('--ink-3') }] : []),
        ...(day.l < zoom.min ? [{ time: day.d, position: 'belowBar', shape: 'arrowDown', size: 0.5, color: css('--ink-3') }] : []),
      ]) : [];
      candleSeries.setMarkers(markers);
      const status = document.getElementById('price-scale-status');
      if (status) {
        status.textContent = zoomed
          ? `확대 중 · 선형축 · 시가·종가·평균 범위 기준. ↑↓는 범위 밖 꼬리${zoom.above.length ? ` · ↑ 최고 ${fmt(Math.max(...zoom.above.map(x => x.h)))}골드 (${zoom.above.length}일)` : ''}${zoom.below.length ? ` · ↓ 최저 ${fmt(Math.min(...zoom.below.map(x => x.l)))}골드 (${zoom.below.length}일)` : ''}. 원래 고가·저가는 차트 상세에 표시됩니다.`
          : '전체 범위 · 로그축 · 원래 고가·저가를 모두 표시합니다.';
        for (const [id, active] of [['price-zoom', zoomed], ['price-full', !zoomed]]) {
          const button = document.getElementById(id);
          button.classList.toggle('on', active);
          button.setAttribute('aria-pressed', String(active));
        }
      }
    };
    updatePriceScale();
    if (zoom) {
      for (const [id, value] of [['price-zoom', true], ['price-full', false]]) {
        document.getElementById(id).onclick = () => {
          zoomed = value;
          localStorage.setItem('dnf-price-scale', value ? 'zoom' : 'full');
          updatePriceScale();
        };
      }
    }
    const candleToggle = document.getElementById('candle-toggle');
    let candleVisible = localStorage.getItem('dnf-candles') !== 'off';
    const setCandleVisible = (visible) => {
      candleVisible = visible;
      candleSeries.applyOptions({ visible });
      candleToggle.classList.toggle('on', visible);
      candleToggle.textContent = visible ? '캔들 켜짐' : '캔들 꺼짐';
      candleToggle.setAttribute('aria-pressed', String(visible));
    };
    setCandleVisible(candleVisible);
    candleToggle.onclick = () => {
      setCandleVisible(!candleVisible);
      localStorage.setItem('dnf-candles', candleVisible ? 'on' : 'off');
    };
    c1.addLineSeries({
      color: css('--ink'), lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
    }).setData(d.map((x) => ({ time: x.d, value: x.vwap })));
    if (timeline.length) {
      c1.addLineSeries({
        lineVisible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      }).setData(timeline.map((x) => ({ time: x.date, value: d[0].vwap })));
    }

    // 롤링 평가에서 모델 오차가 naive보다 커서 가격 예측은 그리지 않는다.
    desc.innerHTML = isZeroCard
      ? `캔들은 수집 시점별 ${cardTier} 최저호가의 일별 시가·고가·저가·종가이며, 검은 실선은 일평균 ${cardTier} 최저호가입니다. 정확한 ${cardTier} 체결가를 구분할 수 없어 예측은 표시하지 않습니다.`
      : '캔들은 일별 시가·고가·저가·종가이며 오늘 봉은 수집 중입니다. 검은 실선은 일별 VWAP, 아래 막대는 일별 API 관측 체결 수량입니다. 수량은 100건 상한 때문에 실제 거래량의 하한값입니다. ' +
        '가격 예측은 표시하지 않습니다 — 과거 평가에서 모델 오차가 “마지막 가격 유지”보다 컸습니다. <a href="analysis.html">검증 보기 →</a>';
    const dayAt = new Map(d.map((x) => [x.d, x]));
    attachTooltip(c1, box1, (param) => {
      const day = dayAt.get(param.time);
      if (day) {
        return tipRows(param.time, [
          [isZeroCard ? '평균 최저호가' : 'VWAP', fmt(day.vwap)],
          ['시가 · 종가', `${fmt(day.o)} · ${fmt(day.c)}`],
          ['고가 · 저가', `${fmt(day.h)} · ${fmt(day.l)}`],
          isZeroCard ? ['관측', `${fmt(day.n)}회`] : ['체결 수량', `${fmt(day.qty)}개 · ${fmt(day.n)}건`],
        ]);
      }
      return null;
    });
    c1.timeScale().fitContent();
    renderEventRail(c1, timeline);
  } else {
    document.getElementById('c1').innerHTML = '<p style="color:var(--ink-3);margin:0">일봉을 그릴 만큼 데이터가 모이지 않았습니다.</p>';
    document.getElementById('candle-toggle').hidden = true;
    for (const id of ['price-zoom', 'price-full', 'price-scale-status']) {
      const element = document.getElementById(id);
      if (element) element.hidden = true;
    }
    desc.textContent = '';
  }

  if (!isZeroCard && s.askGap?.length) {
    const box4 = document.getElementById('c4');
    const c4 = LightweightCharts.createChart(box4, {
      ...opts, height: 300, rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      localization: { locale: 'ko-KR', priceFormatter: (v) => pct(v) },
    });
    c4.addBaselineSeries({
      baseValue: { type: 'price', price: 0 },
      topLineColor: css('--up'), topFillColor1: css('--up') + '33', topFillColor2: css('--up') + '08',
      bottomLineColor: css('--down'), bottomFillColor1: css('--down') + '08', bottomFillColor2: css('--down') + '33',
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v) => pct(v) },
    }).setData(s.askGap.map((x) => ({ time: Math.floor(Date.parse(x.t) / 1000), value: x.gap })));
    // 갭은 두 값의 비율이므로 원자료(호가·체결)를 함께 보여야 검증할 수 있다.
    // 퍼센트만으로는 2천 골드의 −9.8%와 3억 골드의 −9.8%가 구분되지 않는다.
    const gapAt = bySecond(s.askGap, 't');
    attachTooltip(c4, box4, (param) => {
      const row = gapAt.get(param.time);
      if (!row) return null;
      return tipRows(param.time, [
        ['최저 호가', fmt(row.min_ask)],
        ['체결 24h VWAP', fmt(row.vwap)],
        ['갭', pct(row.gap), cls(row.gap)],
      ]);
    });
    c4.timeScale().fitContent();
  } else if (!isZeroCard) {
    document.getElementById('c4').innerHTML = '<p style="color:var(--ink-3);margin:0">비교할 호가와 직전 24시간 체결 데이터가 아직 없습니다.</p>';
  }
}

boot().catch((error) => {
  console.error(error);
  document.getElementById('data-asof').textContent = '⚠ 기준 시각 확인 불가';
  document.getElementById('data-status').classList.add('stale');
  document.getElementById('view').innerHTML = `
    <div class="panel"><h3>데이터를 불러오지 못했습니다</h3>
    <p class="desc">잠시 뒤 새로고침해 주세요.</p></div>`;
});
