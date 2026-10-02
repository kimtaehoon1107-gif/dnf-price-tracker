import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { study, type Input, type Member } from '../src/package-study.ts';

const source = process.argv[2] ?? 'dist/data', out = process.argv[3] ?? 'dist';
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const members: Member[] = read('config/package-study-members.json');
const summary = read(`${source}/summary.json`);
const input: Input = { asOf: summary.priceAsOf, members, series: {} };
for (const m of members) {
  const item = summary.items.find((i: any) => i.item_id === m.id);
  assert(item && item.item_name === m.name && item.price_basis === 'trade', `종목 불일치: ${m.name}`);
  const series = read(`${source}/series/${m.id}.json`);
  assert.equal(series.priceBasis, 'trade');
  input.series[m.id] = series.daily.map(({ d, vwap, n }: any) => ({ d, vwap, n }));
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const report = { ...study(input), provenance: { builtAt: summary.builtAt, inputSha256: hash(JSON.stringify(input)),
  membersSha256: hash(readFileSync('config/package-study-members.json', 'utf8')),
  historySourcesSha256: hash(readFileSync('config/history-sources.json', 'utf8')),
  note: 'R2+A/B/C 통합 사이트의 관측 체결 일봉. 첫 체결일은 수집 시작일이 아니며, 무거래·수집 실패는 일봉만으로 구분 불가.' },
  tradeThresholdSensitivity: [3, 10].map(n => { const r = study(input, n); return { minimumTrades: n, groupCoverage: r.groupCoverage, results: r.results }; }) };
const label = { pending: '기간 종료 대기', insufficient: '유효일 부족 · 계산 보류', ready: '계산 완료 · 인과 확인 아님', not_applicable: '대상 삭제 · 사후 분석 불가' };
const fmt = (v: number | null) => v === null ? '—' : v.toFixed(3);
const lines = [
  '# 유랑악단 판매 종료 연구 · 자료 점검', '',
  `규칙: ${report.version} · 자료 기준: ${report.asOf} · 완료일: ${report.through}`, '',
  '사건: 2026-11-05 06:00 KST 판매 종료 및 아이템 삭제. 패키지·구성 상자 6종과 플로럴 스태그 플래티넘 크리쳐 알 선택 상자가 삭제됩니다.', '',
  '공식 공지: https://df.nexon.com/community/news/seriashop/656', '',
  '삭제 전 상대 가격 변화(H2)와 해체 마진만 분석합니다. 삭제 후 가격 상승 가설은 대상 소멸로 분석 불가입니다. 생존 품목 사후 연구는 별도 설계로 분리합니다.', '',
  '## 21종 자료 준비 상태', '',
  '평가 기간은 09-10부터 마지막 완료일(최대 10-21)까지입니다. 유효일은 API 관측 체결 5건 이상입니다.', '',
  '| 집단 | 품목 | 첫 관측 체결일 | 마지막 체결일 | 유효일/대상일 | 일봉 없음 | 5건 미만 |',
  '|---|---|---|---|---:|---:|---:|',
  ...report.audit.map(m => `| ${m.group} | ${m.name} | ${m.firstTradeDay ?? '—'} | ${m.lastTradeDay ?? '—'} | ${m.valid}/${m.expected} | ${m.noDailyRow.length} | ${m.thinDays.length} |`), '',
  `고정 구성 전체 충족일: 처치 ${report.groupCoverage.treatment}, 통제 ${report.groupCoverage.control}, 파급 ${report.groupCoverage.spillover}.`, '',
  '## 가설별 계산', '', '| 가설 | 상태 | 관측 변화 |', '|---|---|---:|',
  ...Object.entries(report.results).map(([key, r]) => `| ${key.toUpperCase()} | ${label[r.status as keyof typeof label]} | ${fmt(r.relativePercent)}% |`), '',
  'H2는 09-10~10-21 대비 10-22~11-04의 처치군-통제군 로그 차이를 exp(차이)-1로 변환한 상대 변화율입니다. 상승·하락 양방향을 기술합니다.', '',
  `삭제 전 해체 마진(10-22~11-04): ${label[report.preExpiryMargin.status as keyof typeof label]}, 평균 ${fmt(report.preExpiryMargin.meanPercent)}%, 최소 ${fmt(report.preExpiryMargin.minPercent)}%, 최대 ${fmt(report.preExpiryMargin.maxPercent)}%, ±3% 밖 날짜 비율 ${fmt(report.preExpiryMargin.outside3PercentShare === null ? null : report.preExpiryMargin.outside3PercentShare * 100)}%.`, '',
  '일별 체결가는 동시 매매 가능한 가격이 아니므로 마진은 실제 수익·무차익 입증이 아닙니다.', '',
  '## 사건 전 진단', '',
  ...Object.entries(report.diagnostics).map(([g, d]) => `- ${g}: 공통 유효일 ${d.valid}일, 초과 로그 가격의 일간 기울기 ${fmt(d.excessLogSlopePerDay === null ? null : d.excessLogSlopePerDay * 100)} 로그%/일, 연속일 변화 상관 ${fmt(d.dailyChangeCorrelation)}.`), '',
  '기울기와 상관은 진단 자료이며 평행추세를 입증하거나 통제군을 자동 교체하는 기준이 아닙니다.', '',
  '## 플라시보와 탐지 민감도', '',
  `시간 플라시보 후보 29개 중 현재 계산 가능 ${report.timePlacebo.usable}개, 목요일 후보 5개 중 ${report.timePlacebo.usableThursdays}개. 겹치는 구간이므로 독립 반복이 아닙니다.`,
  '- 삭제 후 실제 사건값이 정의되지 않으므로 H3 순위는 계산하지 않습니다. 시간 플라시보는 사건 전 변동의 기술 자료입니다.',
  '- 공간 플라시보는 단일 품목과 6종·7종 합성의 단위가 달라 실제 효과와 순위를 매기지 않습니다. 개별 결과는 JSON에 기록합니다.',
  `- H2 가정하 참고 탐지 변화: ${fmt(report.sensitivity.h2?.relativePercent ?? null)}%`,
  '- 참고 탐지 변화는 10-21 완료 뒤, 연속일 변화 20개 이상일 때만 계산합니다. 실제 검정력 80%를 보장하지 않습니다.', '',
  '## 자료와 해석의 한계', '',
  '- 고정 구성 전체가 유효한 공통 날짜만 사용합니다. 각 비교 구간의 80% 이상이 필요하며 부족하면 종목을 빼거나 보간하지 않고 보류합니다.',
  '- 관측 체결 수는 API 상한 때문에 하한입니다. 5건 조건은 수집 완전성 보장이 아닙니다.',
  '- 일봉 없음은 무거래와 수집 실패를 구분하지 못합니다. 과거 가동률·최초 수집 시각을 추정해서 채우지 않습니다.',
  '- 삭제 대상의 11-05 이후 일봉은 계산에서 제외합니다. 남은 기록은 삭제 후 가격으로 해석하지 않고 점검 대상으로 기록합니다. 체결 기준 3·10건 및 증폭권 제외 결과는 JSON에 함께 제공합니다.',
  '- 판매 종료는 미리 알려진 사건입니다. 신규 패키지·점검·기타 이벤트가 겹치면 효과를 분리할 수 없습니다.',
  '- 이번 구현은 관측 비교 연구입니다. 유의성 판정, 매수 추천, 무차익 입증을 제공하지 않습니다.', '',
  '## 재현', '',
  `입력 SHA-256: ${report.provenance.inputSha256}`, '',
  '기존 9/19 초안과 9/28 보완 규칙은 저장소 docs에 함께 보존됩니다. 매시간 통합 빌드가 완료된 뒤 같은 계산을 갱신합니다.', '',
];
mkdirSync(`${out}/data`, { recursive: true });
writeFileSync(`${out}/data/package-study.json`, JSON.stringify(report));
writeFileSync(`${out}/data/package-study-input.json`, JSON.stringify(input));
writeFileSync(`${out}/data/package-study.md`, lines.join('\n'));
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
// 위에서 생성한 제한된 Markdown의 제목·표만 렌더링한다. 외부 HTML은 받지 않는다.
let table = false;
const html: string[] = [];
for (const line of lines) {
  if (line.startsWith('|')) {
    if (/^\|[-|: ]+\|$/.test(line)) continue;
    const tag = table ? 'td' : 'th';
    if (!table) { html.push('<div class="table-scroll"><table>'); table = true; }
    html.push(`<tr>${line.slice(1, -1).split('|').map(c => `<${tag}>${escape(c.trim())}</${tag}>`).join('')}</tr>`);
  } else {
    if (table) { html.push('</table></div>'); table = false; }
    if (!line) continue;
    const level = line.startsWith('## ') ? 2 : line.startsWith('# ') ? 1 : 0;
    html.push(level ? `<h${level}>${escape(line.slice(level + 1))}</h${level}>` : `<p>${escape(line)}</p>`);
  }
}
if (table) html.push('</table></div>');
// 공용 헤더와 토큰을 쓴다. 메뉴 구성은 web/*.html과 같아야 하며 scripts/test-site-nav.ts가 대조한다.
const nav = [['index.html', '시세'], ['index.html#compare', '비교'], ['ranking.html', 'TOP100'], ['analysis.html', '분석'], ['research.html', '실험'], ['ledger.html', '연구 원장'], ['guide.html', '지표']]
  .map(([href, text]) => `<a href="${href}">${text}</a>`).join('') + '<a href="https://github.com/kimtaehoon1107-gif/dnf-price-tracker" target="_blank" rel="noopener">GitHub</a>';
const links = [['research.html', '실험으로 돌아가기'], ['ledger.html#pkg-end', '연구 원장'], ['data/package-study.md', '보고서 원문'], ['data/package-study.json', '계산 결과 JSON'],
  ['https://github.com/kimtaehoon1107-gif/dnf-price-tracker/blob/main/docs/package-end-preregistration.md', '분석 규칙'],
  ['https://df.nexon.com/community/news/seriashop/656', '공식 상품 공지']].map(([href, text]) => `<a href="${href}">${text}</a>`).join('');
writeFileSync(`${out}/package-study.html`, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>삭제 전 연구 · 자료 점검 — 던파 경매장</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard-dynamic-subset.min.css"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="research.css"><link rel="stylesheet" href="ledger.css">
<style>.package-study-page h1{margin:4px 0 14px;font-size:24px;letter-spacing:-.03em}.package-study-page h2{margin:30px 0 10px;font-size:18px;letter-spacing:-.03em}.package-study-page p{max-width:var(--measure);overflow-wrap:anywhere}.package-study-page .table-scroll{margin:12px 0}.package-study-page td,.package-study-page th{white-space:nowrap}</style></head>
<body class="research-page package-study-page"><header class="top"><div class="inner"><a class="brand" href="index.html">던파 경매장</a><nav>${nav}</nav><details class="mobile-menu"><summary>메뉴</summary><nav aria-label="모바일 주 메뉴">${nav}</nav></details><span class="spacer"></span></div></header>
<div class="wrap"><p class="research-links">${links}</p><main class="panel">${html.join('\n')}</main><footer>네오플 오픈 API를 이용한 비공식 개인 프로젝트입니다. 네오플·넥슨이 운영하거나 보증하지 않습니다.</footer></div></body></html>`);
console.log(JSON.stringify({ version: report.version, through: report.through, coverage: report.groupCoverage, diagnostics: report.diagnostics, out }));
