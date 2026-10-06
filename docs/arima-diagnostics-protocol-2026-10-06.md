# 품목별 ARIMA 진단·선택 규칙

기존 forecast-20261006/input.json을 재사용하고 이전 미래 예측은 덮어쓰지 않는다. 운영 조회·변경 없음.

- 원가격·1차 차분의 ADF(상수, AIC 자동 시차)와 KPSS(수준 정상성, 자동 시차)를 함께 기록한다. p값은 진단이며 정상성의 증명이 아니다. KPSS 경계 p값은 경고도 보존한다.
- 매 과거 기준일의 학습 자료만으로 KPSS p<0.05이면 d=1, 아니면 d=0. 1차 차분 후에도 KPSS가 기각되면 d를 더 늘리지 않고 마지막 가격으로 대체한다. ADF/KPSS 판단 불일치는 별도 표시한다. 이는 작은 표본을 위한 제한된 후보 실험이다.
- 선택한 d 안에서 p,q=0..2 및 p+q<=3을 탐색. d=0은 상수, d=1은 드리프트 없음/있음을 후보에 넣는다. p=7,q=0은 학습 일봉 40개 이상일 때만 보조 후보로 포함한다. 40개는 안정성 보장이 아니라 최소 운영 제한이다.
- 수렴·유한 AICc·양수 유한 예측 조건을 통과한 후보 중 학습 AICc 최소를 선택. 서로 다른 d의 AICc는 비교하지 않는다. 후보 실패 사유를 기록하고 전부 실패하면 마지막 가격 유지로 대체한다.
- 목표·평가 사례는 앞선 실험과 동일. 현재 진단으로 과거 d를 일괄 선택하지 않는다. 미래 실제값은 후보 선택에 사용하지 않는다. MAPE 및 종목 동일 비중 결과, 날짜 수와 품목별 결과 공개.
- 최신 학습 구간의 원가격/차분/ACF/PACF 그림을 저장한다. ACF/PACF 신뢰띠는 근사치이며 다중 시차 검사 보정이 없다. 그림은 후보 해석용이지 시각적 패턴을 보고 평가 성적에 맞춰 후보를 추가하기 위한 것이 아니다.
- 평가 구간은 앞선 실험에서 이미 본 구간이다. 새로운 미관측 검증이 아니며 사이트 적용은 하지 않는다. 최신 후보 예측은 별도 시각·입력 해시와 함께 저장한다.

근거: https://otexts.com/fpp3/arima-estimation.html / https://otexts.com/fpp3/stationarity.html

재현: Python 환경에 `pip install -r scripts/arima-diagnostics-requirements.txt` 후 저장소 루트에서 `python scripts/arima-diagnostics-study.py`. 테스트: `python scripts/test-arima-diagnostics-study.py`. 그림의 한국어 글꼴은 Windows 맑은 고딕을 사용한다.
