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

최초 보관본은 Actions에서 명시적으로 수동 실행한다. 코드 push와 예약으로 실행하지 않는다.
Linux와 Docker가 있는 환경에서 같은 동작을 재현하려면:

```sh
node --env-file=.env --no-warnings scripts/archive-baseline.ts create archive-source
# R2에서 내려받은 market.dump와 manifest.json을 archive-downloaded에 배치한다.
# ARCHIVE_VERIFY_URL은 위 임시 DB를 가리켜야 하며 대상은 비어 있어야 한다.
node --no-warnings scripts/archive-baseline.ts verify archive-downloaded
```

## 정기 보관과 연구용 불러오기

`.github/workflows/archive-research.yml`은 main 반영 후 매일 11:37 KST와 수동 실행으로
시세 13개 테이블 및 `collection_quality`를 보관한다. GitHub 예약 실행은 지연/누락될 수 있다.
실패는 Actions의 기본 실패 알림 대상으로 남는다. 별도 감시 서비스는 추가하지 않는다.
기존 DB 정리 주기와 보관 기간은 변경하지 않는다.
코드 push로 운영 보관을 반복 실행하지 않는다. 수동 실행의 `verify_live`를 선택한 경우에만
추가 Supabase 조회가 발생하는 최신 DB 결합 검증을 실행한다. 일반 보관의 R2 재다운로드와
임시 DB 복원 검증은 그대로 유지한다.

`collection_quality`는 `collection_runs`의 아이템·출처·시각·성공/실패/진행 중 상태와
API 응답/신규 체결/포화/매물 건수를 보존한다. 오류 메시지 원문은 제외한다.
성공 실행의 `listing_rows=0`과 실패/미관측을 구분할 수 있지만, 실행 기록이 없는 시간을
정상으로 간주하면 안 된다. 과거 폴링 설정 변화의 정확한 이력과 이미 지워진 로그는 복원하지 못한다.
레전더리 카드별 정상 무매물/실패는 `legendary_card_scans.observations`를 사용한다.

### 저장 규칙

- 운영 DB는 반복 읽기·읽기 전용 트랜잭션으로 읽는다. 수집기에는 쓰지 않는다.
- 테이블/UTC 날짜별 gzip JSONL로 묶는다. 메타데이터 테이블은 `all`로 묶는다.
- 모든 보존 행의 날짜별 해시를 DB 안에서 대조하고, 바뀐 날짜의 원본만 내려받는다.
  새 ID만 읽는 방식이 아니므로 늦은 커밋/백필/과거 수정도 반영한다. 원본 전체를 매일 전송하지 않는다.
- 같은 기본키는 새 관측으로 갱신하고 운영 DB에서 사라진 행은 외부 보관본에 유지한다.
  변경 없는 파일은 재업로드하지 않는다. 변경된 날짜의 파일은 새 해시로 저장하므로 이전 버전도 남는다.
- 행은 PostgreSQL JSON 원문 문자열과 기본키 문자열로 보관하여 bigint/numeric/마이크로초를 보존한다.
- 새 객체를 내려받아 SHA-256·크기·건수를 검사하고, 전체 보관본을 임시 PostgreSQL에 실제 복원해
  모든 행을 다시 비교한다. 같은 시점의 기존 `loadResearch()` 입력도 재현한다.
- 검증 성공 후에만 `latest.json`을 갱신한다. 발행은 공통 Actions concurrency 그룹에서 직렬화한다.
  발행 CLI를 여러 장소에서 동시에 실행하지 않는다. 실패한 미참조 객체는 자동 삭제하지 않는다.
- 마지막 보관과 6일 넘게 벌어지면 `continuity=gap`으로 표시하고 현재 자료 보관 후 실행을 실패 처리한다.
  7일 후 지워지는 품질 기록을 놓쳤을 수 있으므로 그 구간을 완전한 이력이라고 부르면 안 된다.
  최초 보관 이전과 이미 삭제된 구간은 보장하지 않는다. 이전 `.dump` 보관본은 별도 형식으로 계속 남는다.
- 스키마가 바뀌면 자동으로 자료형을 추측하지 않고 발행을 중단한다. 형식 이전이 먼저 필요하다.

R2의 비공개 `research-v1/` 아래에 다음이 쌓인다.

