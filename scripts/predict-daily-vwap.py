"""사전 고정한 후보들을 새 입력으로 발행한다. 과거 연구 결과 파일은 수정하지 않는다."""
import os
os.environ['OPENBLAS_NUM_THREADS']='1'
os.environ['OMP_NUM_THREADS']='1'
import importlib.util
import json
import sys
from pathlib import Path

def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

fixed=load('fixed','forecast-model-study.py')
selected=load('selected','arima-diagnostics-study.py')
data=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
items=[]
for entry in data['latest']:
    predictions,failures=fixed.predictions(entry)
    values,diagnostic=selected.select_model(entry['train'])
    for h in [1,3,7]:
        predictions[h]['selected']=float(values[h])
    items.append(dict(id=entry['id'],name=entry['name'],failures=failures,diagnostic=diagnostic,predictions=[dict(h=h,d=(fixed.date.fromisoformat(entry['origin'])+fixed.timedelta(days=h)).isoformat(),values=predictions[h]) for h in [1,3,7]]))
Path(sys.argv[2]).write_text(json.dumps(dict(items=items),ensure_ascii=False,allow_nan=False),encoding='utf-8')
