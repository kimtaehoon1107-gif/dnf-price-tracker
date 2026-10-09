"""Rebuild the public comparison from verified cleaned daily prices; no DB access."""
import json, hashlib, warnings
from pathlib import Path
from datetime import date, timedelta
import numpy as np
import statsmodels
from statsmodels.tsa.arima.model import ARIMA

SOURCE = Path('docs/evidence/outlier-21day-20261008/cleaned-target-input.json')
IDS = {'c7d845c65ab9dbcff6e55dc910fbea87':'에픽 소울 결정', 'c6947ff630cc59aebdcbabfb449258d1':'레전더리 소울 결정', 'f9941d3fa0b8253bb0b2567a29b1299f':'닳아버린 순례의 증표'}
def exog(days):
    return np.array([[float(d.weekday()==j) for j in range(6)] for d in days])
def build():
    raw=SOURCE.read_bytes()
    source=json.loads(raw)
    items=[]
    for item_id,name in IDS.items():
        prices={date.fromisoformat(r['day']):r['cleaned'] for r in source['rows'] if r['item_id']==item_id and r['method']=='trade10x' and r['kept_n']>=5 and r['cleaned']>0}
        rows=[]
        for target in sorted(prices):
            if target<date(2026,9,30):continue
            for h in [1,3,7]:
                origin=target-timedelta(days=h)
                days=[origin-timedelta(days=20-i) for i in range(21)]
                if any(d not in prices for d in days):continue
                y=np.array([prices[d] for d in days],dtype=float)
                future=[origin+timedelta(days=i+1) for i in range(h)]
                pred={'last':float(y[-1])}; failed=[]
                for model,weekday in [('arima110',False),('weekday_arima',True)]:
                    try:
                        with warnings.catch_warnings():
                            warnings.simplefilter('ignore')
                            fit=ARIMA(y/y[-1],order=(1,1,0),trend='n',exog=exog(days) if weekday else None).fit(method_kwargs={'maxiter':200})
                            p=float(np.asarray(fit.forecast(h,exog=exog(future) if weekday else None))[-1]*y[-1])
                        if not fit.mle_retvals.get('converged',False) or not np.isfinite(p) or p<=0:raise ValueError('invalid fit')
                    except (ValueError,RuntimeError,np.linalg.LinAlgError):
                        p=float(y[-1]);failed.append(model)
                    pred[model]=p
                rows.append(dict(origin=origin.isoformat(),target=target.isoformat(),h=h,actual=prices[target],pred=pred,failed=failed))
        items.append(dict(name=name,rows=rows))
    result=dict(asOf=source['through'],trainingDays=21,cleaning='daily-median-10x-v1',inputSha256=hashlib.sha256(raw).hexdigest(),statsmodels=statsmodels.__version__,items=items)
    Path('web/forecast-review.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    print([(i['name'],len(i['rows'])) for i in items])
if __name__=='__main__':build()
