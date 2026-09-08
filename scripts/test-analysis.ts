import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 실제 페이지의 표시 로직을 실행해 데이터가 바뀌어도 결론이 고정되지 않게 한다.
const html = readFileSync(new URL('../web/analysis.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
const item = (vr: number, significant = false) => ({
  item_name: '검정 종목', vr, significant, bars: 40, per_bar: 10,
  from: '2026-09-06T00:00:00Z', to: '2026-09-07T15:00:00Z',
  z: vr < 1 ? -3 : 3, p: 0.003, adjustedP: significant ? 0.03 : 0.1,
});

async function render(rows: ReturnType<typeof item>[], forecasts: unknown[] = []) {
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)]
    .map((m) => [m[1], { textContent: '', innerHTML: '' }]));
  const data = {
    builtAt: '2026-09-08T14:00:00Z',
    meta: { lo: '2026-08-08', items: 68, trades: 40000, depletion_qty: 123 },
    randomWalk: {
      total: rows.length, candidates: 34, minBars: 30, q: 2,
      medianVr: rows.length ? rows[0].vr : null, items: rows,
      significant: rows.filter((r) => r.significant).length,
      negative: rows.filter((r) => r.significant && r.vr < 1).length,
      positive: rows.filter((r) => r.significant && r.vr > 1).length,
      thickness: [], excluded: [{ item_name: '공백 종목', bars: 12, reason: '연속 관측 부족' }],
    },
    items: forecasts,
    weekdaySample: { item_count: 4, minHistoryDays: 14, minTrades: 25, mde: 4 },
    health: { global_uptime24: null, checks24: 0, item_uptime24: null, item_checks24: 0 },
  };
  await vm.runInNewContext(script, {
    fetch: async () => ({ ok: true, json: async () => data }),
    document: { body: {}, getElementById: (id: string) => {
      assert(nodes.has(id), `없는 표시 요소: ${id}`);
      return nodes.get(id);
    } },
    getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
    console: { error: (error: unknown) => { throw error; } },
  });
  return (id: string) => nodes.get(id)!.textContent + nodes.get(id)!.innerHTML;
}

const empty = await render([]);
assert.match(empty('vr-verdict'), /검정 결과를 제시할 수 없습니다/);
assert.match(empty('fc-summary'), /평가할 관측이 아직 없습니다/);
assert.match(empty('vr-excluded'), /연속 관측 부족/);
assert.doesNotMatch(empty('analysis-status'), /평균회귀합니다|NaN|undefined/);

const insignificant = await render([item(0.6)]);
assert.match(insignificant('vr-verdict'), /유의한 단기 신호를 확인하지 못했습니다/);
const negative = await render([item(0.6, true)]);
assert.match(negative('vr-verdict'), /단기 반전 신호/);
assert.doesNotMatch(negative('vr-verdict'), /매수는 유리|0.7%|평균회귀합니다/);
const positive = await render([item(1.3, true)]);
assert.match(positive('vr-verdict'), /단기 지속 신호/);
const mixed = await render([item(0.6, true), item(1.3, true)]);
assert.match(mixed('vr-verdict'), /반전과 지속 신호가 함께/);

const scored = await render([], [
  { fc: { backtest: [{ horizonDays: 1, count: 1, mape: 0, naiveMape: 10, coverage: 100 }] } },
  { fc: { backtest: [{ horizonDays: 1, count: 9, mape: 20, naiveMape: 10, coverage: 0 }] } },
]);
assert.match(scored('fc-summary'), /18%/);
assert.match(scored('fc-horizons'), /-80\.0%/);
assert.match(scored('fc-summary'), /naive 오차가 더 작았습니다/);
console.log('분석 표시 테스트 통과');
