import { readFileSync, writeFileSync } from 'node:fs';
import { updateRows, updateHeadings } from '../src/update-calendar.ts';
const path = 'web/update-calendar.json';
let previous = { checkedAt: null as string | null, entries: [] as any[] };
try { previous = JSON.parse(readFileSync(path, 'utf8')); } catch {}
async function get(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'dnf-price-tracker official update calendar' } });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  return r.text();
}
try {
  const rows = updateRows(await get('https://df.nexon.com/community/news/update/list'));
  if (!rows.length) throw Error('공식 업데이트 목록 파싱 실패');
  const entries = new Map(previous.entries.map(e => [e.id, e]));
  for (const row of rows) {
    let headings = entries.get(row.id)?.headings ?? [];
    // 새 공지와 최근 두 공지의 수정 사항만 확인한다.
    if (!entries.has(row.id) || rows.indexOf(row) < 2) {
      try { headings = updateHeadings(await get(row.url)); }
      catch (e) { console.warn(`상세 확인 실패 ${row.id}`, String(e)); }
    }
    entries.set(row.id, { ...row, headings });
  }
  writeFileSync(path, JSON.stringify({ checkedAt: new Date().toISOString(), entries: [...entries.values()].sort((a,b) => b.date.localeCompare(a.date)) }, null, 2) + '\n');
  console.log(`공식 업데이트 캘린더 ${entries.size}건`);
} catch (e) {
  if (!previous.entries.length) throw e;
  console.warn('공식 업데이트 조회 실패: 마지막 확인 자료 유지', String(e));
}
