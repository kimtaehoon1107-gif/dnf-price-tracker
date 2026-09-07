// 대시보드 + 아이템 상세. 해시 라우팅으로 한 페이지에서 처리한다.

const fmt = (n, d = 0) => n === null || n === undefined || !isFinite(n)
  ? '-' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d });
const pct = (n) => n === null || !isFinite(n) ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const cls = (n) => n === null || !isFinite(n) || Math.abs(n) < 0.005 ? 'flat' : n > 0 ? 'up' : 'down';

// 유동성 등급 — "이 아이템의 지표를 믿어도 되는가"를 한 글자로.
// 표본이 얇으면 어떤 지표도 신뢰할 수 없으므로 등급을 먼저 보여준다.
function grade(it) {
  const perDay = it.span_days > 0.5 ? it.trades / it.span_days : it.trades * 2;
  if (perDay >= 60) return 'A';
  if (perDay >= 20) return 'B';
  if (perDay >= 5) return 'C';
  return 'D';
}

let DATA = null;
let sortKey = 'chg';
let sortDir = -1;

async function boot() {
  DATA = await (await fetch('data/summary.json')).json();
  const b = new Date(DATA.builtAt);
  document.getElementById('built').textContent =
    `갱신 ${b.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} KST`;
  render();
  addEventListener('hashchange', render);
}

function render() {
  const id = location.hash.slice(1);
  const it = DATA.items.find((x) => x.item_id === id);
  if (it) renderDetail(it); else renderList();
}

// ── 목록 ───────────────────────────────────────────────────────
function renderList() {
  const m = DATA.meta;
  const rows = DATA.items.map((it) => ({
    ...it,
    chg: it.vwap24 && it.vwap_prev ? (it.vwap24 / it.vwap_prev - 1) * 100 : null,
    g: grade(it),
  }));
  const key = sortKey;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sortDir;
  });

  document.getElementById('view').innerHTML = `
    <div class="stats">
      <div class="stat"><div class="k">추적 아이템</div><div class="v">${m.items}<small>종</small></div></div>
      <div class="stat"><div class="k">수집 체결</div><div class="v">${fmt(m.trades)}<small>건</small></div></div>
      <div class="stat"><div class="k">수집 구간</div><div class="v" style="font-size:15px">${m.lo} ~ ${m.hi}</div></div>
      <div class="stat"><div class="k">매물 소진 관측</div><div class="v">${fmt(m.qty)}<small>개</small></div></div>
      <div class="stat"><div class="k">수집 실행</div><div class="v">${fmt(m.runs)}<small>회 · 실패 ${m.errors}</small></div></div>
    </div>

    <div class="note">
      Neople 오픈 API는 <b>최근 체결 100건 또는 최대 1개월</b>까지만 돌려줍니다. 과거 시세는 존재하지 않아
      직접 쌓아야 하므로, 이 사이트의 히스토리는 <b>수집을 시작한 시점부터</b>입니다.
      아이템마다 거래 속도가 달라 되돌아볼 수 있는 기간도 다릅니다.
    </div>

    <div class="table-scroll"><table>
      <thead><tr>
        <th data-k="item_name">아이템</th>
        <th data-k="role">역할</th>
        <th class="num" data-k="last_price">최근 체결가</th>
        <th class="num" data-k="chg">24h</th>
        <th class="num" data-k="qty24">24h 수량</th>
        <th class="num" data-k="min_ask">최저 호가</th>
        <th class="num" data-k="listings">매물</th>
        <th class="num" data-k="trades">표본</th>
        <th class="num" data-k="span_days">이력</th>
        <th data-k="g">유동성</th>
      </tr></thead>
      <tbody>${rows.map((r) => `
        <tr data-id="${r.item_id}">
          <td><span class="nm">${r.item_name}</span><br><span class="sub">${r.item_rarity} · ${r.item_type_detail}</span></td>
          <td><span class="sub">${r.role ?? '-'}</span></td>
          <td class="num">${fmt(r.last_price)}</td>
          <td class="num ${cls(r.chg)}">${pct(r.chg)}</td>
          <td class="num">${fmt(r.qty24)}</td>
          <td class="num">${fmt(r.min_ask)}</td>
          <td class="num">${fmt(r.listings)}</td>
          <td class="num">${fmt(r.trades)}</td>
          <td class="num">${r.span_days >= 1 ? r.span_days.toFixed(1) + '일' : (r.span_days * 24).toFixed(1) + '시간'}</td>
          <td><span class="chip ${r.g}">${r.g}</span></td>
        </tr>`).join('')}</tbody>
    </table></div>

    <div class="note" style="border-left-color:var(--ink-3)">
      <b>유동성 등급</b>은 일평균 체결 건수입니다 — A ≥ 60건, B ≥ 20건, C ≥ 5건, D는 그 미만.
      표본이 얇으면 어떤 가격 지표도 신뢰할 수 없어서, 숫자보다 먼저 보시라고 앞에 뒀습니다.
    </div>`;

  document.querySelectorAll('tbody tr').forEach((tr) => {
    tr.onclick = () => { location.hash = tr.dataset.id; };
  });
  document.querySelectorAll('thead th').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      sortDir = sortKey === k ? -sortDir : (k === 'item_name' || k === 'role' || k === 'g' ? 1 : -1);
      sortKey = k;
      renderList();
    };
  });
}

