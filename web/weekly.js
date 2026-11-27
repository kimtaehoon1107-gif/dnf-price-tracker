import { readMarketWatch } from './metrics.js?v=20261125-market-review';

const $ = (id) => document.getElementById(id);
const format = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('ko-KR', { signDisplay: 'exceptZero', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const changeText = (change) => `${percent.format(change)}%`;
const direction = (change) => change > 0 ? 'up' : change < 0 ? 'down' : '';
const range = ({ start, end }) => `${start.replaceAll('-', '.')} ~ ${end.replaceAll('-', '.')}`;
const shortDate = (date) => date.slice(5).replace('-', '/');
const shortRange = ({ start, end }) => start.slice(0, 4) === end.slice(0, 4)
  ? `${shortDate(start)}–${shortDate(end)}` : range({ start, end });

function itemLink(item) {
  const link = document.createElement('a');
  link.href = `index.html#${encodeURIComponent(item.id)}`;
  link.textContent = item.name;
  return link;
}

function showPriceItems(id, rows, showDays = false) {
  const list = $(id);
  list.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.textContent = '해당 품목 없음';
    list.append(empty);
  }
  for (const item of rows) {
    const row = document.createElement('li');
    row.className = 'weekly-price-item';
    const link = itemLink(item);
    const name = document.createElement('span');
    name.textContent = item.name;
    link.replaceChildren();
    if (/^[a-f0-9]{32}$/i.test(item.id)) {
      const icon = document.createElement('img');
      icon.src = `https://img-api.neople.co.kr/df/items/${item.id}`;
      icon.alt = '';
      icon.width = icon.height = 32;
      icon.loading = 'lazy';
      link.append(icon);
    }
    link.append(name);
    const change = document.createElement('strong');
    change.textContent = changeText(item.changePct);
    change.className = `weekly-change ${direction(item.changePct)}`;
    const prices = document.createElement('div');
    prices.className = 'weekly-prices';
    const previous = document.createElement('span');
    previous.textContent = format.format(item.previous.price);
    const arrow = document.createElement('span');
    arrow.textContent = '→';
    arrow.setAttribute('aria-hidden', 'true');
    const latest = document.createElement('b');
    latest.textContent = `${format.format(item.latest.price)}골드`;
    prices.setAttribute('aria-label', `그 전주 ${previous.textContent}골드, 비교 주 ${latest.textContent}`);
    prices.append(previous, arrow, latest);
    row.append(link, change, prices);
    if (showDays) {
      const coverage = document.createElement('small');
      coverage.textContent = `거래 관측 ${item.previous.days}일 → ${item.latest.days}일`;
      row.append(coverage);
    }
    list.append(row);
  }
}

function showMovers(direction, label, items) {
  const rest = items.slice(1, 3);
  showPriceItems(`weekly-${direction}`, items.slice(0, 1));
  $(`weekly-${direction}-more`).hidden = !rest.length;
  $(`weekly-${direction}-more-title`).textContent = `${label} ${rest.length}종 더 보기`;
  showPriceItems(`weekly-${direction}-rest`, rest);
}

let archive, latestReport, currentReport, calendar;
const edition = $('weekly-edition');
const historyItem = $('weekly-history-item');
const requestedWeek = new URL(location.href).searchParams.get('week');

function showCalendar(week) {
  if (!Array.isArray(calendar?.entries)) return;
  const entries = calendar.entries.map(({ date, title, category, dateBasis, url }) => ({
    date, title, url, label: (category === '일반' ? '업데이트' : category) +
      (dateBasis?.startsWith('공지 게시일') ? ' · 공지일' : ''),
  }));
  const starts = (calendar.periods ?? []).map(({ startDate, title, category, url }) => ({
    date: startDate, title, url, label: category === '패키지' ? '패키지 판매 시작' : '이벤트 기간 시작',
  }));
  const dates = [...entries, ...starts]
    .filter(({ date, url }) => date >= week.start && date <= week.end && /^https:\/\/df\.nexon\.com\//.test(url))
    .sort((a, b) => a.date.localeCompare(b.date));
  const list = $('weekly-calendar-rows');
  list.replaceChildren();
  $('weekly-calendar').hidden = !dates.length;
  $('weekly-calendar-title').textContent = `같은 주 던파 일정 ${dates.length}건`;
  for (const { date, title, label, url } of dates) {
    const row = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = date;
    time.textContent = shortDate(date);
    const info = document.createElement('div');
    const link = document.createElement('a');
    link.href = url;
    link.textContent = title;
    const kind = document.createElement('small');
    kind.textContent = label;
    info.append(link, kind);
    row.append(time, info);
    list.append(row);
  }
}

function showWatch(report) {
  const saved = new Set(readMarketWatch());
  $('weekly-watch').hidden = !saved.size;
  if (!saved.size) return;
  const rows = report.comparisons.filter((item) => saved.has(item.id));
  const status = $('weekly-watch-status');
  status.hidden = rows.length === saved.size;
  status.textContent = rows.length
    ? `저장한 ${saved.size}종 가운데 ${rows.length}종을 비교했어요.`
    : `두 주 모두 거래가 ${report.minDays}일 이상 관측된 관심 품목이 없어요.`;
  $('weekly-watch-rows').hidden = !rows.length;
  showPriceItems('weekly-watch-rows', rows, true);
}

function showHistory() {
  const offset = archive?.weeks.findIndex((week) => week.start === currentReport.latestWeek.start) ?? -1;
  $('weekly-history').hidden = offset < 0 || !currentReport.comparisons.length;
  if ($('weekly-history').hidden) return;
  const body = $('weekly-history-rows');
  body.replaceChildren();
  for (const week of archive.weeks.slice(offset, offset + 4).reverse()) {
    const { price, qty, days } = week.prices[historyItem.value] ?? {};
    const row = body.insertRow();
    row.insertCell().textContent = shortRange(week);
    row.insertCell().textContent = price === undefined ? '자료 부족' : `${format.format(price)}골드`;
    row.insertCell().textContent = qty === undefined ? '—' : `${format.format(qty)}개 (${days}일)`;
  }
}

function showReport(report) {
  currentReport = report;
  showWatch(report);
  $('weekly-items').replaceChildren();
  $('weekly-movers').hidden = $('weekly-details').hidden = !report.comparisons.length;
  const selected = historyItem.value;
  historyItem.replaceChildren(...report.comparisons.map((item) => new Option(item.name, item.id)));
  if (report.comparisons.some((item) => item.id === selected)) historyItem.value = selected;
  showHistory();
  const { latestWeek, previousWeek, comparisons, medianChangePct } = report;
  const population = Number.isInteger(report.observedItems) ? `두 주 동안 거래가 관측된 ${report.observedItems}종 가운데 ` : '';
  const up = comparisons.filter((item) => item.changePct > 0);
  const down = comparisons.filter((item) => item.changePct < 0);
  const unchanged = comparisons.length - up.length - down.length;
  const mid = medianChangePct === null ? null : Number(medianChangePct.toFixed(1));

  $('weekly-current-dates').textContent = shortRange(latestWeek);
  $('weekly-previous-dates').textContent = shortRange(previousWeek);
  $('weekly-recalculated').hidden = report === latestReport;
  $('weekly-headline').textContent = mid === null ? '두 주를 비교할 자료가 부족해요'
    : up.length > down.length ? '오른 품목이 더 많았어요'
    : down.length > up.length ? '내린 품목이 더 많았어요'
    : up.length === 0 ? '모든 비교 품목이 보합이었어요'
    : '오른 품목과 내린 품목 수가 같았어요';
  $('weekly-breadth').textContent = comparisons.length
    ? `${comparisons.length}종의 주간 평균 거래가 비교`
    : `각 주에 거래가 확인된 날이 ${report.minDays}일 이상인 품목이 있으면 표시됩니다.`;
  $('weekly-distribution').hidden = !comparisons.length;
  for (const [key, count] of [['up', up.length], ['down', down.length], ['flat', unchanged]]) {
    $(`weekly-${key}-count`).textContent = count;
    $(`weekly-${key}-bar`).style.flexGrow = count;
  }
  const groups = new Map();
  for (const item of comparisons) {
    const group = groups.get(item.category) ?? { name: item.category, count: 0, up: 0, down: 0 };
    group.count += 1;
    group.up += Number(item.changePct > 0);
    group.down += Number(item.changePct < 0);
    groups.set(item.category, group);
  }
  const group = [...groups.values()].filter((g) => g.count >= 3 && g.up !== g.down)
    .sort((a, b) => Math.abs(b.up - b.down) - Math.abs(a.up - a.down))[0];
  $('weekly-category').hidden = !group;
  if (group) $('weekly-category').textContent = `${group.name} ${group.count}종 중 ${Math.max(group.up, group.down)}종 ${group.up > group.down ? '상승' : '하락'}`;
  $('weekly-coverage').textContent =
    `${population}${comparisons.length}종을 비교했습니다. 월요일 0시부터 일요일까지를 한 주로 보고, 두 주에 각각 거래가 ${report.minDays}일 이상 관측된 품목을 비교합니다.`;
  $('weekly-median').hidden = mid === null;
  if (mid !== null) $('weekly-median').textContent = `품목별 등락률의 중앙값은 ${changeText(mid)}입니다.`;
  $('weekly-asof').textContent = `비교 기간 종료일 ${latestWeek.end.replaceAll('-', '.')} (KST). 현재 공개 자료 기준 ${new Date(latestReport.dataThrough).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST.`;
  showCalendar(latestWeek);

  if (comparisons.length) {
    showMovers('up', '상승', up);
    showMovers('down', '하락', down);
    $('weekly-count').textContent = `전체 ${comparisons.length}종 가격·수량 보기`;
    for (const item of comparisons) {
      const row = $('weekly-items').insertRow();
      const name = document.createElement('th');
      name.scope = 'row';
      name.append(itemLink(item));
      row.append(name);
      const price = row.insertCell();
      price.textContent = format.format(item.latest.price);
      const previousPrice = document.createElement('small');
      previousPrice.textContent = `그 전주 ${format.format(item.previous.price)}`;
      price.append(previousPrice);
      const change = row.insertCell();
      change.textContent = changeText(item.changePct);
      change.className = direction(item.changePct);
      const volume = row.insertCell();
      volume.textContent = `${format.format(item.latest.qty)} (${item.latest.days}일)`;
      const previousVolume = document.createElement('small');
      previousVolume.textContent = `그 전주 ${format.format(item.previous.qty)} (${item.previous.days}일)`;
      volume.append(previousVolume);
    }
    $('weekly-movers').hidden = false;
    $('weekly-details').hidden = false;
  }
  $('weekly-report').hidden = false;
  $('weekly-status').hidden = true;
}

const calendarReady = fetch('update-calendar.json', { cache: 'no-cache' })
  .then(response => response.ok ? response.json() : null)
  .catch(() => null);

try {
  const response = await fetch('data/weekly-market.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  latestReport = await response.json();
  showReport(latestReport);
} catch (error) {
  console.error(error);
  $('weekly-status').textContent = '주간 시황을 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.';
}

if (latestReport) {
  try {
    const response = await fetch('data/weekly-history.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.dataThrough !== latestReport.dataThrough) throw new Error('주간 자료의 기준 시각 불일치');
    archive = data;
    const issues = [latestReport, ...archive.past];
    edition.replaceChildren(...issues.map((issue, i) => new Option(range(issue.latestWeek) + (i === 0 ? ' · 최신' : ''), issue.latestWeek.start)));
    const requested = issues.find((issue) => issue.latestWeek.start === requestedWeek);
    edition.value = requested?.latestWeek.start ?? latestReport.latestWeek.start;
    const notice = $('weekly-edition-notice');
    if (requestedWeek && !requested) {
      notice.textContent = '요청한 회차가 최근 4회 목록에 없어 최신 회차를 표시합니다.';
      notice.hidden = false;
    }
    const showEdition = () => showReport(issues.find((issue) => issue.latestWeek.start === edition.value));
    edition.onchange = () => {
      const current = new URL(location.href);
      if (edition.value === latestReport.latestWeek.start) current.searchParams.delete('week');
      else current.searchParams.set('week', edition.value);
      history.replaceState(null, '', current);
      notice.hidden = true;
      showEdition();
    };
    historyItem.onchange = showHistory;
    $('weekly-edition-label').hidden = false;
    showEdition();
  } catch (error) {
    console.error(error);
    if (requestedWeek && requestedWeek !== latestReport.latestWeek.start) {
      const notice = $('weekly-edition-notice');
      notice.textContent = '이전 회차를 불러오지 못해 최신 회차를 표시합니다.';
      notice.hidden = false;
    }
  }
  calendar = await calendarReady;
  showCalendar(currentReport.latestWeek);
}
