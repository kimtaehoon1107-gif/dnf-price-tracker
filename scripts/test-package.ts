import assert from 'node:assert/strict';
import { bunnyPackagePanelHTML, packagePanelHTML } from '../web/package.js';
const html = packagePanelHTML({ margin: { pkg: 30e6, partsSum: 33e6, partsComplete: true, fee: .03 } });
assert.match(html, /2,010,000 골드/);
assert.doesNotMatch(html, /주또주|pkg-calculator|<input|NaN|undefined/);
const missing = packagePanelHTML({ margin: { pkg: 30e6, partsSum: 20e6, partsComplete: false, fee: .03 } });
assert.match(missing, /계산 대기/);
assert.doesNotMatch(missing, /20,000,000 골드/);
assert.doesNotMatch(packagePanelHTML({}), /NaN|undefined/);
const bunny = { fee: .03, items: [30e6, 12e6, 11e6, 10e6].map((vwap, index) => ({
  id: String(index), name: String(index), vwap, n: 20,
})) };
assert.match(bunnyPackagePanelHTML(bunny), /2,010,000 골드 \(\+6\.70%\)/);
bunny.items[2].vwap = null;
assert.doesNotMatch(bunnyPackagePanelHTML(bunny), /2,010,000|22,000,000|NaN/);
assert.match(bunnyPackagePanelHTML(bunny), /수수료 3% 반영 해체 마진<\/span><strong>계산 대기/);
console.log('패키지 해체 마진·결측·가치계산기 제거 통과');
