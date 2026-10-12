"""Read-only reproduction from captured public site data; no DB or API access."""
import importlib.util,json
from pathlib import Path
import scipy.optimize as opt
spec=importlib.util.spec_from_file_location('inline',Path(__file__).with_name('build-inline-forecast.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=json.loads(Path('docs/evidence/token-forecast-20261012/input.json').read_text(encoding='utf-8-sig'))
raw=[]
original=opt.fmin_l_bfgs_b
def traced(*args,**kwargs):
    result=original(*args,**kwargs)
    raw.append({key:result[2][key] for key in ['task','warnflag','nit','funcalls']})
    return result
opt.fmin_l_bfgs_b=traced
result=m.forecast(s)
print('REAL_RESULT',json.dumps(result,ensure_ascii=False))
print('RAW_TERMINATION',json.dumps(raw))
# Exercise recovery with real solvers after injecting ONLY the primary rejection.
class PrimaryRejected:
    def __init__(self,*args,**kwargs): self.model=m.ARIMA(*args,**kwargs)
    def fit(self,method_kwargs):
        fit=self.model.fit(method_kwargs=method_kwargs)
        if set(method_kwargs)=={'maxiter'}:
            fit.mle_retvals=dict(fit.mle_retvals,converged=False,warnflag=2)
        return fit
recovery=m.forecast(s,PrimaryRejected)
print('INJECTED_PRIMARY_FAILURE_RECOVERY',json.dumps(recovery,ensure_ascii=False))
assert recovery['status']=='ready', recovery
assert recovery['retryMaxRelativeDifference']<=0.01
