import json,warnings
from datetime import date,timedelta
from pathlib import Path
import numpy as np
import scipy, scipy.optimize as opt
from statsmodels.tsa.arima.model import ARIMA
s=json.loads(Path('docs/evidence/token-forecast-20261012/input.json').read_text())
days=sorted(s['daily'],key=lambda r:r['d'])
y=np.array([r['vwap'] for r in days]); dates=[date.fromisoformat(r['d']) for r in days]
future=[date.fromisoformat(s['forecastDay'])+timedelta(days=i) for i in range(8)]
def ex(ds):return np.array([[float(d.weekday()==j) for j in range(6)] for d in ds])
original=opt.fmin_l_bfgs_b
raw=[]
def traced(func, x0, *args, **kwargs):
 calls=[];accepted=[]
 def objective(x,*a):
  value=func(x,*a)
  calls.append({'x':np.asarray(x).tolist(),'f':float(value)})
  return value
 previous_callback=kwargs.get('callback')
 def callback(x):
  accepted.append({'callCount':len(calls),'x':np.asarray(x).tolist()})
  if previous_callback is not None:return previous_callback(x)
 kwargs['callback']=callback
 if name=='line_search_100':kwargs['maxls']=100
 r=original(objective,x0,*args,**kwargs);raw.append(r[2])
 stride=len(x0)+1
 start=accepted[-1]['callCount'] if accepted else 0
 trace={'case':name,'approx_grad':kwargs.get('approx_grad'),'epsilon':kwargs.get('epsilon'),'dimension':len(x0),'lastAccepted':accepted[-3:], 'trialsAfterLastAccepted':[dict(calls[i],call=i+1) for i in range(start,len(calls),stride)],'previousBasePoints':[dict(calls[i],call=i+1) for i in range(max(0,start-3*stride),start,stride)],'termination':r[2]}
 print('TRACE '+json.dumps(trace,default=lambda x:x.tolist() if hasattr(x,'tolist') else str(x)),flush=True)
 return r
opt.fmin_l_bfgs_b=traced
fits={}
cases=[('exact_200',{}, {'maxiter':200}),('line_search_100',{}, {'maxiter':200})]
print('ENV',scipy.__version__,np.__version__, 'weekday_diff_rank',np.linalg.matrix_rank(np.diff(ex(dates),axis=0)),flush=True)
for name,model_kwargs,solver in cases:
 raw.clear()
 with warnings.catch_warnings(record=True) as caught:
  warnings.simplefilter('always')
  try:
   model=ARIMA(y/y[-1],order=(1,1,0),trend='n',exog=None if name=='no_weekday' else ex(dates),**model_kwargs)
   start={'start_params':fits['powell'].params} if name=='warm_lbfgs' and 'powell' in fits else {}
   fit=model.fit(**start,method_kwargs={'maxiter':1000,**solver});fits[name]=fit
   pred=np.asarray(fit.forecast(8,exog=None if name=='no_weekday' else ex(future)))*y[-1]
   result={'case':name,'llf':fit.llf,'optimizer':fit.mle_retvals,'raw':list(raw),'params':dict(zip(fit.param_names,fit.params.tolist())),'forecast':pred.tolist()}
  except Exception as e:result={'case':name,'exception':repr(e)}
  result['warnings']=[str(w.message) for w in caught if 'deprecated' not in str(w.message)]
 print('DETAIL '+json.dumps(result,default=lambda x:x.tolist() if hasattr(x,'tolist') else str(x)),flush=True)
