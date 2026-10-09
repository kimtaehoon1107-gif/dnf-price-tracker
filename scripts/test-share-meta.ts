import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';

// 링크를 카카오톡·디스코드·X 등에 붙였을 때 미리보기 이미지가 나오려면 페이지마다 og:image(절대 주소)와 카드 종류가 있어야 한다.
// 새 페이지를 추가하고 공유 메타를 빠뜨리거나, 이미지를 지우거나 빌드 복사 목록에서 빼면 여기서 막는다.

const BASE = 'https://kimtaehoon1107-gif.github.io/dnf-price-tracker/';
const IMAGE = 'og-image.png';

// 빌드가 배포본에 복사하는 파일 목록(web/build.ts)에서 페이지와 이미지를 찾는다.
const build = readFileSync('web/build.ts', 'utf8');
const copied = new Set([...build.matchAll(/'([\w-]+\.(?:html|png))'/g)].map((m) => m[1]));
const pages = [...copied].filter((file) => file.endsWith('.html'));
assert(pages.length >= 7, `빌드가 복사하는 페이지를 찾지 못함: ${pages.join(', ')}`);
assert(copied.has(IMAGE), `web/build.ts의 복사 목록에 ${IMAGE}가 있어야 배포본에 올라감`);

const meta = (html: string, attr: 'property' | 'name', key: string) =>
  html.match(new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`))?.[1];

for (const page of pages) {
  const html = readFileSync(`web/${page}`, 'utf8');
  const og = (key: string) => meta(html, 'property', `og:${key}`);
  assert(og('title') && og('description'), `${page}: og:title·og:description이 있어야 함`);
  assert.equal(og('type'), 'website', `${page}: og:type`);
  assert.equal(og('site_name'), '던파 경매장 시세 추적기', `${page}: og:site_name`);
  assert.equal(og('locale'), 'ko_KR', `${page}: og:locale`);
  assert.equal(og('url'), page === 'index.html' ? BASE : `${BASE}${page}`, `${page}: og:url은 이 페이지의 배포 주소여야 함`);
  assert.equal(og('image'), `${BASE}${IMAGE}`, `${page}: og:image는 절대 주소여야 함(상대 주소는 공유 서비스가 읽지 못함)`);
  assert.equal(og('image:width'), '1200', `${page}: og:image:width`);
  assert.equal(og('image:height'), '630', `${page}: og:image:height`);
  assert((og('image:alt') ?? '').length > 5, `${page}: og:image:alt`);
  assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image', `${page}: twitter:card`);
}

// 이미지 파일: 실제로 있고, PNG이며, 선언한 크기(1200×630)와 같고, 서비스별 용량 제한(수 MB)보다 훨씬 작다.
assert(existsSync(`web/${IMAGE}`), `web/${IMAGE}가 있어야 함`);
const png = readFileSync(`web/${IMAGE}`);
assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${IMAGE}는 PNG여야 함`);
assert.equal(png.readUInt32BE(16), 1200, `${IMAGE} 너비`);
assert.equal(png.readUInt32BE(20), 630, `${IMAGE} 높이`);
assert(statSync(`web/${IMAGE}`).size < 400 * 1024, `${IMAGE}가 400KB를 넘음 — 미리보기가 느리게 뜰 수 있음`);

console.log(`공유 메타 테스트 통과: 페이지 ${pages.length}개의 og:image(절대 주소)·og:url·twitter:card, 이미지 1200×630 PNG`);