```text
objects/<sha256>.jsonl.gz     변경된 날짜별 시세·품질 파일
manifests/<sha256>.json      모든 날짜의 파일 목록·스키마·코드 버전·관측 기준
verified/<sha256>.json       실제 복원과 연구 재현 성공 기록
latest.json                 마지막 검증 성공 manifest
```

초기 부트스트랩은 현재 DB의 모든 보존 행을 담는다. 원본의 보관 시작일은 테이블마다 다르다.
증분 업로드이지만 검증은 전체 보관본을 대상으로 하므로 장기적으로 다운로드·검증 시간이 증가한다.
시간 제한에 가까워지면 변경 파일 검증과 주기적인 전체 복원을 분리하는 후속 변경이 필요하다.

### 분석 실행

Node 24, npm 의존성, R2 접근 환경 변수와 **빈 로컬 PostgreSQL 17**이 필요하다.
아래 예시는 운영 DB에 복원할 수 없도록 고정된 분석 전용 주소를 사용한다.
매번 새 작업 폴더와 빈 DB를 사용한다. `archive-work`로 시작하는 출력 폴더는 gitignore된다.

```sh
docker run --rm -d --name archive-research -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=archive_verify -e POSTGRES_PASSWORD=temporary-verification-only \
  -e POSTGRES_DB=archive_verify postgres:17
export ARCHIVE_VERIFY_URL=postgresql://archive_verify:temporary-verification-only@127.0.0.1:55432/archive_verify

# R2 마지막 검증본에서 한국 시각 9/1 이상, 9/20 미만의 패키지 기록을 불러온다.
node --env-file=.env scripts/archive-research.ts load archive-work-package \
  --from 2026-09-01T00:00:00+09:00 --to 2026-09-20T00:00:00+09:00 \
  --items e974d2eac46f0c8b23b83d4da389fa57

# 별도의 빈 DB와 새 폴더에서 실행. 최근 Supabase까지 합치려면 --live를 붙인다.
node --env-file=.env scripts/archive-research.ts load archive-work-latest --live
```

`--items`는 쉼표로 여러 ID를 받는다. 패키지 구성품 비교에는 패키지와 구성품 ID를 모두 넣는다.
전체 시장 지표, 레전더리 스캔, 이벤트, 발행된 모델 결과는 의미 보존을 위해 함께 남긴다.
기간은 시작 포함/끝 제외다. 매물은 첫 관측부터 종료/만료까지 요청 기간과 겹치는 것을 포함한다.
일별 연구 결과를 사용할 때는 KST 자정으로 기간을 지정한다. 임의 시각으로 자르면 첫날은 부분 집계다.

분석 DB에는 SQL로 직접 조회할 수 있는 원본 테이블이 생긴다. 출력은 다음과 같다.

- `research.json`: 기존 연구 로더가 계산한 일별 가격/품목군/레전더리 입력.
- `dataset.json`: 원본 manifest, 최근 DB 기준 시각, 기간/아이템, 행 수, 결과 해시.
- `manifest.json`: 실제 사용한 자료 목록. `--live`에서 새로 병합한 파일은 작업 폴더에도 보존된다.

재현하려면 해당 manifest의 코드 revision으로 체크아웃하고 `--manifest manifests/<hash>.json`을
지정한다. 고정 manifest와 `--live`는 동시에 사용하지 않는다. `--live` 출력 폴더는 원본 파일까지
함께 보관해야 한다. 일별 보관은 수정 이력을 일별로만 고정하므로, 이 데이터는 과거 사실의
최신 재구성이다. **각 예측 발행 당시 알고 있던 정보의 완전한 재현은 아니다.** 미래 정보 누출을
막는 연구에서는 기존 발행 입력과 공지 당시 기록을 별도로 사용한다.

## 다음 단계: DB 정리

이번 변경은 DB 용량을 줄이지 않는다. 보관 검증과 연동한 보존 정책, 호가 장기 집계,
기존 화면 대조를 완료한 후 정리 범위를 정해야 한다. 연구에 쓰는 테이블을 운영 DB에서 정리하면
연구 재현 대조도 공통 보존 구간으로 조정해야 한다. 현재 검증 실패 상태에서 정리를 강행하지 않는다.
