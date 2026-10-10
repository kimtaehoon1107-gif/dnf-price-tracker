// Pretendard 동적 서브셋 스타일시트에서 일반(400)·세미볼드(600) 블록만 골라 web/pretendard-400-600.css 로 쓴다.
// 사이트는 굵기를 4가지(400·500·600·700) 선언하지만, 이 파일에는 400과 600만 있어 500은 400으로, 700은 600으로 브라우저가 대신 그린다.
// 같은 화면을 찍어 비교하면 달라지는 픽셀이 0.1~2.3%라 눈으로 구분하기 어렵고, 굵기마다 따로 받던 글꼴 파일이 줄어든다(홈 521KB → 363KB).
// 글꼴 파일(woff2)은 그대로 jsdelivr에서 받고, 스타일시트만 우리 서버에서 내려 준다(원본은 굵기 9가지 × 조각 92개 = 블록 828개).
//
//   node scripts/build-pretendard-subset.ts     (jsdelivr에서 원본 스타일시트를 받으므로 네트워크가 필요하다)
//
// Pretendard를 올릴 때는 VERSION만 바꿔 다시 실행하고, 글꼴 링크의 ?v= 문자열도 함께 올린다. 만든 파일은 직접 고치지 않는다.
import { writeFileSync } from 'node:fs';

const VERSION = 'v1.3.9';
const SOURCE = `https://cdn.jsdelivr.net/gh/orioncactus/pretendard@${VERSION}/dist/web/static/pretendard-dynamic-subset.min.css`;
const OUTPUT = 'web/pretendard-400-600.css';
const KEEP = [400, 600];

const css = await (await fetch(SOURCE)).text();
const blocks = css.match(/@font-face\{[^}]*\}/g) ?? [];
if (!blocks.length) throw new Error(`@font-face 블록을 찾지 못함: ${SOURCE}`);
const weightOf = (block: string) => Number(block.match(/font-weight:(\d+)/)?.[1]);

// 상대 주소(../../../packages/...)를 절대 주소로 바꿔야, 우리 서버에 둔 스타일시트에서도 글꼴 파일을 jsdelivr에서 받는다.
const kept = blocks
  .filter((block) => KEEP.includes(weightOf(block)))
  .map((block) => block.replace(/url\(([^)]*)\)/g, (_, relative: string) => `url(${new URL(relative.replace(/^['"]|['"]$/g, ''), SOURCE).href})`));
const counts = KEEP.map((weight) => kept.filter((block) => weightOf(block) === weight).length);
if (counts.some((n) => n === 0 || n !== counts[0])) throw new Error(`굵기별 블록 수가 다름: ${KEEP.map((w, i) => `${w}:${counts[i]}`).join(' ')}`);

// 같은 조각(unicode-range)의 400·600 블록을 붙여 둔다. 범위 목록이 길어서(조각마다 수백 자) 가까이 있어야 gzip이 겹치는 부분을 줄여 준다.
const bySubset = new Map<string, string[]>();
for (const block of kept) {
  const range = block.match(/unicode-range:([^;}]*)/)?.[1] ?? '';
  bySubset.set(range, [...(bySubset.get(range) ?? []), block]);
}
const ordered = [...bySubset.values()].flatMap((group) => group.sort((a, b) => weightOf(a) - weightOf(b)));

writeFileSync(OUTPUT, `/* Pretendard ${VERSION} 동적 서브셋 중 일반(400)·세미볼드(600)만. scripts/build-pretendard-subset.ts가 만든 파일이라 직접 고치지 않는다. 글꼴 파일(woff2)은 jsdelivr에서 받는다. */\n${ordered.join('\n')}\n`);
console.log(`${OUTPUT}: ${kept.length}개 블록 (굵기 ${KEEP.join('·')} × 조각 ${counts[0]}개) ← ${blocks.length}개 중`);
