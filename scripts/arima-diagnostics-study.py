"""학습 구간에서만 차분·차수를 선택하고 기존 스냅샷의 같은 목표일에서 평가한다."""
import os
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
import json
import hashlib
import warnings
from pathlib import Path
from datetime import datetime, timezone, date, timedelta
from collections import Counter
import numpy as np
from statsmodels.tsa.stattools import adfuller, kpss
from statsmodels.tsa.arima.model import ARIMA
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from statsmodels.graphics.tsaplots import plot_acf, plot_pacf

SOURCE = Path('docs/evidence/forecast-20261006')
OUT = Path('docs/evidence/arima-diagnostics-20261006')


def diagnostics(y):
    if np.ptp(y) < 1e-10:
        return {'constant': True, 'adf': None, 'kpss': None, 'warnings': []}
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        a = adfuller(y, regression='c', autolag='AIC')
        k = kpss(y, regression='c', nlags='auto')
    return {'constant': False, 'adf': float(a[1]), 'kpss': float(k[1]),
            'adfLag': int(a[2]), 'kpssLag': int(k[2]),
            'agreement': bool((a[1] < .05) == (k[1] >= .05)),
            'warnings': sorted(set(str(w.message) for w in caught))}


def select_model(train):
    # 이 함수는 목표일 실제값을 받지 않는다.
    y = np.array([p['vwap'] for p in train], dtype=float)
    scaled = y/y[-1]
    raw, diff = diagnostics(scaled), diagnostics(np.diff(scaled))
    d = int(not raw['constant'] and raw['kpss'] < .05)
    record = {'n': len(y), 'raw': raw, 'diff': diff, 'd': d, 'candidates': []}
    if raw['constant'] or (d == 1 and not diff['constant'] and diff['kpss'] < .05):
        record['fallback'] = 'constant' if raw['constant'] else '차분 후에도 KPSS 기각'
        return np.repeat(y[-1],8), record
    orders = [(p,q) for p in range(3) for q in range(3) if p+q <= 3]
    if len(y) >= 40:
        orders.append((7,0))
    best = None
    for p,q in orders:
        for trend in (['c'] if d == 0 else ['n','t']):
            candidate = {'order':[p,d,q], 'trend':trend}
            try:
                with warnings.catch_warnings(record=True) as caught:
                    warnings.simplefilter('always')
                    fit = ARIMA(scaled,order=(p,d,q),trend=trend).fit()
                values = np.asarray(fit.forecast(8))*y[-1]
                if not fit.mle_retvals.get('converged',False):
                    raise ValueError('nonconvergence')
                if not np.isfinite(fit.aicc) or not np.all(np.isfinite(values)) or np.any(values<=0):
                    raise ValueError('invalid AICc or forecast')
                candidate['aicc'] = float(fit.aicc)
                candidate['warnings'] = sorted(set(str(w.message) for w in caught))
                if best is None or fit.aicc < best[0]:
                    best = (fit.aicc,values,candidate)
            except (ValueError,RuntimeError,np.linalg.LinAlgError) as exc:
                candidate['failure'] = str(exc)
            record['candidates'].append(candidate)
    if best is None:
        record['fallback'] = '모든 후보 실패'
        return np.repeat(y[-1],8),record
    record['selected'] = best[2]
    return best[1],record


