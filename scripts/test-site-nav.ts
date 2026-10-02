import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// 모든 화면의 상단 메뉴가 같은 순서·같은 대상을 가리켜야 한다. seasonal.html만 다른 헤더를 쓰고
// 연구 원장으로 가는 길이 한 곳뿐이던 문제를 다시 만들지 않기 위한 대조다.
const EXPECTED = ['index.html', 'index.html#compare', 'ranking.html', 'analysis.html', 'research.html', 'ledger.html', 'guide.html',
  'https://github.com/kimtaehoon1107-gif/dnf-price-tracker'];
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
const normalize = (list: string[]) => list.map((h) => (h === '#compare' ? 'index.html#compare' : h));

const pages = readdirSync('web').filter((f) => f.endsWith('.html'));
assert(pages.length >= 8, '메뉴를 점검할 화면 목록');
for (const page of pages) {
  const html = readFileSync(`web/${page}`, 'utf8');
  const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0];
  assert(header, `${page}: 공용 헤더 없음`);
  const navs = [...header.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/g)].map((m) => normalize(hrefs(m[1])));
  assert.equal(navs.length, 2, `${page}: 데스크톱·모바일 메뉴가 각각 있어야 한다`);
  for (const nav of navs) assert.deepEqual(nav, EXPECTED, `${page}: 메뉴 구성이 다르다`);
  assert(/<header class="top">/.test(header), `${page}: 공용 헤더 클래스`);
  assert(/href="style\.css/.test(html), `${page}: 공용 스타일시트(style.css)를 써야 한다`);
}
// 스크립트가 만드는 패키지 연구 화면도 같은 메뉴를 쓴다.
const generated = readFileSync('scripts/package-study.ts', 'utf8');
const array = generated.match(/const nav = (\[\[[\s\S]*?\]\])\s*\.map/)?.[1];
assert(array, 'package-study.ts의 메뉴 정의');
const hrefsOfGenerated = [...array.matchAll(/\['([^']+)', '[^']+'\]/g)].map((m) => m[1]);
assert.deepEqual([...hrefsOfGenerated, EXPECTED.at(-1)], EXPECTED, 'package-study.html의 메뉴 구성이 다르다');
console.log(`상단 메뉴 일관성: web/*.html ${pages.length}개와 생성되는 패키지 연구 화면이 같은 구성(비교·연구 원장 포함)`);
