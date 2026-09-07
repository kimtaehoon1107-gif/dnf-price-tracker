// SQLite 연결. Supabase/Postgres로 옮길 때 갈아끼우는 유일한 파일.
//
// node:sqlite는 Node에 내장되어 있어 네이티브 컴파일이 필요 없다.
// 덕분에 이 프로젝트는 npm 의존성이 0개다.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path = process.env.DB_PATH ?? 'data/dnf.db';
mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);

// WAL: 상주 수집 루프가 쓰는 동안 stats 스크립트가 읽을 수 있게 한다.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

export const nowIso = () => new Date().toISOString();

/** 정렬된 숫자 배열에서 분위수. 보간 없이 가장 가까운 값을 쓴다(골드는 정수). */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}
