import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 외부 글꼴 스타일시트(Pretendard · IBM Plex Mono)가 첫 화면을 막으면, 그 서버가 느리거나 막힌 사람은 화면이 빈 채로 기다린다.
// 그래서 media="print"로 받아 두었다가 다 받으면 onload에서 all로 바꿔 적용하고, 스크립트가 꺼진 환경은 noscript가 대신한다.
// 이 방식은 인라인 onload에 기대므로 script-src 'self' CSP가 있는 페이지(feedback.html)에서는 글꼴이 영영 안 켜진다 → 그런 페이지는 쓰면 안 된다.

const build = readFileSync('web/build.ts', 'utf8');
const pages = [...new Set([...build.matchAll(/'([\w-]+\.html)'/g)].map((m) => m[1]))];
assert(pages.length >= 7, `빌드가 복사하는 페이지를 찾지 못함: ${pages.join(', ')}`);

// Pretendard는 우리 서버에 둔 굵기 2종 스타일시트(web/pretendard-400-600.css), IBM Plex Mono는 Google Fonts.
const FONT_LINK = /<link rel="stylesheet" href="((?:https:\/\/fonts\.googleapis\.com\/css2|pretendard-400-600\.css)[^"]*)"([^>]*)>/g;
let lazyPages = 0;
for (const page of pages) {
  const html = readFileSync(`web/${page}`, 'utf8');
  const hasCsp = /http-equiv="Content-Security-Policy"/.test(html);
  // <noscript> 안의 대체 링크는 스크립트가 꺼졌을 때만 쓰이므로 검사에서 뺀다
  const live = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
  const links = [...live.matchAll(FONT_LINK)];
  if (!hasCsp && links.length) assert.equal(links.length, 2, `${page}: 글꼴 링크(Pretendard · IBM Plex Mono)가 둘 다 있어야 함`);
  let lazy = 0;
  for (const [, href, rest] of links) {
    const isLazy = /media="print"/.test(rest);
    if (hasCsp) { assert(!isLazy, `${page}: CSP 때문에 인라인 onload가 막히는 페이지는 글꼴 링크를 media="print"로 두면 안 됨`); continue; }
    assert(isLazy, `${page}: ${href} 가 첫 화면을 막고 있음 — media="print" onload="this.media='all'" 로 받으세요`);
    assert(rest.includes(`onload="this.media='all'"`), `${page}: ${href} 에 onload="this.media='all'"가 없으면 글꼴이 영영 안 켜짐`);
    assert(html.includes(`<noscript>`) && new RegExp(`<noscript>[\\s\\S]*${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*</noscript>`).test(html), `${page}: ${href} 의 noscript 대체 링크가 없음`);
    lazy++;
  }
  if (lazy) lazyPages++;
}
assert(lazyPages >= 5, `글꼴을 막지 않고 받는 페이지가 ${lazyPages}개뿐 (홈·분석·TOP100·지표·실험 5개 기대)`);

console.log(`글꼴 스타일시트 로딩 테스트 통과: ${lazyPages}개 페이지가 첫 화면을 막지 않고 받음 · noscript 대체 · CSP 페이지는 제외`);
