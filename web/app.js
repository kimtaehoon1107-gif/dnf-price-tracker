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
  turnover: (it.vwap24 ?? it.last_price) * it.qty24,
  g: grade(it),
});

function render() {
  const id = location.hash.slice(1);
  const it = DATA.items.find((x) => x.item_id === id);
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

    <div class="tabs">
      ${['전체', ...cats].map((c) => `<button class="tab ${c === tab ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>

    <div class="list">
      <div class="lh">
        <span class="r">#</span>
        <span data-k="item_name">아이템</span>
        <span class="r" data-k="last_price">현재가</span>
        <span class="r" data-k="chg">24h</span>
        <span class="r h5" data-k="turnover">거래대금</span>
        <span class="r h6">14일 추이</span>
        <span class="r h7" data-k="listings">매물</span>
      </div>
      ${rows.map((r, i) => {
        const color = css(r.chg > 0 ? '--up' : r.chg < 0 ? '--down' : '--ink-4');
        const thin = r.qty24 < 5 && r.chg !== null;
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
    <div class="tabs">
      ${['전체', ...cats].map((c) => `<button class="tab ${c === tab ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>

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
                      <i class="${c.qty24 < 5 ? 'flat' : cls(c.chg)}">${pct(c.chg)}</i></div>
                  </div>
                </div>
              </div>`).join('');
          }).join('')}
        </div>
      </div>`).join('')}

    <p class="hint">
      던파 장비창 배치를 따랐습니다. 카드는 "부위마다 무엇을 끼울까"로 보는 물건이라
      가격순 목록보다 이쪽이 실제 사용 맥락에 맞습니다.<br>
      표시 가격은 <b>최저 호가</b>이고, 없으면 최근 체결가입니다.
      한 부위에 카드가 여러 개인 것은 <b>종결이 여럿</b>이라는 뜻입니다 — 옵션이 갈리거나 성능이 비슷한 경우입니다.
    </p>`;

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
      <div><div class="k">24h 수량</div><div class="v">${fmt(it.qty24)}</div></div>
      <div><div class="k">최저 호가</div><div class="v">${fmt(it.min_ask)}</div></div>
      <div><div class="k">등록 매물</div><div class="v">${fmt(it.listings)}</div></div>
      <div><div class="k">표본</div><div class="v">${fmt(it.trades)} <span style="font-size:12px;color:var(--ink-3);font-weight:500">${it.g}등급</span></div></div>
      <div><div class="k">이력</div><div class="v">${it.span_days >= 1 ? it.span_days.toFixed(1) + '일' : (it.span_days * 24).toFixed(0) + '시간'}</div></div>
    </div></div>

    <div class="panel">
      <h3>가격 · 예측</h3>
      <p class="desc" id="fc-desc">불러오는 중…</p>
      <div class="chart" id="c1"></div>
    </div>
    <div class="panel"><h3>일별 체결 수량</h3><div class="chart sm" id="c2"></div></div>
    <div class="panel"><h3>최근 7일 · 시간별 VWAP</h3><div class="chart" id="c3"></div></div>`;

  const s = await (await fetch(`data/series/${it.item_id}.json`)).json();
  const opts = {
    layout: { background: { color: 'transparent' }, textColor: css('--ink-3'), fontFamily: 'Pretendard, system-ui, sans-serif' },
    grid: { vertLines: { visible: false }, horzLines: { color: css('--line') } },
    // 가격대가 수십 배 차이 나는 아이템이 섞여 있고 예측 구간도 넓다.
    // 로그 스케일이라야 실측 구간이 눌리지 않는다.
    rightPriceScale: { borderVisible: false, mode: 1 },
    timeScale: { borderVisible: false },
    crosshair: { mode: 0 },
  };

  const d = s.daily ?? [];
  const desc = document.getElementById('fc-desc');

  if (d.length >= 2) {
    const c1 = LightweightCharts.createChart(document.getElementById('c1'), { ...opts, height: 300 });
    c1.addLineSeries({ color: css('--ink'), lineWidth: 2 })
      .setData(d.map((x) => ({ time: x.d, value: x.vwap })));

    if (s.forecast) {
      const f = s.forecast;
      // 예측선은 마지막 실측값에서 이어붙인다 — 그래야 "여기서부터 예측"이 눈에 보인다
      const last = { time: d.at(-1).d, value: d.at(-1).vwap };
      const band = (key, w) => c1.addLineSeries({
        color: css('--blue'), lineWidth: w, lineStyle: 2,
        crosshairMarkerVisible: false, priceLineVisible: false, lastValueVisible: false,
      }).setData([last, ...f.points.map((p) => ({ time: p.d, value: p[key] }))]);
      band('hi', 1); band('lo', 1); band('mid', 2);

      const p0 = f.points[0];
      desc.innerHTML =
        `점선은 <b>${f.horizonDays}일 예측</b>입니다. 내일 예상 <b>${fmt(p0.mid)}</b>, 80% 구간 ${fmt(p0.lo)}~${fmt(p0.hi)}. ` +
        (f.vsNaive !== null
          ? `백테스트에서 naive(마지막 값 유지) 대비 MAPE가 <b class="${f.vsNaive > 0 ? 'up' : 'down'}">${f.vsNaive.toFixed(1)}%</b> ${f.vsNaive > 0 ? '개선' : '악화'}됐고 구간 커버리지는 ${f.coverage?.toFixed(0)}%입니다.`
          : '표본이 얇아 백테스트는 생략했습니다.') +
        `<br><span style="color:var(--ink-4)">모델 — ${esc(f.method)}</span>`;
    } else {
      desc.textContent = '예측에는 일봉이 최소 10일 필요합니다. 아직 그만큼 쌓이지 않았습니다.';
    }
    c1.timeScale().fitContent();

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
}

boot();
