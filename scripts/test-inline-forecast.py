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

    def test_retry_requires_two_converged_agreeing_methods(self):
        for second_value, expected in [(1.005, 'ready'), (1.1, 'unavailable'), (float('nan'), 'unavailable')]:
            class Fit:
                def __init__(self, *args, **kwargs): pass
                def fit(self, method_kwargs):
                    self.kind = method_kwargs.get('method', 'complex' if 'optim_score' in method_kwargs else 'primary')
                    self.mle_retvals = {'converged': self.kind != 'primary', 'warnflag': 2 if self.kind == 'primary' else 0, 'iterations': 20}
                    return self
                def forecast(self, *args, **kwargs): return np.repeat(second_value if self.kind == 'powell' else 1, 8)
            result = module.forecast(self.series, Fit)
            self.assertEqual(result['status'], expected)
            self.assertEqual(result['fitDiagnostics'][0]['failure'], 'nonconvergence')
            self.assertEqual(len(result['fitDiagnostics']), 3)
            if expected == 'ready': self.assertEqual(result['solver'], 'lbfgs-complex-step')

    def test_exception_detail_is_preserved(self):
        class Failed:
            def __init__(self, *args, **kwargs): raise ValueError('numeric failure')
        result = module.forecast(self.series, Failed)
        self.assertEqual(result['fitDiagnostics'][0]['failure'], 'numerical_exception')
        self.assertEqual(result['fitDiagnostics'][0]['message'], 'numeric failure')


if __name__ == '__main__': unittest.main()
