export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (v, n = 1) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('ko-KR', { maximumFractionDigits: n });
export const MODELS = { naive: '최근 가격 유지', seasonal: '지난주 같은 요일', weekday: '추세 + 요일' };
// 차트 라이브러리는 CSS 변수를 못 읽어서 색을 직접 넘긴다. 흰 배경 4.5:1, 다크 배경 7:1 이상으로 골랐다.
const PALETTE = {
  light: { ink: '#27364b', text: '#5b6b7f', grid: '#e5e8eb', gray: '#667789', blue: '#1f66e0', warm: '#a35a1f' },
  dark: { ink: '#e8eaed', text: '#929ba7', grid: '#35363c', gray: '#9aa6b5', blue: '#79adff', warm: '#e0a070' },
};
export const palette = () => PALETTE[matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' ? 'dark' : 'light'];
// 색만으로 구분하지 않도록 모델마다 선 모양을 다르게 한다(LineStyle: 1 점선, 2 파선, 3 긴 파선).
const MODEL_STYLE = { naive: { color: 'gray', style: 1 }, seasonal: { color: 'blue', style: 2 }, weekday: { color: 'warm', style: 3 } };
const SWATCH = { 1: '2 3', 2: '5 3', 3: '9 3' };
export const legendKey = (color, label, style = 0) => `<span class="r-key"><svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true"><line x1="0" x2="26" y1="4" y2="4" stroke="${color}" stroke-width="2.5"${SWATCH[style] ? ` stroke-dasharray="${SWATCH[style]}"` : ''}/></svg>${esc(label)}</span>`;
export const timeText = (t) => t ? new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '기록 대기';

export function plot(box, lines, unit = '지수') {
  const colors = palette();
  const chart = LightweightCharts.createChart(box, {
    autoSize: true, layout: { background: { color: 'transparent' }, textColor: colors.text, fontFamily: 'Pretendard, sans-serif' },
    grid: { vertLines: { visible: false }, horzLines: { color: colors.grid } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
    localization: { locale: 'ko-KR', priceFormatter: (v) => `${fmt(v, unit === '골드' ? 0 : 1)} ${unit}` },
    crosshair: { mode: 0 },
  });
  for (const line of lines) {
    let segment = [], previous;
    const flush = () => {
      if (segment.length) chart.addLineSeries({ color: line.color, lineWidth: 2, lineStyle: line.style ?? (line.dashed ? 2 : 0),
        pointMarkersVisible: true, pointMarkersRadius: 2, lastValueVisible: false, priceLineVisible: false }).setData(segment);
      segment = [];
    };
    for (const p of line.points) {
      if (p.value == null || (previous && Date.parse(p.d) - Date.parse(previous) > 86400000)) flush();
      if (p.value != null) segment.push({ time: p.d, value: p.value });
      previous = p.d;
    }
    flush();
  }
  const tooltip = document.createElement('div');
  tooltip.className = 'research-hover';
  box.after(tooltip);
  chart.subscribeCrosshairMove((p) => {
    const date = typeof p.time === 'string' ? p.time : p.time?.year ?
      `${p.time.year}-${String(p.time.month).padStart(2, '0')}-${String(p.time.day).padStart(2, '0')}` : null;
    tooltip.textContent = date ? `${date} · ` + lines.flatMap((l) => {
      const row = l.points.find((r) => r.d === date);
      return row?.value != null ? [`${l.label} ${fmt(row.value)} ${unit}`] : [];
    }).join(' / ') : '차트에 커서를 올리면 날짜별 값을 확인할 수 있습니다.';
  });
  chart.timeScale().fitContent();
  return () => { chart.remove(); tooltip.remove(); };
}

export function renderForecast(box, series, meta) {
  const issue = series.issue;
  const predictions = issue?.predictions ?? [];
  const latest = series.daily.filter((p) => p.value != null).at(-1);
  const counts = issue?.counts ?? [0, 0, 0, 0, 0, 0, 0];
  const hasModel = predictions.some((p) => p.model === 'weekday');
  const colors = palette();
  // 평가 기록이 한 건도 없는 방식의 값은 다른 방식과 같은 무게로 읽히지 않게 표시한다.
  const unevaluated = new Set(Object.keys(MODELS).filter((key) => !series.scores.some((s) => s.model === key && s.n > 0)));
  const versus = (s) => s.model === 'naive' ? '기준' : s.mape === null || s.naiveMape === null ? '—'
    : Math.abs(s.mape - s.naiveMape) < 0.005 ? '같음' : `${s.mape > s.naiveMape ? '+' : '−'}${Math.abs(s.mape - s.naiveMape).toFixed(2)}%p`;
  box.innerHTML = `<div class="panel-head"><h3>${esc(series.label)} · 실험적 예측</h3><span class="tag">${hasModel ? '모델 비교 중' : '기준 예측 수집 중'}</span></div>
    <p class="desc">${series.unit === '골드' ? '대상일의 시간별 마지막 호가를 평균한 하루 가격' : '고정 구성 지수의 대상일 값'}을 예측합니다. 순간 최저가나 실제 구매 가능 가격을 뜻하지 않습니다.</p>
    <div class="kv research-kv"><div><div class="k">최근 완료 관측 · ${esc(latest?.d ?? '없음')}</div><div class="v">${fmt(latest?.value, series.unit === '골드' ? 0 : 2)}<small> ${esc(series.unit)}</small></div></div>
      <div><div class="k">이번 발행에 사용한 관측일</div><div class="v">${issue?.train.length ?? 0}<small>일 / 최근 56일</small></div></div></div>
    <p class="hint">발행 ${esc(timeText(meta.issuedAt))} KST · 입력 기준 ${esc(timeText(meta.dataAsOf))} KST${meta.origin && meta.origin < meta.before ? ' · 오늘 발행분 대기' : ''}</p>
    <div class="stock-legend">${legendKey(colors.ink, '실측')}${Object.entries(MODELS).map(([key, label]) => legendKey(colors[MODEL_STYLE[key].color], label, MODEL_STYLE[key].style)).join('')}</div>
    <div class="chart research-forecast-chart" aria-label="완료 관측과 발행 당시 저장한 예측"></div>
    <p class="hint">${hasModel ? '요일 모델은 로그 가격의 추세와 요일 계수를 함께 추정합니다. 표본 조건 충족은 예측력 입증이 아닙니다.' :
      `추세·요일 모델 대기: 최근 56일 안에 각 요일 관측 4회가 필요합니다. ${['일', '월', '화', '수', '목', '금', '토'].map((d, i) => `${d} ${counts[i]}/4`).join(' · ')}`}
      ${!predictions.length ? '<br>전날 유효 관측이 없거나 아직 발행 전입니다. 가격을 임의로 채우지 않습니다.' : ''}</p>
    <div class="table-scroll"><table><thead><tr><th>비교 방식</th><th>발행일 +1일<br>${esc(predictions.find((p) => p.h === 1)?.d ?? '대기')}</th><th>발행일 +7일<br>${esc(predictions.find((p) => p.h === 7)?.d ?? '대기')}</th></tr></thead><tbody>
      ${Object.entries(MODELS).map(([key, label]) => `<tr><th>${label}${unevaluated.has(key) ? ' <span class="tag g">평가 전</span>' : ''}</th>${[1, 7].map((h) => `<td${unevaluated.has(key) ? ' class="r-dim"' : ''}>${fmt(predictions.find((p) => p.model === key && p.h === h)?.value, series.unit === '골드' ? 0 : 2)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${unevaluated.size ? '<p class="hint">‘평가 전’은 아직 실제 가격과 비교한 기록이 없는 방식입니다. 값이 최근 가격과 크게 달라도 근거가 쌓이기 전에는 참고로만 보세요.</p>' : ''}
    <h4>발행 이후 실제 가격과 비교</h4>
    ${meta.methodNote ? `<p class="hint">${esc(meta.methodNote)}</p>` : ''}
    <div class="table-scroll"><table><thead><tr><th>방식 · 거리</th><th>평가 수</th><th>평균 오차(MAPE)</th><th>같은 사례의 최근 가격 유지</th><th>기준 대비</th></tr></thead><tbody>
      ${series.scores.map((s) => `<tr><th>${MODELS[s.model]} · ${s.h}일</th><td>${s.n}</td><td>${s.mape === null ? '평가 대기' : fmt(s.mape, 2) + '%'}</td><td>${s.naiveMape === null ? '—' : fmt(s.naiveMape, 2) + '%'}</td><td>${versus(s)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint">MAPE는 예측과 실제 가격의 차이를 실제 가격에 대한 %로 낸 값의 평균이며, 작을수록 좋습니다. 모델마다 평가할 수 있는 날짜가 달라 같은 날짜의 최근 가격 유지 오차와 나란히 둡니다. 기준 대비가 +이면 최근 가격을 그대로 두는 것보다 오차가 큰 것입니다.
      대상일 종료 후 최소 24시간을 더 기다린 첫 정상 집계에서 실측을 고정합니다. 확정일 ${series.settled}일 중 미관측 ${series.missingActuals}일은 평가에서 제외합니다.
      예측은 매일 KST 02시 이후 첫 정상 실행에 발행하며 당일 가격은 학습하지 않으므로, 표의 +1일(발행일 다음 날)은 마지막 학습일보다 2일 뒤입니다.
      같은 요일 방식은 학습 범위의 마지막 7일 주기를 반복합니다(+7일 예측은 발행일 −7일 값).
      관측 수는 독립 표본 수가 아니며, 수익성·통계적 유의성을 입증하지 않습니다.</p>`;
  const lines = [{ label: '실측', color: colors.ink, points: series.daily.slice(-56) },
    ...Object.entries(MODELS).map(([model, label]) => ({ label, color: colors[MODEL_STYLE[model].color], style: MODEL_STYLE[model].style,
      points: predictions.filter((p) => p.model === model) }))];
  return plot(box.querySelector('.research-forecast-chart'), lines, series.unit);
}
