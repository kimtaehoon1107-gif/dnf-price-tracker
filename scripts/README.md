# scripts

실행 진입점과 연구·테스트 스크립트가 한 폴더에 있습니다. 워크플로·`package.json`·테스트가 경로를 직접 참조하므로 폴더를 나누지 않고 이름의 규칙으로 구분합니다.

| 묶음 | 파일 | 비고 |
|---|---|---|
| 테스트 | `test.ts`(진입점, `npm test`), `test-*.ts`·`test-*.py` | DB가 필요한 것은 `npm run test:*`로 따로 실행합니다 |
| 운영·점검 | `db-check` `init-db` `stats` `health` `probe` `scan` `scan-turnover` `discover` `track` `sync-events` `repair-pipeline` `legendary-floor` | `npm run <이름>`으로 실행(`package.json` 참고) |
| 사이트 빌드 보조 | `build-history-site` `build-inline-forecast.py` `package-study` | `.github/workflows/pages.yml`이 호출 |
| 예측 발행·평가 | `record-forecasts` `record-daily-vwap` `predict-daily-vwap.py` | 사이트 빌드 뒤 또는 `daily-vwap-forecast.yml` |
| 보관 | `archive-baseline` `archive-research` `prune-archive` | R2 보관·복원 검증·원본 정리 |
| 연구·실험 | `activity-study` `experiment-*` `full-day-forecast` `intraday-*` `forecast-model-study.py` `arima-diagnostics-study.py` `render-intraday-study` `plot-*.py` `download-package-study` `check-package-study-collection` | 결과는 [docs](../docs/README.md)에 정리 |
| 구성 도구 | `setup-feedback-admin` `setup-project-connection` `preview-chat` `preview-feedback` | 격리 스키마에서 실행하고 종료 시 롤백 |
| 일회성(완료) | `migrate-sqlite` `plan-db-split` `prepare-cutover-state` `prepare-project-b*` `prepare-project-c` | 2026-09 DB 이전 작업. 다시 실행할 필요가 없습니다 |