def plot_item(entry, diag):
    plt.rcParams['font.family'] = 'Malgun Gothic'
    plt.rcParams['axes.unicode_minus'] = False
    y = np.array([p['vwap'] for p in entry['train']])/10000
    fig, ax = plt.subplots(3,2,figsize=(12,9),layout='constrained')
    x = [date.fromisoformat(p['d']) for p in entry['train']]
    ax[0,0].plot(x,y,color='#307af6',marker='.',markersize=4)
    ax[0,0].set_title('원가격 · 일별 수량 가중평균 (만 골드)')
    ax[0,1].plot(x[1:],np.diff(y),color='#307af6',marker='.',markersize=4)
    ax[0,1].axhline(0,color='#999999',linewidth=.8)
    ax[0,1].set_title('1차 차분 · 전날 대비 변화 (만 골드)')
    for col,values in enumerate([y,np.diff(y)]):
        if np.ptp(values)<1e-10:
            ax[1,col].text(.1,.5,'상수 계열: 상관 계산 생략')
            ax[2,col].text(.1,.5,'상수 계열: 상관 계산 생략')
        else:
            lags=min(10,len(values)//2-1)
            plot_acf(values,lags=lags,zero=False,ax=ax[1,col],title='ACF · '+('원가격' if col==0 else '차분'))
            plot_pacf(values,lags=lags,zero=False,method='ywm',ax=ax[2,col],title='PACF · '+('원가격' if col==0 else '차분'))
        ax[1,col].set_xlabel('시차 (일)')
        ax[2,col].set_xlabel('시차 (일)')
    for a in ax[0,:]:
        a.tick_params(axis='x',rotation=25,labelsize=8)
    chosen=diag.get('selected',{}).get('order',diag.get('fallback'))
    def fmt(v):
        return '—' if v is None else f'{v:.3f}'
    fig.suptitle(f"{entry['name']} · {len(y)}일 · 선택 {chosen}\n원가격 ADF p={fmt(diag['raw']['adf'])}, KPSS p={fmt(diag['raw']['kpss'])} / 차분 ADF p={fmt(diag['diff']['adf'])}, KPSS p={fmt(diag['diff']['kpss'])}\n짧은 표본의 탐색 진단 · 음영은 근사 95% 구간, 다중검정 보정 없음",fontsize=12)
    fig.savefig(OUT/(entry['id']+'.png'),dpi=120)
    plt.close(fig)


def score(rows):
    scores=[]
    for h in [1,3,7]:
        subset=[r for r in rows if r['h']==h]
        for m in ['last','existing','arima110','selected']:
            ids=sorted(set(r['id'] for r in subset))
            item_errors=[]
            wins=0
            for item in ids:
                rr=[r for r in subset if r['id']==item]
                err=np.mean([abs(r[m]/r['actual']-1)*100 for r in rr])
                base=np.mean([abs(r['last']/r['actual']-1)*100 for r in rr])
                item_errors.append(err)
                wins+=int(err<base-1e-9)
            scores.append(dict(h=h,model=m,n=len(subset),items=len(ids),dates=len(set(r['d'] for r in subset)),mape=float(np.mean([abs(r[m]/r['actual']-1)*100 for r in subset])),itemMape=float(np.mean(item_errors)),wins=wins))
    return scores


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    raw=(SOURCE/'input.json').read_bytes()
    data=json.loads(raw)
    old=json.loads((SOURCE/'results.json').read_text(encoding='utf-8'))
    reference={(r['id'],r['origin'],r['h']):r for r in old['rows']}
    rows,records,latest=[],[],[]
    for i,entry in enumerate(data['cases']+data['latest']):
        values,diag=select_model(entry['train'])
        records.append(dict(id=entry['id'],name=entry['name'],origin=entry['origin'],**diag))
        for target in entry['targets']:
            oldrow=reference[(entry['id'],entry['origin'],target['h'])]
            rows.append(dict(id=entry['id'],name=entry['name'],origin=entry['origin'],**target,selected=float(values[target['h']]),**{m:oldrow['pred'][m] for m in ['last','existing','arima110']}))
        if entry['origin']==data['before']:
            latest.append(dict(id=entry['id'],name=entry['name'],origin=entry['origin'],**diag,predictions=[dict(d=(date.fromisoformat(entry['origin'])+timedelta(days=h)).isoformat(),h=h,price=float(values[h])) for h in [1,3,7]]))
            plot_item(entry,diag)
        if (i+1)%25==0:
            print(f'{i+1}/{len(data["cases"])+len(data["latest"])} completed',flush=True)
    scores=score(rows)
    result=dict(generatedAt=datetime.now(timezone.utc).isoformat(),inputSha256=hashlib.sha256(raw).hexdigest(),codeSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),scores=scores,rows=rows,records=records,latest=latest,excluded=data['excluded'])
    (OUT/'results.json').write_text(json.dumps(result,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    lines=['# 품목별 ARIMA 진단·선택 결과','','고정된 과거 스냅샷으로 다시 비교한 탐색이다. 새로운 미래 검증이 아니다. 원본 예측은 보존했다.','', '## 같은 사례에서 예측 오차','','|거리|모델|건수|품목|목표 날짜 수|MAPE|품목 동일 비중|기준선 개선 품목|','|---|---|---:|---:|---:|---:|---:|---:|']
    for s in scores:
        lines.append(f"|{s['h']}|{s['model']}|{s['n']}|{s['items']}|{s['dates']}|{s['mape']:.3f}%|{s['itemMape']:.3f}%|{s['wins']}|")
    lines+=['','## 최신 품목별 진단','','p값은 검정의 증거 수준이며 모델 정확도가 아니다. KPSS 0.01·0.10은 표의 하한·상한일 수 있다. ADF/KPSS 불일치와 작은 표본에 주의.','','|품목·그림|일수|원가격 ADF / KPSS|차분 ADF / KPSS|d|선택 또는 대체|','|---|---:|---|---|---:|---|']
    def f(v):
        return '—' if v is None else f'{v:.3f}'
    for e in latest:
        selected=e.get('selected',{})
        label=str(selected.get('order',e.get('fallback')))+' '+selected.get('trend','')
        lines.append(f"|[{e['name']}]({e['id']}.png)|{e['n']}|{f(e['raw']['adf'])} / {f(e['raw']['kpss'])}|{f(e['diff']['adf'])} / {f(e['diff']['kpss'])}|{e['d']}|{label}|")
    lines+=['','## 품목별 성능','','|품목|거리|건수|마지막 가격 오차|선택 ARIMA 오차|','|---|---:|---:|---:|---:|']
    for item in sorted(set(r['id'] for r in rows)):
        for h in [1,3,7]:
            rr=[r for r in rows if r['id']==item and r['h']==h]
            if rr:
                errors=[np.mean([abs(r[m]/r['actual']-1)*100 for r in rr]) for m in ['last','selected']]
                lines.append(f"|{rr[0]['name']}|{h}|{len(rr)}|{errors[0]:.3f}%|{errors[1]:.3f}%|")
    lines+=['','## 한계와 제외','','- 차수 선택은 각 과거 학습 구간에서만 수행했다. 다만 전체 평가 구간은 이미 본 자료라 최종 검증이 아니다.','- d는 KPSS 규칙으로 정한 실험 설정이며 품목의 영구적 속성이 아니다. ADF는 보조 진단이다.','- 7일 앞 평가의 품목별 표본은 특히 작다. 겹치는 목표 날짜는 독립 표본이 아니다.','- 계절 ARIMA·외생 이벤트·시간봉은 이번 범위에 없다.',f"- 최신 예측 제외 {len(data['excluded'])}종: "+', '.join(e['name'] for e in data['excluded']),f"- 기준선 대체 학습 사례: {sum('fallback' in r for r in records)} / {len(records)} (최신 예측 포함).",'',f"생성 시각: {result['generatedAt']} / 입력 SHA256: {result['inputSha256']}"]
    (OUT/'report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps({'scores':scores,'latest_d':dict(Counter(r['d'] for r in latest)),'fallbacks':sum('fallback'in r for r in records)},ensure_ascii=False))


if __name__=='__main__':
    main()
