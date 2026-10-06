import importlib.util
import unittest
from datetime import date, timedelta
from pathlib import Path
import numpy as np

spec = importlib.util.spec_from_file_location('inline', Path(__file__).with_name('build-inline-forecast.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ForecastTests(unittest.TestCase):
    def setUp(self):
        self.series = dict(completeBefore='2026-10-07', forecastDay='2026-10-07',
                           distribution={'asOf': '2026-10-06T16:00:00Z'},
                           daily=[dict(d=(date(2026, 9, 16)+timedelta(days=i)).isoformat(),
                                       vwap=100+i, n=10) for i in range(22)])

    def test_dates_and_no_partial_leak(self):
        class Fit:
            def __init__(self, y, **kwargs):
                assert len(y) == 21 and y[-1] == 1
                assert kwargs['order'] == (1, 1, 0)
                self.mle_retvals = {'converged': True}
            def fit(self, **kwargs): return self
            def forecast(self, steps, exog):
                assert exog.shape == (8, 6)
                return np.ones(steps)
        a = module.forecast(self.series, Fit)
        self.series['daily'][-1]['vwap'] = 999999
        self.assertEqual(a, module.forecast(self.series, Fit))
        self.assertEqual(a['anchor'], {'d':'2026-10-06','value':120})
        self.assertEqual(a['points'][0]['d'], '2026-10-07')
        self.assertEqual(a['points'][-1]['d'], '2026-10-14')

    def test_gap_and_unfinished_aggregation(self):
        self.series['completeBefore'] = '2026-10-06'
        self.assertEqual(module.forecast(self.series)['status'], 'unavailable')
        self.series['completeBefore'] = '2026-10-07'
        self.series['daily'].pop(5)
        self.assertEqual(module.forecast(self.series)['status'], 'unavailable')

    def test_failure_hides_instead_of_substitution(self):
        class Failed:
            def __init__(self, *args, **kwargs): raise ValueError('fit failed')
        result = module.forecast(self.series, Failed)
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['points'], [])

    def test_nonconvergence_and_invalid_predictions(self):
        for converged, value in [(False, 1), (True, -1), (True, float('nan'))]:
            class Fit:
                def __init__(self, *args, **kwargs): self.mle_retvals = {'converged': converged}
                def fit(self, **kwargs): return self
                def forecast(self, *args, **kwargs): return np.repeat(value, 8)
            self.assertEqual(module.forecast(self.series, Fit)['points'], [])


if __name__ == '__main__': unittest.main()
