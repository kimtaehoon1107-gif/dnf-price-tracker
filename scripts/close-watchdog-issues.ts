// 복구된 [감시견] 이슈를 닫는다. 판단 규칙은 src/watchdog-issues.ts. 의존성 없이 GitHub REST만 쓴다.
import { decide, type Issue, type Run } from '../src/watchdog-issues.ts';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const dryRun = process.env.DRY_RUN === 'true';
if (!repo || !token) throw new Error('GITHUB_REPOSITORY와 GH_TOKEN이 필요합니다.');

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dnf-price-tracker-watchdog-cleanup',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${response.status}`);
  return response.json();
}

const issues: Issue[] = await api('/issues?state=open&per_page=100');
const { workflow_runs: runs }: { workflow_runs: Run[] } = await api('/actions/workflows/collect.yml/runs?status=completed&per_page=30');
const now = Date.now();
const targets = issues.filter((i) => i.title.startsWith('[감시견]') && !i.pull_request);
console.log(`열린 감시견 이슈 ${targets.length}건 · 완료된 수집 실행 ${runs.length}건 확인${dryRun ? ' (dry run)' : ''}`);

let closed = 0;
for (const issue of targets) {
  const { close, reason } = decide(issue, runs, now);
  console.log(`#${issue.number} ${close ? '닫기' : '유지'} — ${reason}`);
  if (!close || dryRun) continue;
  await api(`/issues/${issue.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: `수집이 복구된 것으로 보여 자동으로 닫습니다. (${reason})\n\n수집 실행의 성공 여부만으로 판단하므로, 실제 지연이 남아 있으면 감시견이 6시간 쿨다운 뒤 새 이슈를 만듭니다.` }),
  });
  await api(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
  closed++;
}
console.log(`닫은 이슈 ${closed}건`);
