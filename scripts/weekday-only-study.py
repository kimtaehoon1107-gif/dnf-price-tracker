"""Descriptive 06-to-06 weekday levels and adjacent-day changes, no intraday predictor."""
import json, hashlib, statistics
from pathlib import Path
from datetime import datetime, timezone, timedelta

H=3600000
D=24*H
def stamp(s): return int(datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000)
def label(t): return datetime.fromtimestamp(t/1000,timezone.utc).date().isoformat()
def weekday(d): return datetime.fromisoformat(d).weekday()
def monday(d): return (datetime.fromisoformat(d)-timedelta(days=weekday(d))).date().isoformat()
def mean(xs): return statistics.mean(xs) if xs else None
def median(xs): return statistics.median(xs) if xs else None

def analyze(points,cutoff):
    mapping={p['t']:p['price'] for p in points}
    dates=sorted({label(t+3*H) for t in mapping})
    daily=[]
    for day in dates:
        start=stamp(day+'T00:00:00Z')-3*H
        vals=[mapping.get(start+i*H) for i in range(24)]
        vals=[v for v in vals if v is not None and v>0]
        eligible=start+D<=cutoff and len(vals)>=18
        daily.append(dict(day=day,weekday=weekday(day),week=monday(day),hours=len(vals),eligible=eligible,price=mean(vals) if eligible else None))
    valid=[d for d in daily if d['eligible']]
    byday={d['day']:d for d in valid}
    weeks=[w for w in sorted({d['week'] for d in valid}) if sum(d['week']==w for d in valid)==7]
    weekly=[]
    for w in weeks:
        ds=[d for d in valid if d['week']==w]
        base=mean([d['price'] for d in ds])
        weekly.append(dict(week=w,indices=[d['price']/base*100 for d in ds]))
    transitions=[]
    for d in valid:
        prev=byday.get((datetime.fromisoformat(d['day'])-timedelta(days=1)).date().isoformat())
        if prev:
            start=stamp(d['day']+'T00:00:00Z')-3*H
            pairs=[(mapping.get(start+h*H),mapping.get(start-D+h*H)) for h in range(24)]
            pairs=[(a,b) for a,b in pairs if a is not None and b is not None and a>0 and b>0]
            matched=(mean([a for a,b in pairs])/mean([b for a,b in pairs])-1)*100 if len(pairs)>=18 else None
            transitions.append(dict(day=d['day'],weekday=d['weekday'],change=(d['price']/prev['price']-1)*100,matchedHours=len(pairs),matchedChange=matched))
    profile=[]
    for dow in range(7):
        vals=[w['indices'][dow] for w in weekly]
        changes=[t['change'] for t in transitions if t['weekday']==dow]
        profile.append(dict(weekday=dow,weeks=len(vals),index=mean(vals),below100=sum(v<100 for v in vals),above100=sum(v>100 for v in vals),changeN=len(changes),medianChange=median(changes),up=sum(v>.5 for v in changes),flat=sum(-.5<=v<=.5 for v in changes),down=sum(v<-.5 for v in changes)))
    return dict(validDays=len(valid),fullWeeks=weeks,weekly=weekly,profile=profile,daily=daily,transitions=transitions)

if __name__=='__main__':
    raw=Path('data/activity-research-verified/hourly.json').read_bytes()
    hourly=json.loads(raw)
    meta=json.loads(Path('data/activity-research-verified/report.json').read_text(encoding='utf-8'))
    activity=json.loads(Path('data/intraday-study/activity-input.json').read_text(encoding='utf-8'))
    assert meta['asOf']==activity['asOf']
    items={i['item_id']:i for i in activity['items']}
    selected=[s for s in hourly if s['id'] in items or '호가' in s['basis'] or (s['id']=='legendary' and s['basis']=='P10')]
    cutoff=stamp(meta['asOf'])
    results=[]
    for s in selected:
        category=items[s['id']]['category'] if s['id'] in items else ('카드' if '호가' in s['basis'] else 'P10')
        results.append(dict(id=s['id'],name=s['name'],basis=s['basis'],category=category,**analyze(s['points'],cutoff)))
    groups=[]
    for category in ['소울 결정','유랑악단 패키지']:
        rs=[r for r in results if r['category']==category]
        common=sorted(set.intersection(*(set(r['fullWeeks']) for r in rs)))
        profiles=[]
        for dow in range(7):
            vals=[mean([next(w['indices'][dow] for w in r['weekly'] if w['week']==week) for r in rs]) for week in common]
            profiles.append(dict(weekday=dow,weeks=len(vals),index=mean(vals),values=vals))
        groups.append(dict(category=category,items=len(rs),fullWeeks=common,profile=profiles))
    report=dict(asOf=meta['asOf'],inputHash=hashlib.sha256(raw).hexdigest(),boundary=6,minHours=18,description='Hourly arithmetic mean per completed game day; complete Monday–Sunday weeks only for level profiles; adjacent calendar-day returns use all eligible pairs. Descriptive, not a forecast.',results=results,groups=groups)
    Path('docs/evidence/weekday-only-20261002.json').write_text(json.dumps(report,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    for r in results:
        if r['category']!='카드': print(r['name'],r['fullWeeks'],[(p['weekday'],round(p['index'],2) if p['index'] else None,p['changeN'],round(p['medianChange'],2) if p['medianChange'] is not None else None) for p in r['profile']])
    print('groups',groups)
