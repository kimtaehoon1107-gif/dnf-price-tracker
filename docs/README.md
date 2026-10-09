# 문서 목록

저장소 루트의 [README](../README.md)가 개요이고, 여기는 상세 문서의 색인입니다. 연구 문서는 결과를 보기 전에 규칙을 적은 **프로토콜**과 실행 뒤의 **결과**를 나눠 보존합니다.

## 읽는 문서

| 문서 | 내용 |
|---|---|
| [추적 품목](tracked-items.md) | 분류별 품목, 대표 가격(VWAP) 정의, 종결 성능 D+ |
| [분석·예측 기록](analysis-notes.md) | 표시 가격 정제, 분산비 검정·예측 평가 수치, 사전 예측 방식 |
| [일반 아이템 가격 분포 화면](price-distribution.md) · [아이템 비교](item-comparison.md) | 화면별 계산 기준 |
| [시세 이야기(채팅)](market-chat.md) · [피드백 게시판](feedback-board.md) | 방문자 기능의 설치·운영 |

## 운영

| 문서 | 내용 |
|---|---|
| [Supabase 두 프로젝트 재구성](two-project-migration.md) | B·C 분리와 전환 기록 |
| [R2 최초 시세 보관본](archive.md) · [원본 보존과 저장 사용량](archive-retention.md) | 보관·복원 검증·정리 정책 |
| [2026-09-25 사이트 갱신 복구](hourly-build-cache.md) | 빌드 캐시 |
| [개별 아이템 평균 거래가 사전 발행 평가](daily-vwap-forward-evaluation.md) | 발행·실측·평가 원장 |

## 연구 (프로토콜 → 결과)

| 주제 | 문서 |
|---|---|
| 레전더리·종류별 사전 예측, 패키지 관측 | [방법](market-research.md) |
| 일봉 예측 비교 | [2026-09-16](forecast-comparison-2026-09-16.md) |
| 시간대·요일, 거래 활동 | [시간대·요일 탐색](intraday-weekday-study-2026-10-01.md) · [거래 활동·매물 예측 가치](activity-study-2026-10-01.md) |
| 오전→저녁, 06→06 경로 예측 | [공동 평가 규칙](intraday-joint-protocol-2026-10-01.md) → [결과](intraday-joint-results-2026-10-01.md) · [규칙](full-day-protocol-2026-10-01.md) → [결과](full-day-results-2026-10-01.md) |
| ARIMA 진단·선택, 표시 가격 정제 | [진단·선택 규칙](arima-diagnostics-protocol-2026-10-06.md) · [정제와 21일 모델 비교](display-cleaning-and-arima-2026-10-08.md) |
| 유랑악단 패키지 판매 종료 | [사전 등록(원본)](package-end-preregistration-original.md) · [보완 규칙](package-end-preregistration.md) · [자료 점검](package-study-audit-20260928.md) |

## 기록으로만 남긴 문서

- [유랑악단 패키지·주또주 계산 기준](package-calculator.md) — 해당 계산기 화면은 제거됐습니다.
- [파이프라인 리뷰 2026-09-09](PIPELINE_REVIEW_2026-09-09.md)

## 증거 파일

`evidence/`는 연구 문서가 인용하는 입력·결과 JSON과 그림입니다(약 8MB). 일부 테스트가 직접 읽으므로 경로를 옮기지 않습니다. 새 증거 파일이 커지면 저장소 대신 R2 보관본으로 두고 문서에는 해시만 남기는 편이 낫습니다.
