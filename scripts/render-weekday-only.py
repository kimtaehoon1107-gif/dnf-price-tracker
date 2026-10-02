import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

j=json.loads(Path('docs/evidence/weekday-only-20261002.json').read_text(encoding='utf-8'))
targets=[next(r for r in j['results'] if r['category']=='P10'),next(r for r in j['results'] if r['name']=='레전더리 소울 결정'),next(r for r in j['results'] if r['name']=='에픽 소울 결정')]
fig,axes=plt.subplots(1,3,figsize=(13,4.5),layout='constrained')
for ax,r,title in zip(axes,targets,['Legendary cards P10','Legendary Soul Crystal','Epic Soul Crystal']):
    for w in r['weekly']: ax.plot(range(7),w['indices'],marker='.',alpha=.55,label=w['week'])
    ax.plot(range(7),[p['index'] for p in r['profile']],color='black',linewidth=2,label='Mean of complete weeks')
    ax.axhline(100,color='gray',linestyle=':',linewidth=1)
    ax.set_xticks(range(7),['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])
    ax.set_title(f"{title}\n{len(r['fullWeeks'])} complete weeks")
    ax.set_ylabel('Each week mean = 100')
    ax.grid(alpha=.15)
    ax.legend(fontsize=7)
fig.suptitle('Weekday price levels | Game day 06:00 → next 06:00')
fig.supxlabel('Descriptive only • Hourly arithmetic means • ≥18 observed hours/day • Within-week drift remains',fontsize=9)
fig.savefig('docs/evidence/weekday-only-20261002.png',dpi=180)

fmt=lambda v:'—' if v is None else f'{v:.2f}'
lines=['# 시간대 없이 요일만 본 가격 추세','',
'요일×시간대 예측과 별도로, 06시~다음 날 06시를 하루로 집계했다. **카드 P10의 목요일 하락, 레전더리·에픽 소울 결정의 토요일 상승이 반복 관측 후보**다. 예측 성능이나 통계적 유의성을 검증한 결과는 아니다.','',
'## 계산 기준','',
'- 자료 기준은 2026-10-01 18:00 KST, 검증된 보관본의 시간별 입력이다. 10월 2일 신규 자료는 포함하지 않았다.',
'- 시간별 가격의 산술평균으로 하루 가격을 계산한다. 일반 품목의 시간별 값은 체결 VWAP이지만, 시간 간 수량 가중을 하지 않으므로 하루 전체 거래 VWAP과 다르다. 카드의 값은 업그레이드 단계별 최저호가, P10은 저가 지표다.',
'- 하루가 완전히 끝나고 24시간 중 18시간 이상 관측된 경우만 사용한다. 결측은 보간하지 않는다. 기존 하루 안 4구간 분석처럼 오전 최소 4시간을 별도로 요구하지 않아서 일부 목요일이 다시 포함된다.',
'- 가격 수준: 월~일 7일이 모두 유효한 주만 사용하고 해당 주 평균을 100으로 맞춘다. 주별 기준 가격 차이는 줄이지만 **주중에 계속 하락/상승하는 추세는 제거하지 않는다.** 요일의 인과효과가 아니다.',
'- 전날 대비 변화: 정확히 직전 날짜가 유효할 때만 계산한다. 완전한 주에 속하지 않은 날짜 쌍도 포함하므로 수준 프로파일과 표본이 다를 수 있다.',
'- 같은 시각의 관측이 다른 구성을 갖는 문제를 확인하기 위해 두 날 공통 관측 시간이 18개 이상인 쌍도 별도로 계산한다. 단순 하루평균과 공통시간 비교를 혼동하지 않는다.',
'- 그룹은 매주 구성 아이템을 바꾸지 않고 동일 구성·공통 완전 주에서만 동일 비중 평균한다.','',
'![주별 실제 곡선과 요일 평균](evidence/weekday-only-20261002.png)','',
'## 주요 관측','',
'| 비교 | 09-10/12 | 09-17/19 | 09-24/26 |',
'|---|---:|---:|---:|',
'| 카드 P10: 목요일/수요일 | −1.94% | −6.07% | −5.40% |',
'| 레전더리 소울: 토요일/금요일 | +12.14% | +9.97% | +4.03% |',
'| 에픽 소울: 토요일/금요일 | +23.29% | +20.30% | +19.44% |','',
'카드 P10 목요일 3회 모두 하루 관측시간 평균은 하락했다. 하지만 앞의 두 목요일은 전날과 공통 관측 시간이 17개여서 18시간 공통 기준에서는 제외된다. 마지막 09-24만 20시간 공통 비교가 가능하며 −5.63%였다. **결측 민감도를 통과한 목요일 3회 반복이라고 표현할 수 없다.** 소울 두 종의 토요일 비교는 모두 양일 24시간 관측이 있어 동일시간 비교에서도 위 변화율이 유지된다.','',
'카드 P10의 완전 주는 09-14·09-21 시작 두 주다. 평균 지수는 화 105.94, 수 105.41, 목 99.37, 금 98.06, 토 95.09, 일 94.35였다. 이 기간 전체 하락 추세가 주후반 저가 모양을 만들 수 있어 “일요일이 원래 싸다”로 확정하지 않는다.','',
'소울 결정 6종 공통 두 주의 평균에서는 토요일이 높았지만, 주별 토요일 지수는 96.15와 131.92로 달랐다. 그룹 평균의 토요일 급등을 매주 모든 결정에 공통인 패턴으로 해석하면 안 된다. 레전더리·에픽의 개별 반복과 구분한다.','',
'유랑악단 6종 공통 완전 주는 0개다. 칭호의 관측 부족 때문에 전체 그룹 요일 곡선을 만들지 않았고 개별 품목별 결과만 남겼다. 카드 68단계 시계열 중 완전 주 2개 이상은 47개다.','',
'## 전체 품목의 요일 가격 수준','',
'각 주 평균=100. 1주짜리는 반복 비교가 불가능하다. 아래 표의 최저·최고 요일을 새로운 기간에서 검증된 매수·매도 시점으로 사용하지 않는다.','',
'| 품목·기준 | 완전 주 | 월 | 화 | 수 | 목 | 금 | 토 | 일 |',
'|---|---:|---:|---:|---:|---:|---:|---:|---:|']
for r in j['results']:
    lines.append(f"| {r['name']} · {r['basis']} | {len(r['fullWeeks'])} | "+' | '.join(fmt(p['index']) for p in r['profile'])+' |')
lines+=['','## 해석과 다음 단계','',
'시간대를 나누지 않아도 요일별 가격 흐름을 관측할 수 있다. 이번에는 레전더리·에픽 소울의 토요일 상승이 3회 반복됐다는 점이 후속 후보이고, 카드 P10 목요일 하락은 결측 통제를 보강해야 하는 후보다. 출시·이벤트·전체 시장 추세와 분리한 효과 또는 미래 예측력이 확정된 것은 아니다.','',
'추후에는 이 후보와 계산 기준을 고정하고 새 주의 하루 평균 가격 방향을 사전에 발행해 검증해야 한다. 3회 모두 같은 방향이었다고 다음 주 확률을 100%로 표시하지 않는다.','',
'## 재현','',
'`python scripts/test-weekday-only.py`, `python scripts/weekday-only-study.py`, `python scripts/render-weekday-only.py`. 입력은 `data/activity-research-verified/hourly.json`·`report.json`과 품목 메타데이터 `data/intraday-study/activity-input.json`이다. 06시 경계·미완료일·결측·완전 주·정확히 하루 전 비교를 합성 자료로 검증했다.','',
'[전체 날짜·요일 프로파일·주별 값·전날 변화·공통시간 변화 JSON](evidence/weekday-only-20261002.json)에 입력 해시도 보존했다. 운영 수집과 사이트는 변경하지 않았다.']
Path('docs/weekday-only-results-2026-10-02.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
