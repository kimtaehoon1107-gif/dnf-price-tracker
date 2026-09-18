import { PACKAGE, PARTS, PREMIUM_AURA, initialPackageState, packagePrices, calculatePackage } from './package-calc.js?v=20260918';

export { initialPackageState };
const fmt = (n) => n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('ko-KR');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gold = (n) => n == null ? '계산 대기' : `${fmt(n)} 골드`;
const time = (d) => d ? new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '기록 없음';
const field = (key, label, value, { max = 1e12, step = 'any', placeholder = '', min = 0 } = {}) =>
  `<label class="pkg-field" for="pkg-${key}"><span>${label}</span><input id="pkg-${key}" data-pkg="${key}" type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}"></label>`;
const select = (key, label, value, choices) => `<label class="pkg-field" for="pkg-${key}"><span>${label}</span>
  <select id="pkg-${key}" data-pkg="${key}" aria-label="${label}">${choices.map(([v, t]) => `<option value="${v}"${v === value ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
const stat = (label, value, note = '') => `<div><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
const refPrice = (data, id) => data.items?.find((i) => i.item_id === id)?.vwap24;
const applyButton = '<button type="button" class="pkg-apply" data-pkg-apply>계산하기</button>';

function contents(data, state) {
  const prices = packagePrices(data), r = calculatePackage(state, prices);
  const complete = PARTS.every(([k]) => prices[k] !== null);
  const sum = complete ? PARTS.reduce((s, [k]) => s + prices[k], 0) : null;
  const net = sum === null ? null : sum * .97;
  const margin = prices.package && net !== null ? (net / prices.package - 1) * 100 : null;
  const open = (id) => state.open?.[id] ? ' open' : '';
  const rateSet = state.rate !== '';
  const expired = Date.now() >= Date.parse(PACKAGE.ends);
  const priceField = (key, name) => `<div>${field(`prices.${key}`, `${name} 단가 (골드)`, state.prices[key], { placeholder: prices[key] === null ? '시세 없음 · 직접 입력' : `자동 ${fmt(prices[key])}` })}
    <small class="pkg-note">${state.prices[key] !== undefined && state.prices[key] !== '' ? '직접 입력 적용' : prices[key] === null ? '관측 체결 없음' : '24h 체결 VWAP 적용'}</small></div>`;
  return `<section class="panel pkg-overview" aria-label="유랑악단 패키지 해체 마진">
    <div class="pkg-heading"><h3>유랑악단 패키지 해체 마진</h3><a href="research.html#package">가격 추이·이벤트 관측 →</a></div>
    <div class="pkg-stats">
      ${stat('패키지 가격', gold(prices.package))}${stat('구성 상자 5종 합계', gold(sum))}
      ${stat('수수료 3% 반영 차이', prices.package && net !== null ? gold(net - prices.package) : '계산 대기', margin === null ? '' : `${margin >= 0 ? '+' : ''}${margin.toFixed(2)}%`)}
    </div>
    <p class="hint">최근 24시간 체결의 수량가중평균입니다. 구성 상자 5종이 모두 관측될 때 계산하며, 같은 시점에 사고팔 수 있는 차익을 뜻하지 않습니다. 아래 계산기의 직접 입력값은 이 시세 요약을 바꾸지 않습니다.</p>
  </section>
  <section class="panel pkg-calculator" aria-labelledby="pkg-heading">
    <div class="pkg-heading"><h3 id="pkg-heading">주또주 가치 계산기</h3><button type="button" data-pkg-reset>입력 초기화</button></div>
    <p class="desc">이번에 추가로 구매할 때의 지출·판매 회수액·귀속 보상을 비교합니다. <b>세라샵 구매·선물 기준</b>이며 경매장 구매에는 주또주가 지급되지 않습니다.</p>
    ${expired ? '<p class="pkg-alert">판매 기간이 종료되었습니다. 현재 결과는 과거 보상 규칙을 이용한 시뮬레이션이며 보상 수령을 뜻하지 않습니다.</p>' : ''}
    <div class="pkg-fields">
      ${field('previous', '기존 구매 개수', state.previous, { max: 1000, step: 1 })}
      ${field('additional', '추가 구매 개수', state.additional, { max: 1000, step: 1 })}
      ${select('mode', '추가 패키지 처리', state.mode, [['package', '패키지 그대로 판매'], ['parts', '구성 상자 선택 판매'], ['keep', '모두 보관']])}
    </div>
    <div class="pkg-actions">${applyButton}<small>값을 바꾼 뒤 계산하기를 누르세요. 입력 중 Enter로도 적용할 수 있습니다.</small></div>
    <details data-pkg-detail="cost"${open('cost')}><summary>구매 비용·수수료·골드 환산 설정</summary><div class="pkg-fields">
      ${field('sera', '개당 구매 비용 (세라)', state.sera)}
      ${field('fee', '판매 수수료 (%)', state.fee, { max: 100 })}
      ${field('rate', '1,000세라당 골드 (선택)', state.rate, { placeholder: '직접 정한 환산 기준' })}
    </div><p class="hint">정가 ${fmt(PACKAGE.sera)}세라를 기본으로 사용합니다. 할인은 개당 비용에 반영하세요. 환산 기준이 없으면 세라와 골드를 별도로 표시합니다. 입력은 현재 페이지에서만 유지됩니다.</p>${applyButton}</details>
    <details data-pkg-detail="sales"${open('sales')}><summary>판매·보관 수량과 단가 조정</summary>
      <p class="hint">${r.additional}개 구매 기준입니다. 보관하는 수량은 판매액에서 제외됩니다. 단가 입력을 비우면 관측 VWAP을 사용하며, 시세가 없으면 0골드로 대체하지 않습니다.</p>
      ${r.sales.length ? r.sales.map((s) => `<div class="pkg-sale-row"><b>${s.name}</b><div class="pkg-fields">
        ${field(`keep.${s.key}`, `${s.name} 보관 수량`, state.keep[s.key] ?? 0, { max: r.additional, step: 1 })}
        ${priceField(s.key, s.name)}
      </div><p class="pkg-note">판매 ${s.qty}개 · 수수료 반영 ${gold(s.net)}</p></div>`).join('') : '<p class="hint">모두 보관을 선택해 기본 구성품의 판매 회수액은 0골드입니다.</p>'}
      ${applyButton}
    </details>
    <details data-pkg-detail="coins"${open('coins')}><summary>프리미엄 코인 교환 · 새 코인 ${fmt(r.addedCoins)}개</summary>
      <div class="pkg-fields">
        ${field('ownedCoins', '현재 보유 코인', state.ownedCoins, { max: 10000, step: 1 })}
        ${field('cardsUsed', '이번 판매 기간 멜로디 교환 완료 수', state.cardsUsed, { max: 50, step: 1 })}
        ${field('aurasUsed', '이번 판매 기간 오라 교환 완료 수', state.aurasUsed, { max: 5, step: 1 })}
        ${field('auraCount', '열대야 오라 교환 목표 수', state.auraCount, { max: 5, step: 1 })}
        ${priceField('melody', '실반 멜로디 카드')}
      </div>
      <label class="pkg-check"><input type="checkbox" data-pkg="exchangeCards"${state.exchangeCards ? ' checked' : ''}>오라 교환 후 남은 코인으로 멜로디 카드를 최대한 교환·판매</label>
      <p class="hint">오라 8코인·계정당 5회, 멜로디 카드 2코인·계정당 50회. 오라를 먼저 배정하고 멜로디 카드 교환 여부를 적용합니다. 그 외 교환품은 이번 계산에 포함하지 않으며 남는 코인은 보관합니다.</p>
      <div class="pkg-coin-compare"><span>현재 코인만 사용<br><b>오라 ${r.before.auras} · 카드 ${r.before.cards} · 잔여 ${r.before.left}</b></span><span>새 코인 합산 후<br><b>오라 ${r.after.auras} · 카드 ${r.after.cards} · 잔여 ${r.after.left}</b></span></div>
      <p class="hint">두 경우에 같은 교환 목표·순서를 적용해 차이만 회수액에 더합니다. 기존 코인으로도 얻을 수 있는 카드는 중복 합산하지 않습니다. 오라 선택으로 카드 판매량이 줄면 코인 회수액 차이가 음수가 될 수 있습니다.</p>
      ${applyButton}
    </details>
    <div id="pkg-results" aria-live="polite">
      ${r.errors.length ? `<div class="pkg-alert" role="alert">${r.errors.map(esc).join('<br>')}</div>` : `
        <p class="pkg-progress">${r.previous}개 → ${r.previous + r.additional}개 구매 · 새 코인 ${r.addedCoins}개 · 추가 귀속 보상 ${r.rewards.length}종</p>
        <div class="pkg-stats pkg-result-stats">
          ${stat('추가 지출', `${fmt(r.seraCost)} 세라`, rateSet ? `사용자 환산 ${gold(r.costGold)}` : '골드 환산 기준 미입력')}
          ${stat('추가 판매 회수액', gold(r.recovered), '기본 구성품 + 코인 교환 증가분')}
          ${stat('귀속 보상 개인 가치', r.valued ? gold(r.personal) : '미평가', `${r.valued}항목 직접 평가 · 판매액과 별도`)}
        </div>
        <p class="pkg-breakdown">기본 구성품 판매 ${gold(r.salesNet)} + 코인 교환 차이 ${gold(r.coinNet)}</p>
        ${r.missing.length ? `<p class="pkg-alert">단가 확인 필요: ${r.missing.map(esc).join(', ')}. 누락 단가를 입력하면 전체 회수액을 계산합니다.</p>` : ''}
        ${r.burden === null ? '' : `<p class="pkg-burden">환산 지출 − 판매 회수액: <b>${gold(r.burden)}</b><br><small>귀속 보상·보관한 구성품을 남기는 데 드는 사용자 환산 기준 부담액입니다. 개인 가치는 이 금액에서 자동 차감하지 않습니다.</small></p>`}
      `}
    </div>
    <details data-pkg-detail="rewards"${open('rewards')}><summary>이번에 받는 귀속 보상 · 개인 가치 입력</summary>
      <p class="hint">판매할 수 있는 골드가 아닙니다. 직접 쓸 보상만 평가해 입력하세요. 미입력은 합산에서 제외하며 가치가 없다는 뜻은 아닙니다. 거래형 참고 가격은 귀속형의 확정 가치가 아닙니다.</p>
      ${r.rewards.map((reward) => `<div class="pkg-reward"><div><b>${reward.at}회차 · ${reward.name}</b>
        ${reward.note ? `<p class="pkg-note">${reward.note}</p>` : ''}
        ${reward.ref ? `<p class="pkg-note">거래형 참고 VWAP ${gold(refPrice(data, reward.ref))} · 거래·사용 제한 차이 있음</p>` : ''}</div>
        ${field(`values.${reward.at}`, `${reward.at}회차 ${reward.at === 1 ? '변경 후 크리쳐' : '보상'} 사용 가치 (골드)`, state.values[reward.at], { placeholder: '미입력 · 합산 제외' })}
        ${reward.at === 1 ? field('firstCost', '변경권 사용에 필요한 크리쳐·재료 비용 (골드)', state.firstCost, { placeholder: '보유 크리쳐도 대체 가치 입력' }) : ''}
      </div>`).join('') || '<p class="hint">선택 구간에는 새 귀속 보상이 없습니다. 11회차부터는 매회 코인 1개입니다.</p>'}
      ${r.deltaAuras > 0 ? `<div class="pkg-reward"><div><b>코인 교환으로 늘어난 열대야 오라 ${r.deltaAuras}개</b><p class="pkg-note">거래형 참고 VWAP ${gold(refPrice(data, PREMIUM_AURA))}</p></div>
        ${field('auraValue', '열대야 오라 1개 사용 가치 (골드)', state.auraValue, { placeholder: '미입력 · 합산 제외' })}</div>` : ''}
      ${applyButton}
    </details>
    <p class="hint">시세 기준 ${esc(time(data.priceAsOf))} KST · 실시간 매물·대량 판매 가능성을 반영하지 않습니다. 귀속 보상은 사용 조건과 삭제일을 확인하세요. 확률형 개봉 기대값은 포함하지 않습니다.
      <a href="${PACKAGE.source}" target="_blank" rel="noopener">공식 구매 조건 ↗</a> · <a href="https://df.nexon.com/pg/forestbandpkg" target="_blank" rel="noopener">회차별 보상·코인샵 ↗</a></p>
  </section>`;
}

export function packagePanelHTML(data, state) {
  return `<div id="package-panel">${contents(data, state)}</div>`;
}

export function bindPackagePanel(data, state) {
  const root = document.getElementById('package-panel');
  if (!root) return;
  const bindDetails = () => root.querySelectorAll('[data-pkg-detail]').forEach((el) => {
    el.ontoggle = () => { (state.open ??= {})[el.dataset.pkgDetail] = el.open; };
  });
  const refresh = () => { root.innerHTML = contents(data, state); bindDetails(); };
  root.oninput = root.onchange = (event) => {
    const el = event.target, key = el.dataset.pkg;
    if (!key) return;
    const [group, name] = key.split('.');
    const value = el.type === 'checkbox' ? el.checked : el.value;
    if (name) state[group][name] = value; else state[group] = value;
    root.querySelector('#pkg-results').innerHTML = '<p class="pkg-progress">입력값이 변경되었습니다. 계산하기를 눌러 결과를 갱신하세요.</p>';
  };
  root.onclick = (event) => {
    if (event.target.closest('[data-pkg-apply]')) { refresh(); return; }
    if (!event.target.closest('[data-pkg-reset]')) return;
    Object.assign(state, initialPackageState(), { open: {} });
    refresh();
  };
  root.onkeydown = (event) => {
    if (event.key === 'Enter' && event.target.matches('input')) { event.preventDefault(); refresh(); }
  };
  bindDetails();
}