// ── 상세 ───────────────────────────────────────────────────────
async function renderDetail(it) {
  const chg = it.vwap24 && it.vwap_prev ? (it.vwap24 / it.vwap_prev - 1) * 100 : null;
  document.getElementById('view').innerHTML = `
    <p style="margin-bottom:18px"><a href="#">← 전체 목록</a></p>
    <div class="detail-head">
      <h2>${it.item_name}</h2>
      <span class="price">${fmt(it.last_price)}<span style="font-size:13px;color:var(--ink-3)"> 골드</span></span>
      <span class="price ${cls(chg)}" style="font-size:15px">${pct(chg)}</span>
      <span class="chip ${grade(it)}">유동성 ${grade(it)}</span>
    </div>
    <p class="sub" style="color:var(--ink-3);font-size:12.5px">${it.item_rarity} · ${it.item_type_detail} · ${it.role ?? ''}</p>

    <div class="kv">
      <div><div class="k">24h VWAP</div><div class="v">${fmt(it.vwap24)}</div></div>
      <div><div class="k">24h 체결 수량</div><div class="v">${fmt(it.qty24)}</div></div>
      <div><div class="k">최저 호가</div><div class="v">${fmt(it.min_ask)}</div></div>
      <div><div class="k">등록 매물</div><div class="v">${fmt(it.listings)}</div></div>
      <div><div class="k">수집 표본</div><div class="v">${fmt(it.trades)}</div></div>
      <div><div class="k">이력 길이</div><div class="v">${it.span_days >= 1 ? it.span_days.toFixed(1) + '일' : (it.span_days * 24).toFixed(1) + '시간'}</div></div>
    </div>

    <div class="chart-box"><h3>일봉 · VWAP</h3><div class="chart" id="c1"></div></div>
    <div class="chart-box"><h3>일별 체결 수량</h3><div class="chart small" id="c2"></div></div>
    <div class="chart-box"><h3>최근 7일 · 시간별 VWAP</h3><div class="chart" id="c3"></div></div>`;

  const s = await (await fetch(`data/series/${it.item_id}.json`)).json();
  const opts = {
    layout: { background: { color: 'transparent' }, textColor: '#a8a4bb', fontFamily: 'IBM Plex Mono, monospace' },
    grid: { vertLines: { color: '#1d1d27' }, horzLines: { color: '#1d1d27' } },
    rightPriceScale: { borderColor: '#2a2a37' },
    timeScale: { borderColor: '#2a2a37' },
    crosshair: { mode: 0 },
  };

  if (s.daily.length) {
    const c1 = LightweightCharts.createChart(document.getElementById('c1'), { ...opts, height: 300 });
    c1.addCandlestickSeries({ upColor: '#f0716a', downColor: '#6fa5f2', borderVisible: false, wickUpColor: '#f0716a', wickDownColor: '#6fa5f2' })
      .setData(s.daily.map((d) => ({ time: d.d, open: d.o, high: d.h, low: d.l, close: d.c })));
    c1.timeScale().fitContent();

    const c2 = LightweightCharts.createChart(document.getElementById('c2'), { ...opts, height: 150 });
    c2.addHistogramSeries({ color: '#e0b45b' }).setData(s.daily.map((d) => ({ time: d.d, value: d.qty })));
    c2.timeScale().fitContent();
  } else {
    document.getElementById('c1').innerHTML = '<p style="color:var(--ink-3)">일봉을 그릴 만큼 데이터가 모이지 않았습니다.</p>';
  }

  if (s.hourly.length) {
    const c3 = LightweightCharts.createChart(document.getElementById('c3'), { ...opts, height: 300 });
    c3.addLineSeries({ color: '#e0b45b', lineWidth: 2 })
      .setData(s.hourly.map((h) => ({ time: Math.floor(Date.parse(h.t) / 1000), value: h.vwap })));
    c3.timeScale().fitContent();
  }
}

boot();
