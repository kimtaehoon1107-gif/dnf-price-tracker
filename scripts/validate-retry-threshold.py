"""Exploratory rolling-origin validation; fixed candidate thresholds, no DB access."""
import json,warnings
from pathlib import Path
from datetime import date,timedelta
import numpy as np
from statsmodels.tsa.arima.model import ARIMA
root=Path('docs/evidence/retry-threshold-20261012')
thresholds=[0.001,0.0025,0.005,0.01,0.02,0.05]
rows=[]
def weekdays(ds): return np.array([[float(d.weekday()==j) for j in range(6)] for d in ds])
for path in sorted(root.glob('*.json')):
 if path.name in ['results.json','summary.json']: continue
 s=json.loads(path.read_text(encoding='utf-8'));days={date.fromisoformat(r['d']):r for r in s['daily']}
 for origin in sorted(days):
  train_dates=[origin-timedelta(days=i) for i in range(21,0,-1)]
  if any(d not in days for d in train_dates): continue
  train=[days[d] for d in train_dates];y=np.array([r['vwap'] for r in train],dtype=float)
  if not np.all(np.isfinite(y)) or np.any(y<=0) or sum(r['n'] for r in train)/21<5:continue
  future=[origin+timedelta(days=i) for i in range(8)]
  row={'item':s['name'],'origin':str(origin),'fits':{},'metrics':{},'gap':None}
  for name,kwargs in [('primary',{}),('complex',{'optim_score':'approx','optim_complex_step':True}),('powell',{'method':'powell'})]:
   try:
    with warnings.catch_warnings():
     warnings.simplefilter('ignore')
     f=ARIMA(y/y[-1],order=(1,1,0),trend='n',exog=weekdays(train_dates)).fit(method_kwargs={'maxiter':200,**kwargs})
     p=np.asarray(f.forecast(8,exog=weekdays(future)))*y[-1]
    ok=bool(f.mle_retvals['converged'] and np.all(np.isfinite(p)) and np.all(p>0))
    row['fits'][name]={'ok':ok,'warnflag':int(f.mle_retvals.get('warnflag',-1)),'iterations':int(f.mle_retvals.get('iterations',-1)),'pred':p.tolist() if np.all(np.isfinite(p)) else None}
   except (ValueError,RuntimeError,np.linalg.LinAlgError) as e: row['fits'][name]={'ok':False,'error':repr(e)}
  a,b=row['fits']['complex'],row['fits']['powell']
  if a['ok'] and b['ok']:
   row['gap']=float(np.max(np.abs(np.array(a['pred'])-b['pred'])/np.maximum(np.abs(a['pred']),np.abs(b['pred']))))
  for h in [0,1,3,7]:
   if future[h] not in days: continue
   actual=days[future[h]]['vwap']
   if actual is None or not np.isfinite(actual) or actual<=0:continue
   metric={'actual':actual,'naiveAPE':float(abs(y[-1]-actual)/actual*100)}
   for name,f in row['fits'].items():
    if f.get('pred') is not None:metric[name+'APE']=float(abs(f['pred'][h]-actual)/actual*100)
   row['metrics'][str(h)]=metric
  rows.append(row)
 def dump(x):return json.dumps(x,ensure_ascii=False,allow_nan=False)
 print('ITEM_DONE',s['name'],len([r for r in rows if r['item']==s['name']]),flush=True)
def stats(rs):
 out={'origins':len(rs),'dates':len(set(r['origin'] for r in rs)),'horizons':{}}
 for h in ['0','1','3','7']:
  ms=[r['metrics'][h] for r in rs if h in r['metrics'] and 'complexAPE' in r['metrics'][h]]
  if ms:out['horizons'][h]={'n':len(ms),'mape':float(np.mean([m['complexAPE'] for m in ms])),'medianAPE':float(np.median([m['complexAPE'] for m in ms])),'maxAPE':max(m['complexAPE'] for m in ms),'naiveMAPE':float(np.mean([m['naiveAPE'] for m in ms])),'beatNaive':sum(m['complexAPE']<m['naiveAPE'] for m in ms)}
 return out
failed=[r for r in rows if not r['fits']['primary']['ok']]
both=[r for r in failed if r['gap'] is not None]
summary={'originRange':[min(r['origin'] for r in rows),max(r['origin'] for r in rows)],'allOrigins':len(rows),'primaryFailures':len(failed),'retryBothValid':len(both),'thresholds':{},'items':{},'gaps':[{'item':r['item'],'origin':r['origin'],'gap':r['gap'],'metrics':r['metrics']} for r in both]}
for t in thresholds: summary['thresholds'][str(t)]=stats([r for r in both if r['gap']<=t])
summary['unrestrictedRetry']=stats(both)
for item in sorted(set(r['item'] for r in rows)):
 subset=[r for r in rows if r['item']==item];fs=[r for r in failed if r['item']==item]
 summary['items'][item]={'origins':len(subset),'primaryFailures':len(fs),'accepted1pct':stats([r for r in fs if r['gap'] is not None and r['gap']<=.01])}
(root/'results.json').write_text(dump(rows),encoding='utf-8');(root/'summary.json').write_text(dump(summary),encoding='utf-8')
print('SUMMARY',dump(summary),flush=True)
