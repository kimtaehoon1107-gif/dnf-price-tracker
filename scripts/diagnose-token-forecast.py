import json,warnings
from datetime import date,timedelta
from pathlib import Path
import numpy as np
from statsmodels.tsa.arima.model import ARIMA
s=json.loads(Path('docs/evidence/token-forecast-20261012/input.json').read_text())
y=np.array([r['vwap'] for r in s['daily']]); dates=[date.fromisoformat(r['d']) for r in s['daily']]
future=[date.fromisoformat(s['forecastDay'])+timedelta(days=i) for i in range(8)]
def ex(ds):return np.array([[float(d.weekday()==j) for j in range(6)] for d in ds])
for iterations in [200,1000]:
 with warnings.catch_warnings(record=True) as caught:
  warnings.simplefilter('always')
  try:
   fit=ARIMA(y/y[-1],order=(1,1,0),trend='n',exog=ex(dates)).fit(method_kwargs={'maxiter':iterations})
   pred=np.asarray(fit.forecast(8,exog=ex(future)))*y[-1]
   result={'maxiter':iterations,'optimizer':fit.mle_retvals,'params':fit.params,'finite':bool(np.all(np.isfinite(pred))),'positive':bool(np.all(pred>0)),'forecast':dict(zip(map(str,future),pred.tolist()))}
  except Exception as e:result={'maxiter':iterations,'exception':repr(e)}
  result['warnings']=[str(w.message) for w in caught]
 print('DIAGNOSTIC '+json.dumps(result,default=lambda x:x.tolist() if hasattr(x,'tolist') else str(x)),flush=True)
