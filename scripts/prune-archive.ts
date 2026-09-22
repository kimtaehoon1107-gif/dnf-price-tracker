// 검증된 소스별 R2 보관본과 내용이 같은 14일 초과 원본만 정리한다.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {liveClient} from '../src/live-projects.ts';
import {r2Store,projectArchiveStore} from '../src/archive.ts';
import {pruneArchived} from '../src/archive-retention.ts';
const args=process.argv.slice(2);assert(args.length===1&&args[0]==='--apply');
const project=process.env.ARCHIVE_PROJECT!;
const config=JSON.parse(readFileSync('config/history-sources.json','utf8'));
assert(config.live.some((s:any)=>s.project===project),'현재 운영 프로젝트만 정리합니다');
assert.equal(new URL(process.env.DATABASE_URL!).username,`postgres.${project}`);
const published=JSON.parse(readFileSync('archive-work/report.json','utf8'));
const client=liveClient(process.env.DATABASE_URL!),store=projectArchiveStore(r2Store(),project);
try {
  await client.connect();
  const report={...await pruneArchived(client,store,project,published.manifest,true),finishedAt:new Date().toISOString()};
  const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
  writeFileSync('archive-work/retention.json',bytes);
  await store.put(`retention/${report.finishedAt.replaceAll(':','-')}.json`,bytes);
  console.log(bytes.toString());
} finally {await client.end();}
