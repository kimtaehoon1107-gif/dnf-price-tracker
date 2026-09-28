// 공개된 통합 빌드를 고정해 감사한다. 운영 DB·수집에는 접근하지 않는다.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const base = 'https://kimtaehoon1107-gif.github.io/dnf-price-tracker/data/';
const out = process.argv[2] ?? 'data/package-study-input';
async function get(path: string) {
  const r = await fetch(base + path);
  assert(r.ok, `${path}: HTTP ${r.status}`);
  return r.text();
}
const summaryText = await get('summary.json');
const summary = JSON.parse(summaryText);
const members = JSON.parse(readFileSync('config/package-study-members.json', 'utf8'));
for (const m of members) {
  const matches = summary.items.filter((i: any) => i.item_id === m.id && i.item_name === m.name);
  assert.equal(matches.length, 1, m.name);
  assert.equal(matches[0].price_basis, 'trade', m.name);
}
mkdirSync(`${out}/series`, { recursive: true });
// 작은 파일 21개. 순차 조회 후 배포가 바뀌지 않았는지 확인한다.
for (const m of members) writeFileSync(`${out}/series/${m.id}.json`, await get(`series/${m.id}.json`));
assert.equal(await get('summary.json'), summaryText, '조회 중 배포 변경: 다시 실행하세요');
writeFileSync(`${out}/summary.json`, summaryText);
writeFileSync(`${out}/members.json`, JSON.stringify(members, null, 2) + '\n');
console.log(JSON.stringify({ out, asOf: summary.priceAsOf, members: members.length }));
