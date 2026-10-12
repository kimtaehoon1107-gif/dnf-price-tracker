"""Experimental seven-day daily VWAP forecast; reads only the built site files."""
import json
import sys
import warnings
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from statsmodels.tsa.arima.model import ARIMA

ITEMS = ['c7d845c65ab9dbcff6e55dc910fbea87',
         'c6947ff630cc59aebdcbabfb449258d1',
         'f9941d3fa0b8253bb0b2567a29b1299f']


def forecast(series, fit_model=ARIMA):
    before = series['completeBefore']
    today = date.fromisoformat(series['forecastDay'])
    days = {r['d']: r for r in series['daily'] if r['d'] < before and r['d'] < today.isoformat()}
    end = today - timedelta(days=1)
    dates = [(end - timedelta(days=i)).isoformat() for i in reversed(range(21))]
    base = dict(model='weekday-arima110-median10x-v2', preprocessing='daily-median-10x-v1', issuedAt=series['distribution']['asOf'],
                trainFrom=dates[0], trainThrough=dates[-1], points=[])
    if any(d not in days for d in dates):
        return dict(base, status='unavailable', reason='최근 21일의 연속 완료 일봉이 부족합니다.')
    train = [days[d] for d in dates]
    y = np.array([r['vwap'] for r in train], dtype=float)
    if not np.all(np.isfinite(y)) or np.any(y <= 0) or sum(r['n'] for r in train) / 21 < 5:
        return dict(base, status='unavailable', reason='학습에 필요한 거래 관측이 부족합니다.')
    # Include today's estimate to bridge from the last completed day, then tomorrow + seven days.
    future = [(today + timedelta(days=i)).isoformat() for i in range(8)]
    def weekdays(ds):
        return np.array([[float(date.fromisoformat(d).weekday() == j) for j in range(6)] for d in ds])
    attempts = []
    def attempt(name, options):
        detail = {'solver': name}
        caught = []
        try:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter('always')
                fitted = fit_model(y / y[-1], order=(1, 1, 0), trend='n', exog=weekdays(dates)).fit(method_kwargs={'maxiter': 200, **options})
                predicted = np.asarray(fitted.forecast(8, exog=weekdays(future))) * y[-1]
            ret = fitted.mle_retvals
            detail.update(converged=bool(ret.get('converged', False)),
                          warnflag=int(ret.get('warnflag', -1)), iterations=int(ret.get('iterations', -1)),
                          functionCalls=int(ret.get('fcalls', -1)))
            if not detail['converged']:
                detail['failure'] = 'nonconvergence'
            elif predicted.shape != (8,) or not np.all(np.isfinite(predicted)):
                detail['failure'] = 'invalid_prediction'
            elif np.any(predicted <= 0):
                detail['failure'] = 'nonpositive_prediction'
            else:
                return predicted
        except (ValueError, RuntimeError, np.linalg.LinAlgError) as error:
            detail.update(failure='numerical_exception', errorType=type(error).__name__, message=str(error))
        finally:
            detail['warnings'] = list(dict.fromkeys(str(w.message) for w in caught))
            attempts.append(detail)
        return None

    predicted = attempt('lbfgs', {})
    selected = 'lbfgs'
    if predicted is None:
        # Same model/data; independent numerical methods must agree before recovery.
        first = attempt('lbfgs-complex-step', {'optim_score': 'approx', 'optim_complex_step': True})
        second = attempt('powell', {'method': 'powell'})
        if first is not None and second is not None:
            gap = float(np.max(np.abs(first - second) / np.maximum(np.abs(first), np.abs(second))))
            base['retryMaxRelativeDifference'] = gap
            # Numerical agreement guard, not a forecast accuracy claim.
            if gap <= 0.01:
                predicted, selected = first, 'lbfgs-complex-step'
    base.update(fitPolicy='retry-agreement-v1', fitDiagnostics=attempts)
    if predicted is None:
        reason = '예측 계산이 안정적으로 완료되지 않아 표시하지 않습니다.'
        if 'retryMaxRelativeDifference' in base:
            reason = '재시도한 계산 방법 간 예측값 차이가 커서 표시하지 않습니다.'
        return dict(base, status='unavailable', reason=reason)
    return dict(base, status='ready', solver=selected, anchor={'d': dates[-1], 'value': float(y[-1])},
                points=[{'d': d, 'value': float(p)} for d, p in zip(future, predicted)])



def main(directory):
    for item in ITEMS:
        path = Path(directory) / 'data' / 'series' / f'{item}.json'
        series = json.loads(path.read_text(encoding='utf-8'))
        series['inlineForecast'] = forecast(series)
        path.write_text(json.dumps(series, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
        print(item, json.dumps(series['inlineForecast'], ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'dist')
