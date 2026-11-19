const $ = (id) => document.getElementById(id);
const format = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('ko-KR', { signDisplay: 'exceptZero', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const changeText = (change) => `${percent.format(change)}%`;
const direction = (change) => change > 0 ? 'up' : change < 0 ? 'down' : '';
const range = ({ start, end }) => `${start.replaceAll('-', '.')} ~ ${end.replaceAll('-', '.')}`;

function itemLink(item) {
  const link = document.createElement('a');
  link.href = `index.html#${encodeURIComponent(item.id)}`;
  link.textContent = item.name;
  return link;
}

function showMovers(id, rows) {
  const list = $(id);
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.textContent = '해당 품목 없음';
    list.append(empty);
  }
  for (const item of rows.slice(0, 3)) {
    const row = document.createElement('li');
    const change = document.createElement('strong');
    change.textContent = changeText(item.changePct);
    change.className = direction(item.changePct);
    row.append(itemLink(item), change);
    list.append(row);
  }
}

function showReport(report) {
  const { latestWeek, previousWeek, comparisons, medianChangePct } = report;
  const up = comparisons.filter((item) => item.changePct > 0);
  const down = comparisons.filter((item) => item.changePct < 0);
  const unchanged = comparisons.length - up.length - down.length;
  const mid = medianChangePct === null ? null : Number(medianChangePct.toFixed(1));

  $('weekly-dates').textContent = `지난주 ${range(latestWeek)} · 그 전주 ${range(previousWeek)} (KST)`;
  $('weekly-headline').textContent = mid === null ? '두 주를 비교할 수 있는 품목이 아직 없어요'
    : up.length > down.length ? '평균 거래가가 오른 품목이 더 많았어요'
    : down.length > up.length ? '평균 거래가가 내린 품목이 더 많았어요'
    : up.length === 0 ? '가격 변동률이 모두 0.0%였어요'
    : '오른 품목과 내린 품목 수가 같았어요';
  $('weekly-breadth').textContent = comparisons.length
    ? `${comparisons.length}종 중 ${up.length}종 상승 · ${down.length}종 하락 · ${unchanged}종 0.0%. 품목별 등락률의 가운데 값은 ${changeText(mid)}예요.`
    : `각 주에 거래가 확인된 날이 ${report.minDays}일 이상인 품목이 있으면 표시됩니다.`;
  $('weekly-coverage').textContent =
    `월요일 0시부터 일요일까지를 한 주로 봅니다. 추적 중인 체결 품목 ${report.totalItems}종 중 각 주에 거래가 관측된 날이 ${report.minDays}일 이상인 품목만 비교했습니다.`;
  $('weekly-asof').textContent = `자료 기준 ${new Date(report.dataThrough).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`;

  if (comparisons.length) {
    showMovers('weekly-up', up);
    showMovers('weekly-down', down);
    $('weekly-count').textContent = `비교한 ${comparisons.length}종 전체 보기`;
    for (const item of comparisons) {
      const row = $('weekly-items').insertRow();
      const name = document.createElement('th');
      name.scope = 'row';
      name.append(itemLink(item));
      row.append(name);
      const price = row.insertCell();
      price.textContent = format.format(item.latest.price);
      const previousPrice = document.createElement('small');
      previousPrice.textContent = `전주 ${format.format(item.previous.price)}`;
      price.append(previousPrice);
      const change = row.insertCell();
      change.textContent = changeText(item.changePct);
      change.className = direction(item.changePct);
      const volume = row.insertCell();
      volume.textContent = `${format.format(item.latest.qty)} (${item.latest.days}일)`;
      const previousVolume = document.createElement('small');
      previousVolume.textContent = `전주 ${format.format(item.previous.qty)} (${item.previous.days}일)`;
      volume.append(previousVolume);
    }
    $('weekly-movers').hidden = false;
    $('weekly-details').hidden = false;
  }
  $('weekly-report').hidden = false;
  $('weekly-status').hidden = true;
}

try {
  const response = await fetch('data/weekly-market.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  showReport(await response.json());
} catch (error) {
  console.error(error);
  $('weekly-status').textContent = '주간 시황을 불러오지 못했습니다. 잠시 뒤 새로고침해 주세요.';
}
