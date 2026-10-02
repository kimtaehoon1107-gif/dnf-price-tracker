import importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('weekday_only',Path(__file__).with_name('weekday-only-study.py'))
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
start=m.stamp('2026-09-07T06:00:00+09:00')
points=[dict(t=start+i*m.H,price=100+(i//24)%7) for i in range(14*24)]
r=m.analyze(points,start+14*m.D)
assert r['fullWeeks']==['2026-09-07','2026-09-14']
assert r['profile'][0]['index']==100/103*100
assert r['profile'][6]['index']==106/103*100
assert r['profile'][0]['changeN']==1
assert r['daily'][0]['day']=='2026-09-07'
assert r['daily'][0]['hours']==24
missing=[p for i,p in enumerate(points) if not 0<=i<7]
assert m.analyze(missing,start+14*m.D)['fullWeeks']==['2026-09-14']
partial=m.analyze(points,start+13*m.D+23*m.H)
assert partial['fullWeeks']==['2026-09-07']
assert all(abs(sum(w['indices'])/7-100)<1e-9 for w in r['weekly'])
print('weekday-only: 06 boundary, complete weeks, missingness, partial day and adjacent-day changes passed')
