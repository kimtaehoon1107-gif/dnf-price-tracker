import json
from pathlib import Path

j=json.loads(Path('docs/evidence/direction-widths-20261002.json').read_text(encoding='utf-8'))
def metric(c, model, field='accuracy'):
    return next(m[field] for m in c['test']['models'] if m['model']==model)
def pct(v):
    return '—' if v is None else f'{v*100:.1f}%'
lines=['# 品目別3・6・12時間比較'.replace('品目別3・6・12時間比較','품목별 3·6·12시간 방향 예측 비교'),'',
'소울 결정 일부에서 시간대 방향의 개선 후보가 나타났다. 유랑악단에서는 뚜렷한 개선이 없었고, 카드는 종목·업그레이드 단계별로 결과가 갈렸다. 아래 결과는 탐색이며 독립적인 미래 성능 검증이 아니다.','',
'## 고정한 비교 방법','',
'- 입력: 검증된 보관본 2026-10-01 18:00 KST. 소울 결정 6종·유랑악단 6종·카드 34종의 미업글/풀업 68시계열·P10 참고지수.',
'- 06시 시작, 3시간은 06/09/12/15/18/21/00/03시, 6시간은 06/12/18/00시, 12시간은 06/18시에 발행한다. 직전 구간 평균 대비 다음 구간 평균을 예측한다.',
'- 모든 구간에 동일한 ±0.5% 보합 기준을 적용한다. 구간별 최소 2/4/8시간 관측, 보간 없음. 긴 구간과 짧은 구간은 정답 자체가 다르므로 적중률만으로 구간의 우열을 단정하지 않는다.',
'- 학습: 최대 과거 28일, 최소 7일 분량의 구간 변화(56/28/14개), 시간대별 4개 이상, 학습 구간 7일 이상. 이전 6시간 실험과 같은 빈도 보정 4를 사용한다.',
'- 선택: 09-25 06시 전에 정답이 완료된 롤링 예측으로만 구간을 선택한다. 선택 표본은 최소 5게임일·5일 분량의 구간·세 클래스 모두 관측되어야 한다. 시간대 모델의 균형 정확도에서 과거 전체 최빈 방향의 균형 정확도를 뺀 값이 가장 큰 구간을 선택한다. 동률은 6→3→12시간 순이다. 개선값이 음수여도 비교 대상으로 남기며 채택으로 해석하지 않는다.',
'- 평가: 09-25 06시~10-01 06시의 6게임일. 구간 선택은 고정하고 예측 발행마다 완료된 과거 자료로 모델은 갱신한다. 평가 중 앞선 결과를 다음 학습에 사용하는 순차 평가다.',
'- 앞선 연구에서 이미 관찰한 기간을 다시 분리했다. 시간 순서는 지켰지만 완전히 새로운 홀드아웃이나 사전 발행 검증은 아니다.',
'- 카드: 동일 카드의 미업글·풀업 최저호가를 분리했다. 마지막 관측이 무매물이면 이전 호가로 채우지 않는 기존 시간별 입력을 사용한다. 카드 호가와 일반 품목 체결 VWAP을 같은 가격 개념으로 해석하지 않는다.',
'- 카드 수십 개를 비교했으므로 우연히 좋은 종목을 고를 위험이 있다. p값이나 확정적인 유의성을 주장하지 않는다.','',
'## 품목별 결과','',
'기준은 과거 전체 최빈 방향이다. 항상 보합 및 직전 방향 유지도 함께 보아야 한다. 5게임일 미만은 평가 부족으로 표시한다.','',
'| 대상 | 선택 구간 | 평가 구간/게임일 | 시간대 적중률 | 최빈 기준 | 항상 보합 | 직전 방향 | 시간대 균형 정확도 |',
'|---|---:|---:|---:|---:|---:|---:|---:|']
for r in j['results']:
    c=next((c for c in r['candidates'] if c['width']==r['selectedWidth']),None)
    if c is None:
        lines.append(f"| {r['name']} | 선택 표본 부족 | — | — | — | — | — | — |")
    else:
        note=' (평가 부족)' if c['test']['days']<5 else ''
        lines.append(f"| {r['name']} | {c['width']}h | {c['test']['n']}/{c['test']['days']}{note} | {pct(metric(c,'slot'))} | {pct(metric(c,'majority'))} | {pct(metric(c,'flat'))} | {pct(metric(c,'momentum'))} | {pct(metric(c,'slot','balancedAccuracy'))} |")
cards=[r for r in j['results'] if r['category']=='카드']
eligible=[]
for r in cards:
    c=next((c for c in r['candidates'] if c['width']==r['selectedWidth']),None)
    if c and c['test']['days']>=5: eligible.append((r,c))
wins=sum(metric(c,'slot')>metric(c,'majority') for r,c in eligible)
ties=sum(metric(c,'slot')==metric(c,'majority') for r,c in eligible)
lines+=['','## 해석','',f'- 카드 68시계열 중 {sum(r["selectedWidth"] is not None for r in cards)}개는 선택 조건을 충족했다. 선택 후 평가가 5게임일 이상인 {len(eligible)}개 중 최빈 기준보다 적중률이 높은 것은 {wins}개, 같은 것은 {ties}개다. 같은 카드의 두 단계는 독립 표본이 아니다.',
'- 소울 결정은 레전더리 12시간 75.0% 대 최빈 기준 50.0%, 에픽 6시간 66.7% 대 41.7%가 후보였다. 그러나 레전더리는 평가 12구간뿐이다. 레어는 시간대 50.0%가 기준 58.3%보다 낮았다. 소울 결정 전체에 동일한 패턴이 있다고 할 수 없다.',
'- 유랑악단은 선택 가능한 5종 중 시간대 적중률이 최빈 기준을 넘은 종목이 없었다. 칭호 상자는 선택 조건을 충족하지 못했다.',
'- 기억과 안개의 신, 무 미업글 카드의 3시간 결과는 72.9% 대 최빈 기준 47.9%로 후속 후보다. 풀업은 6시간에서 양쪽 모두 47.6%였다. 한 카드의 단계 간 결과도 다르다.',
'- 3/6/12시간을 고른 것은 보편적인 최적 주기를 찾았다는 뜻이 아니다. 각 구간은 예측 대상과 표본 수가 다르고, 다수 후보 중 고른 결과이므로 새 기간에서 고정 규칙을 검증해야 한다.',
'- 이 연구는 언제 가격이 오르는지의 확정 법칙이나 매매 수익을 검증한 것이 아니다. 일반 품목은 체결·매물이 함께 관측된 시간에 조건부이며, 결측 많은 시간·요일이 적게 반영된다.','',
'## 재현','',
'`node scripts/compare-direction-widths.ts` 후 `python scripts/render-direction-widths.py`를 실행한다. 입력은 `data/intraday-study/activity-input.json`과 `data/activity-research-verified/hourly.json` 및 동일 폴더의 `report.json`이다. 기준 시각 불일치 시 중단한다.','',
'[전체 후보 구간·선택 이전 성과·평가 성과·발행별 예측 JSON](evidence/direction-widths-20261002.json)에 모든 결과와 두 입력 해시를 남겼다. 3/6/12시간의 06시 정렬, 미래 가격 변경 불변성, 후반 자료가 전반 예측을 바꾸지 않는지 테스트했다. 운영 수집·예측 발행·사이트 표시는 변경하지 않았다.']
Path('docs/direction-widths-results-2026-10-02.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
print({'card_evaluable':len(eligible),'wins_vs_majority':wins,'ties':ties})
