import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { dates, type Member } from '../src/package-study.ts';
import { PACKAGE_PRICE_BASIS } from '../src/package-study-input.ts';

const members: Member[] = JSON.parse(readFileSync('config/package-study-members.json', 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'dnf-package-input-'));
const out = join(root, 'out');
const asOf = '2026-11-05T01:00:00Z';
const input = { priceBasis: PACKAGE_PRICE_BASIS, asOf, members,
  series: Object.fromEntries(members.map(m => [m.id, dates(['2026-09-10', '2026-11-04'])
    .map(d => ({ d, n: 5, vwap: m.group === 'treatment' && d >= '2026-10-22' ? 120 : 100 }))])) };
const args = ['--no-warnings', 'scripts/package-study.ts', root, out];
const write = (name: string, value: any) => writeFileSync(join(root, name), JSON.stringify(value));
try {
  write('summary.json', { builtAt: asOf, priceAsOf: asOf,
    items: members.map(m => ({ item_id: m.id, item_name: m.name, price_basis: 'trade' })) });
  mkdirSync(join(root, 'series'));
  for (const m of members) write(`series/${m.id}.json`, { priceBasis: 'trade',
    daily: input.series[m.id].map(r => ({ ...r, n: 4, vwap: 999999 })) });
  write('package-study-source.json', input);
  execFileSync(process.execPath, args, { stdio: 'pipe' });
  const report = JSON.parse(readFileSync(join(out, 'data/package-study.json'), 'utf8'));
  assert.equal(report.provenance.priceBasis, PACKAGE_PRICE_BASIS);
  assert.equal(report.results.h2.status, 'ready');
  assert(Math.abs(report.results.h2.relativePercent - 20) < 1e-9, '화면용 가격·건수가 연구에 섞이지 않음');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'data/package-study-input.json'), 'utf8')), input);
  for (const bad of [{ ...input, priceBasis: 'daily-median-10x-v1' },
    { ...input, asOf: '2026-11-04T01:00:00Z' }, { ...input, members: members.slice(1) }]) {
    write('package-study-source.json', bad);
    assert.notEqual(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
  }
  rmSync(join(root, 'package-study-source.json'));
  assert.notEqual(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0,
    '원본 연구 입력이 없으면 화면 일봉으로 대체하지 않고 중단');
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('패키지 연구 입력: 원본/화면 분리·해시 입력 보존·기준 시각·구성·누락 차단 통과');
