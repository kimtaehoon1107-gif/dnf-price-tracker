import importlib.util
from pathlib import Path
from unittest.mock import patch
import unittest
import numpy as np

spec=importlib.util.spec_from_file_location('study',Path(__file__).with_name('arima-diagnostics-study.py'))
study=importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


class TestSelection(unittest.TestCase):
    def test_constant_stays_constant(self):
        values,record=study.select_model([{'vwap':100}]*25)
        np.testing.assert_array_equal(values,np.repeat(100,8))
        self.assertEqual(record['fallback'],'constant')

    def test_nonstationary_difference_falls_back(self):
        diagnostic=dict(constant=False,kpss=.01,adf=.2)
        with patch.object(study,'diagnostics',return_value=diagnostic),patch.object(study,'ARIMA') as model:
            values,record=study.select_model([{'vwap':100+i} for i in range(25)])
        self.assertEqual(record['d'],1)
        model.assert_not_called()
        np.testing.assert_array_equal(values,np.repeat(124,8))

    def test_aicc_selects_only_within_chosen_d(self):
        calls=[]
        class Fit:
            mle_retvals={'converged':True}
            def __init__(self,order):
                self.aicc=0 if order==(1,1,0) else 10
            def fit(self):
                return self
            def forecast(self,n):
                return np.ones(n)
        def factory(y,order,trend):
            calls.append(order)
            return Fit(order)
        with patch.object(study,'diagnostics',side_effect=[dict(constant=False,kpss=.01),dict(constant=False,kpss=.1)]),patch.object(study,'ARIMA',side_effect=factory):
            _,record=study.select_model([{'vwap':100+i} for i in range(25)])
        self.assertTrue(all(d==1 and p<7 for p,d,q in calls))
        self.assertEqual(record['selected']['order'],[1,1,0])


unittest.main()
