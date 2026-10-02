// 유랑악단 패키지 판매 종료(2026-11-05 06:00 KST)까지의 단계와 연구 진행을 보여 주는 얇은 띠.
// 서버 자료 없이 시각만으로 계산한다. 구간은 docs/package-end-preregistration.md와 같다.
const DAY = 86400000, KST = 9 * 3600000;
export const DELETE_AT = Date.parse('2026-11-05T06:00:00+09:00');
const day = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / DAY);
const kstDay = (t) => new Date(t + KST).toISOString().slice(0, 10);

export function bannerState(now) {
  const today = kstDay(now), dday = day('2026-11-05') - day(today);
  if (now < DELETE_AT) {
    const lead = dday === 0 ? '오늘 06시 삭제' : `D-${dday}`;
    if (today < '2026-10-22') {
      const n = Math.max(0, Math.min(42, day(today) - day('2026-09-10')));
      return { show: true, stage: 'baseline', lead, text: `패키지 판매 종료 · 삭제 전 연구 기준선 ${n}/42일` };
    }
    const n = Math.min(14, day(today) - day('2026-10-22'));
    return { show: true, stage: 'anticipation', lead, text: `패키지 판매 종료 · 삭제 전 14일 관측 ${n}/14일` };
  }
  if (today <= '2026-12-03') {
    const n = Math.max(0, Math.min(14, day(today) - day('2026-11-06')));
    return { show: true, stage: 'after', lead: '삭제 완료', text: `삭제 뒤 비교 관측 중 · 1차 구간 ${n}/14일` };
  }
  return { show: false };
}

export function mountBanner(el, now = Date.now()) {
  const s = bannerState(now);
  if (!el || !s.show) return s;
  el.hidden = false;
  el.dataset.stage = s.stage;
  el.replaceChildren();
  const lead = Object.assign(document.createElement('b'), { className: 'eb-lead', textContent: s.lead });
  const text = Object.assign(document.createElement('span'), { className: 'eb-text', textContent: s.text });
  const link = Object.assign(document.createElement('span'), { className: 'eb-link', textContent: '연구 원장 →' });
  el.append(lead, text, link);
  return s;
}

if (typeof document !== 'undefined') mountBanner(document.getElementById('event-banner'));
