"""Fixed small order grid, identical 21-day windows, original price targets."""
import os
os.environ['OPENBLAS_NUM_THREADS']='1'
import json,hashlib,warnings,sys
from pathlib import Path
from datetime import date,timedelta
import numpy as np
import statsmodels
from statsmodels.tsa.arima.model import ARIMA
CLEAN='--cleaned' in sys.argv
ROOT=Path('docs/evidence/outlier-21day-20261008' if CLEAN else 'docs/evidence/outlier-20261007')
OUT=Path('docs/evidence/arima-orders-cleaned-20261008' if CLEAN else 'docs/evidence/arima-orders-20261008');OUT.mkdir(parents=True,exist_ok=True)
ORDERS=[(0,1,0),(1,1,0),(0,1,1),(1,1,1),(2,1,0),(1,0,0)]
def exog(ds):return np.array([[float(date.fromisoformat(d).weekday()==j) for j in range(6)] for d in ds])
def run():
    raw=(ROOT/'arima-input.json').read_bytes();data=json.loads(raw);rows=[]
    for i,c in enumerate(data['cases']):
        y=np.array(c['train']['raw'],dtype=float)
        assert len(y)==21 and c['dates'][-1]==(date.fromisoformat(c['d'])-timedelta(days=1)).isoformat()
        predictions=[('last',float(y[-1]),False),('sameWeekday',float(y[-7]),False)]
        for order in ORDERS:
            for weekday in [False,True]:
                name=''.join(map(str,order))+(' + weekday' if weekday else '')
                failed=False
                try:
                    with warnings.catch_warnings():
                        warnings.simplefilter('ignore')
                        fit=ARIMA(y/y[-1],order=order,trend='c' if order[1]==0 else 'n',exog=exog(c['dates']) if weekday else None).fit(method_kwargs={'maxiter':200})
                        p=float(np.asarray(fit.forecast(1,exog=exog([c['d']]) if weekday else None))[0]*y[-1])
                    if not fit.mle_retvals.get('converged',False) or not np.isfinite(p) or p<=0:raise ValueError('invalid/nonconverged fit')
                except (ValueError,RuntimeError,np.linalg.LinAlgError):p=float(y[-1]);failed=True
                predictions.append((name,p,failed))
        for model,p,failed in predictions:rows.append(dict(id=c['id'],name=c['name'],category=c['category'],basis=c['basis'],d=c['d'],model=model,pred=p,actual=c['actual'],ape=abs(p/c['actual']-1)*100,failed=failed))
        if (i+1)%20==0:print(f'{i+1}/{len(data["cases"])}',flush=True)
    # Match the existing experiment exactly for both forms of ARIMA(1,1,0).
    if not CLEAN:
        old=json.loads((ROOT/'arima-results.json').read_text(encoding='utf-8'))
        lookup={(r['id'],r['d'],r['model']):r for r in old['rows'] if r['method']=='raw'}
        for r in rows:
            if r['model'] in ['110','110 + weekday']:
                prev=lookup[(r['id'],r['d'],'arima' if r['model']=='110' else 'weekdayArima')]
                assert abs(r['pred']/prev['pred']-1)<1e-8 and r['failed']==prev['failed']
    def score(rs):
        out=[]
        for model in dict.fromkeys(r['model'] for r in rs):
            g=[r for r in rs if r['model']==model]
            assert [(r['id'],r['d']) for r in g]==[(r['id'],r['d']) for r in rs if r['model']=='last']
            out.append(dict(model=model,n=len(g),mape=float(np.mean([r['ape'] for r in g])),failures=sum(r['failed'] for r in g)))
        return sorted(out,key=lambda s:s['mape'])
    groups={'전체 거래가':[r for r in rows if r['basis']=='daily-trade-vwap']}
    groups.update({g:[r for r in rows if r['category']==g] for g in dict.fromkeys(r['category'] for r in rows)})
    groups.update({name:[r for r in rows if r['name']==name] for name in ['에픽 소울 결정','레전더리 소울 결정']})
    summary={g:score(rs) for g,rs in groups.items()}
    split={g:{'early':score([r for r in rs if r['d']<='2026-10-02']),'late':score([r for r in rs if r['d']>='2026-10-03'])} for g,rs in groups.items()}
    result=dict(inputSha256=hashlib.sha256(raw).hexdigest(),codeSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),statsmodels=statsmodels.__version__,orders=ORDERS,summary=summary,split=split,rows=rows)
    (OUT/'results.json').write_text(json.dumps(result,ensure_ascii=False,allow_nan=False,indent=2),encoding='utf-8')
    lines=['# ARIMA 차수 비교 — 2026-10-08','','원본 21일 연속 완료 가격으로 다음 날을 예측. 목표 9/30~10/6, 일반 거래가 27종 185건, 카드 P10 7건 별도. 이상치 정제 결과와 섞지 않는다.','',
      '후보 차수 010/110/011/111/210/100, 각각 요일 변수 유무. d=0은 상수 포함, d=1은 드리프트 없음. 요일은 월~토 더미 6개. 가격 유지 및 지난주 같은 요일을 기준선으로 사용한다. 수렴 실패/비정상 예측은 마지막 가격 대체, 실패 횟수 공개.',
      '이미 본 날짜에 대한 후향 비교다. 최저 오차는 후보 중 순위일 뿐 최적 차수의 증명이 아니다. 앞 3일/뒤 4일 순위도 공개하지만 독립된 미사용 검증 구간은 아니다. 기존 110 두 모델의 개별 예측·실패 여부가 이전 결과와 일치하는지 검사했다.']
    for g,ss in summary.items():
        lines+=['',f'## {g}','','|모델|건수|MAPE %|실패 후 가격 유지|','|---|---:|---:|---:|']
        for s in ss:lines.append(f'|{s["model"]}|{s["n"]}|{s["mape"]:.3f}|{s["failures"]}|')
        for window in ['early','late']:
            if not split[g][window]:
                lines.append(f'{window}: 평가 사례 없음')
                continue
            best=split[g][window][0]
            lines.append(f'{window} 최저: {best["model"]}, {best["mape"]:.3f}% ({best["n"]}건)')
    if CLEAN:
        lines[2]='21일 연속 학습과 평가 정답 모두 당일 원본 체결 중앙값 1/10~10배 이내로 정제한 VWAP. 카드 P10은 호가이므로 미적용. KST 00~24시, 평가 9/30~10/6. 원본 대조 불일치 2개 종목일은 제외. 모든 모델은 동일 사례 사용.'
        lines[5]='후향 탐색이며 최저 오차는 후보 중 순위다. 정답 정제 정보는 학습에 사용하지 않는다. 당일 진행 중 가격의 실시간 재현 평가가 아니다.'
    (OUT/'report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print('Complete',len(rows),'predictions; '+('cleaned inputs' if CLEAN else 'prior 110 equality verified'),flush=True)
if __name__=='__main__':run()
