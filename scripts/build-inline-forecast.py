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
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            fitted = fit_model(y / y[-1], order=(1, 1, 0), trend='n', exog=weekdays(dates)).fit(method_kwargs={'maxiter': 200})
            predicted = np.asarray(fitted.forecast(8, exog=weekdays(future))) * y[-1]
        if not fitted.mle_retvals['converged'] or not np.all(np.isfinite(predicted)) or np.any(predicted <= 0):
            raise ValueError('invalid fit')
    except (ValueError, RuntimeError, np.linalg.LinAlgError):
        return dict(base, status='unavailable', reason='요일 추가 ARIMA 계산이 안정적으로 수렴하지 않아 예측을 표시하지 않습니다.')
    return dict(base, status='ready', anchor={'d': dates[-1], 'value': float(y[-1])},
                points=[{'d': d, 'value': float(p)} for d, p in zip(future, predicted)])


def main(directory):
    for item in ITEMS:
        path = Path(directory) / 'data' / 'series' / f'{item}.json'
        series = json.loads(path.read_text(encoding='utf-8'))
        series['inlineForecast'] = forecast(series)
        path.write_text(json.dumps(series, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
        print(item, series['inlineForecast']['status'])


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'dist')
