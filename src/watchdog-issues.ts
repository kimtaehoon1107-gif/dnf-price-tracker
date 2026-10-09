// 수집 감시견(sql/watchdog.sql)이 만드는 이슈는 "복구되면 수동으로 닫아 주세요"라서 한 번도 닫히지 않고 쌓였다
// (2026-10-08에 10개). 수집이 복구됐다고 볼 수 있을 때만 닫는다.
// 이슈에 붙이려던 `watchdog` 라벨은 실제로는 붙지 않았으므로 제목 접두사로 판별한다.
export const TITLE_PREFIX = '[감시견]';
// 알림 직후에는 닫지 않는다. 감시견은 복구를 두 번 시도한 뒤에야 이슈를 만들므로 곧바로 닫으면 재발을 놓친다.
export const MIN_AGE_MS = 2 * 3600000;
// 이 안에 끝난 성공 실행이 있어야 "지금 수집이 돌고 있다"고 본다. 수집 실행은 55분 루프라 성공 완료 간격이
// 실측 약 56분까지 벌어지므로 두 배(약 2시간)를 창으로 잡는다.
export const RECENT_SUCCESS_MS = 120 * 60000;

export type Issue = { number: number; title: string; created_at: string; state: string; pull_request?: unknown };
export type Run = { status: string; conclusion: string | null; updated_at: string };
export type Decision = { close: boolean; reason: string };

export function decide(issue: Issue, runs: Run[], now: number): Decision {
  if (issue.pull_request) return { close: false, reason: '이슈가 아님' };
  if (issue.state !== 'open') return { close: false, reason: '이미 닫힘' };
  if (!issue.title.startsWith(TITLE_PREFIX)) return { close: false, reason: '감시견 이슈가 아님' };
  const created = Date.parse(issue.created_at);
  if (now - created < MIN_AGE_MS) return { close: false, reason: '알림 직후라 대기' };
  // 동시성 정책으로 취소된 실행은 성공도 실패도 아니므로 판단에서 뺀다.
  const finished = runs
    .filter((r) => r.status === 'completed' && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped')
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const latest = finished[0];
  if (!latest) return { close: false, reason: '완료된 수집 실행 없음' };
  if (latest.conclusion !== 'success') return { close: false, reason: `마지막 완료 실행이 ${latest.conclusion}` };
  const at = Date.parse(latest.updated_at);
  if (now - at > RECENT_SUCCESS_MS) return { close: false, reason: '성공 실행이 2시간보다 오래됨' };
  if (at <= created) return { close: false, reason: '알림 이후의 성공 실행 없음' };
  return { close: true, reason: `알림 이후 수집 성공(${latest.updated_at})` };
}
