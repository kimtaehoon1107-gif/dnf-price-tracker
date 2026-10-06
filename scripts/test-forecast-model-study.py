import importlib.util
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch
import numpy as np

spec = importlib.util.spec_from_file_location('study', Path(__file__).with_name('forecast-model-study.py'))
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


class FakeFit:
    mle_retvals = {'success': True, 'converged': True}
    def fit(self, **kwargs):
        return self
    def forecast(self, steps):
        return np.arange(1, steps+1, dtype=float)


class ForecastTest(unittest.TestCase):
    def entry(self):
        return dict(origin='2026-10-06',existing=[100]*7,train=[dict(d=(date(2026,9,15)+timedelta(days=i)).isoformat(),vwap=100,n=10) for i in range(21)])

    def test_calendar_horizons_exclude_current_day(self):
        with patch.object(study,'ARIMA',return_value=FakeFit()), patch.object(study,'ExponentialSmoothing',return_value=FakeFit()):
            values, failures = study.predictions(self.entry())
        self.assertEqual([values[h]['arima110'] for h in [1,3,7]],[200,400,800])
        self.assertFalse(failures)

    def test_fit_failure_preserves_same_cases(self):
        with patch.object(study,'ARIMA',side_effect=ValueError('failure')), patch.object(study,'ExponentialSmoothing',side_effect=ValueError('failure')):
            values, failures = study.predictions(self.entry())
        self.assertEqual(len(failures),4)
        self.assertTrue(all(values[h][m]==100 for h in values for m in study.MODELS))

    def test_real_constant_series(self):
        values, _ = study.predictions(self.entry())
        self.assertTrue(all(abs(values[h][m]-100)<0.01 for h in values for m in study.MODELS))


unittest.main()
