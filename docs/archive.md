# R2 최초 시세 보관본

`R2 최초 보관·복원 검증` Actions는 현재 보존 중인 시세 데이터의 첫 보관본을
비공개 `dnf-price-archive` 버킷에 저장한다. 정기 증분 보관이나 운영 DB 삭제는 하지 않는다.

## 보관 대상과 형식

`scripts/archive-baseline.ts`의 고정 목록에 있는 13개 테이블을 PostgreSQL 17
`pg_dump --format=custom`으로 압축한다. 아이템 목록, 원본 체결, 시간봉과 집계 경계,
매물·소진·호가 이력, 이벤트, 레전더리 카드 기록, 순위, 실험의 발행 예측·실측을 포함한다.
백업 당시 이미 삭제된 원본은 복구하지 못하며 기존 시간봉은 함께 보관한다.

인증 정보, 피드백, 운영 로그, pg_cron·Vault는 제외한다. 따라서 서버 전체를 재구축하는
재해복구 백업이 아니라 시세·분석 데이터 보관본이다. 선택된 테이블의 구조·인덱스·제약은
포함하되 소유권과 접근 권한은 이식하지 않는다. 운영 함수와 예약 작업은 저장소 SQL을 참고한다.

R2의 `baselines/<Actions 실행 ID>-<시도 번호>/` 아래에 저장한다.

- `market.dump`: 압축된 테이블 구조와 데이터
- `manifest.json`: 기준 시각, 코드 커밋, 파일 크기·SHA-256, 테이블별 행 수·전체 내용 해시
- `verified.json`: R2 다운로드·임시 DB 복원·전체 내용 대조가 모두 성공한 기록

`verified.json`이 없는 경로는 검증 완료된 보관본으로 취급하지 않는다.
실패한 실행의 파일을 자동으로 지우거나 기존 파일을 덮어쓰지 않는다.

## 검증

운영 DB에서 읽기 전용 반복 읽기 트랜잭션을 열고 스냅샷을 내보낸다. 원본 행의 해시 계산과
pg_dump는 같은 스냅샷을 사용한다. 동시 수집으로 데이터가 추가돼도 대조 기준은 변하지 않는다.
숫자나 시각을 JavaScript 값으로 변환하지 않고 PostgreSQL의 JSONB 텍스트를 정렬해 해시하므로
큰 정수·소수·마이크로초를 보존한다.

R2에 올린 파일을 다시 내려받고 manifest 원본, 파일 길이, SHA-256을 확인한다.
Actions 내부의 빈 PostgreSQL 17에 실제 복원한 뒤 13개 테이블의 행 수와 내용 해시를 대조한다.
같은 행 수에서 아이템 이름 하나를 바꿔도 불일치를 감지하는지 확인한 뒤 변경을 롤백한다.
복원 대상은 `127.0.0.1:55432/archive_verify`로 제한하며 운영 접속 정보는 복원 단계에 주지 않는다.

## 실행

GitHub Secrets에 `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`가 필요하다. R2 권한은 해당 버킷의
Object Read & Write만 사용한다. 키 값을 코드·실행 로그·공개 산출물에 넣지 않는다.

초기 검증 브랜치 `codex/r2-first-archive`의 관련 코드 push로 실행한다.
기본 브랜치에 반영한 뒤에는 Actions에서 수동 실행할 수 있다. 예약 실행은 없다.
Linux와 Docker가 있는 환경에서 같은 동작을 재현하려면:

```sh
node --env-file=.env --no-warnings scripts/archive-baseline.ts create archive-source
# R2에서 내려받은 market.dump와 manifest.json을 archive-downloaded에 배치한다.
# ARCHIVE_VERIFY_URL은 위 임시 DB를 가리켜야 하며 대상은 비어 있어야 한다.
node --no-warnings scripts/archive-baseline.ts verify archive-downloaded
```

## 다음 단계

이번 보관본만으로 DB 용량은 줄어들지 않는다. 후속 작업에서 날짜별 증분 보관, 실패 알림,
호가 장기 집계와 기존 화면 대조, 보관 검증 여부에 연동한 원본 보존 정책을 구현해야 한다.
현재 35일 체결 원본 정리 등 기존 예약 작업은 그대로이므로 이번 작업만으로 앞으로 쌓이는
모든 원본의 장기 보존이 보장되지는 않는다.
