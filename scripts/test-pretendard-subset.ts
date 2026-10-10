import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Pretendard는 동적 서브셋 중 일반(400)·세미볼드(600)만 우리 서버에서 스타일시트로 내려 준다(scripts/build-pretendard-subset.ts가 만든 파일).
// 굵기를 늘리거나, 모든 굵기가 든 원본 스타일시트로 되돌리거나, 페이지가 이 파일을 빠뜨리면 글꼴 용량이 다시 커지거나 글꼴이 안 켜지므로 여기서 막는다.

const css = readFileSync('web/pretendard-400-600.css', 'utf8');
const blocks = css.match(/@font-face\{[^}]*\}/g) ?? [];
assert.equal(blocks.length, 184, '굵기 2종 × 조각 92개');

// 블록마다: Pretendard · swap · 굵기 400(Regular) 또는 600(SemiBold) · jsdelivr v1.3.9 절대 주소 · woff2 · unicode-range
const FILE_FOR = { 400: 'Regular', 600: 'SemiBold' } as const;
const subsets: Record<400 | 600, Set<number>> = { 400: new Set(), 600: new Set() };
for (const block of blocks) {
  const weight = Number(block.match(/font-weight:(\d+)/)?.[1]) as 400 | 600;
  assert([400, 600].includes(weight), `허용하지 않는 굵기: ${weight}`);
  assert(/font-family:Pretendard[;}]/.test(block) && /font-display:swap/.test(block), '글꼴 이름은 Pretendard, font-display는 swap이어야 함');
  const src = block.match(/src:url\(https:\/\/cdn\.jsdelivr\.net\/gh\/orioncactus\/pretendard@v1\.3\.9\/packages\/pretendard\/dist\/web\/static\/woff2-dynamic-subset\/Pretendard-(\w+)\.subset\.(\d+)\.woff2\) format\('woff2'\)/);
  assert(src, `글꼴 파일 주소가 jsdelivr v1.3.9의 절대 주소여야 함(상대 주소는 우리 서버 기준이 되어 404): ${block.slice(0, 170)}`);
  assert.equal(src[1], FILE_FOR[weight], `굵기 ${weight}는 ${FILE_FOR[weight]} 파일이어야 함`);
  assert(/unicode-range:U\+/.test(block), 'unicode-range가 없으면 모든 글자에 대해 글꼴 파일을 받는다');
  subsets[weight].add(Number(src[2]));
}
assert.deepEqual([...subsets[400]].sort((a, b) => a - b), [...subsets[600]].sort((a, b) => a - b), '두 굵기의 조각 번호가 같아야 함');
assert.equal(subsets[400].size, 92);

// 페이지: Pretendard를 쓰는 6개 페이지가 모두 이 파일을 같은 ?v=로 링크하고, 원본(굵기 9가지) 스타일시트는 어디에도 없다.
const build = readFileSync('web/build.ts', 'utf8');
assert(build.includes("'pretendard-400-600.css'"), 'web/build.ts의 복사 목록에 pretendard-400-600.css가 있어야 배포본에 올라감');
const pages = [...new Set([...build.matchAll(/'([\w-]+\.html)'/g)].map((m) => m[1]))];
const versions = new Set<string>();
for (const page of pages) {
  const html = readFileSync(`web/${page}`, 'utf8');
  assert(!html.includes('pretendard-dynamic-subset'), `${page}: 굵기 9가지가 든 원본 스타일시트로 되돌아가면 글꼴 용량이 다시 커짐`);
  const version = html.match(/href="pretendard-400-600\.css\?v=([\w-]+)"/)?.[1];
  if (version) versions.add(version);
  if (['index.html', 'analysis.html', 'ranking.html', 'guide.html', 'research.html', 'feedback.html'].includes(page)) assert(version, `${page}: Pretendard 스타일시트(pretendard-400-600.css?v=…) 링크가 없음`);
}
assert.equal(versions.size, 1, `페이지마다 ?v= 값이 다르면 갱신이 어긋남: ${[...versions].join(', ')}`);

console.log(`Pretendard 굵기 2종 스타일시트 테스트 통과: 블록 ${blocks.length}개(400·600 × 조각 ${subsets[400].size}개) · jsdelivr v1.3.9 절대 주소 · 6개 페이지가 같은 ?v=로 링크 · 빌드 복사 목록`);
