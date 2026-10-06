"""공개 일봉 스냅샷으로 고정 모델을 같은 날짜에서 비교한다. 운영 DB에 접근하지 않는다."""
import hashlib
import json
import warnings
from pathlib import Path
from datetime import date, timedelta, datetime, timezone
import numpy as np
import statsmodels
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.tsa.holtwinters import ExponentialSmoothing

ROOT = Path('docs/evidence/forecast-20261006')
MODELS = ['last', 'mean7', 'same_weekday', 'existing', 'ets_level', 'ets_damped', 'arima110', 'arima011']
LABELS = ['마지막 가격 유지', '최근 7일 평균', '최근 같은 요일', '기존 추세+요일', '지수평활: 수준', '지수평활: 감쇠추세', 'ARIMA(1,1,0)', 'ARIMA(0,1,1)']


def predictions(entry):
    y = np.array([p['vwap'] for p in entry['train']], dtype=float)
    origin = date.fromisoformat(entry['origin'])
    history = {p['d']: p['vwap'] for p in entry['train']}
    result, failed = {}, {}
    for h in [1, 3, 7]:
        target = origin + timedelta(days=h)
        past = target - timedelta(days=7)
        while past >= origin:
            past -= timedelta(days=7)
        result[h] = dict(last=y[-1], mean7=float(np.mean(y[-7:])), same_weekday=history[past.isoformat()], existing=entry['existing'][h-1])
    # 가격 자릿수 차이로 인한 수치 최적화 불안정을 줄인다.
    scaled = y / y[-1]
    for name in MODELS[4:]:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                if name.startswith('ets'):
                    trend = name == 'ets_damped'
                    fit = ExponentialSmoothing(scaled, trend='add' if trend else None, damped_trend=trend, initialization_method='estimated').fit(optimized=True)
                    success = fit.mle_retvals.get('success', True)
                else:
                    fit = ARIMA(scaled, order=(1,1,0) if name == 'arima110' else (0,1,1), trend='n').fit()
                    success = fit.mle_retvals.get('converged', False)
                values = np.asarray(fit.forecast(8)) * y[-1]
                if not success or not np.all(np.isfinite(values)) or np.any(values <= 0):
                    raise ValueError('nonconverged or invalid prediction')
            for h in result:
                result[h][name] = float(values[h])
        except (ValueError, RuntimeError, np.linalg.LinAlgError) as error:
            failed[name] = str(error)
            for h in result:
                result[h][name] = float(y[-1])
    return result, failed


def summarize(rows):
    output = []
    for h in [1, 3, 7]:
        cases = [r for r in rows if r['h'] == h]
        ids = sorted({r['id'] for r in cases})
        for model in MODELS:
            errors = [abs(r['pred'][model] / r['actual'] - 1)*100 for r in cases]
            per_item, wins = [], 0
            for item in ids:
                subset = [r for r in cases if r['id'] == item]
                score = np.mean([abs(r['pred'][model]/r['actual']-1)*100 for r in subset])
                naive = np.mean([abs(r['pred']['last']/r['actual']-1)*100 for r in subset])
                per_item.append(float(score))
                wins += int(score < naive - 1e-9)
            output.append(dict(h=h,model=model,n=len(cases),items=len(ids),mape=float(np.mean(errors)) if errors else None,itemMape=float(np.mean(per_item)) if per_item else None,wins=wins))
    return output


if __name__ == '__main__':
    raw = (ROOT/'input.json').read_bytes()
    data = json.loads(raw)
    rows, failures, latest = [], [], []
    for i, entry in enumerate(data['cases'] + data['latest']):
        pred, failed = predictions(entry)
        if failed:
            failures.append(dict(id=entry['id'],origin=entry['origin'],models=failed))
        for target in entry['targets']:
            rows.append(dict(id=entry['id'],name=entry['name'],origin=entry['origin'],**target,pred=pred[target['h']]))
        if entry['origin'] == data['before']:
            latest.append(dict(id=entry['id'],name=entry['name'],origin=entry['origin'],pred=pred))
        if (i+1) % 100 == 0:
            print(f'{i+1} origins completed', flush=True)
    cutoff = (date.fromisoformat(data['before']) - timedelta(days=7)).isoformat()
    full = summarize(rows)
    recent = summarize([r for r in rows if r['d'] >= cutoff])
    result = dict(generatedAt=datetime.now(timezone.utc).isoformat(),inputSha256=hashlib.sha256(raw).hexdigest(),codeSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),statsmodels=statsmodels.__version__,full=full,recent=recent,rows=rows,failures=failures,latest=latest,excluded=data['excluded'])
    (ROOT/'results.json').write_text(json.dumps(result,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    lines = ['# 평균 거래가 예측 비교 결과 — 2026-10-06', '', f"자료 기준: {data['priceAsOf']} / 완료 일봉: {data['before']} 이전", '', '내일·3일·7일 뒤 각각 하루 VWAP 예측. 당일은 학습하지 않아 마지막 완료 일봉에서는 2·4·8일 거리다.', '', '과거 재구성 탐색 결과이며 실시간 사전 발행 검증이 아니다. 자세한 조건은 ../../forecast-study-protocol-2026-10-06.md 참조.', '']
    for title, scores in [('전체 평가',full),('최근 7개 달력 날짜가 목표인 평가',recent)]:
        lines += ['## '+title,'','|거리|모델|평가 건수|종목|MAPE|종목 동일 비중 MAPE|마지막 가격보다 개선된 종목|','|---|---|---:|---:|---:|---:|---:|']
        for s in scores:
            if s['n']:
                lines.append(f"|{s['h']}일|{LABELS[MODELS.index(s['model'])]}|{s['n']}|{s['items']}|{s['mape']:.3f}%|{s['itemMape']:.3f}%|{s['wins']}|")
        lines.append('')
    lines += ['## 적합 실패와 적용 범위','',f'실패가 발생한 품목·기준일 조합: {len(failures)}개. 해당 모델만 마지막 가격 유지로 대체했다.',f"현재 예측 가능: {len(latest)}종 / 현재 학습 조건 미달: {len(data['excluded'])}종.",'','## 품목별 오차','','|품목|거리|평가 건수|마지막 가격 MAPE|최소 오차 모델|최소 MAPE|','|---|---:|---:|---:|---|---:|']
    for item in data['items']:
        scores = summarize([r for r in rows if r['id']==item['id']])
        for h in [1,3,7]:
            group=[s for s in scores if s['h']==h and s['n']]
            if group:
                best=min(group,key=lambda s:s['mape'])
                lines.append(f"|{item['name']}|{h}|{best['n']}|{group[0]['mape']:.3f}%|{LABELS[MODELS.index(best['model'])]}|{best['mape']:.3f}%|")
    lines += ['','품목별 최저 오차 모델은 결과를 본 뒤 고른 값이므로 그대로 배포할 모델 선정 성적으로 해석하지 않는다. 서로 겹치는 날짜의 평가 건수는 독립 표본 수가 아니다.',
              '거리별 평가 날짜와 종목 구성이 다르므로 7일 오차가 1일 오차보다 낮다는 이유로 장기 예측이 쉽다고 해석하지 않는다.',
              '이번에는 고정한 ARIMA 두 설정만 비교했으므로 모든 ARIMA·SARIMA의 성능을 부정하는 결과가 아니다.',
              '', '## 이번 실행에서 저장한 미래 예측', '', f"생성 시각: {result['generatedAt']}. 이후 정답과 대조할 후보 예측이며 검증된 서비스 예측은 아니다.", '',
              '|품목|목표일|마지막 가격 유지|기존 모델|ARIMA(1,1,0)|감쇠 지수평활|','|---|---|---:|---:|---:|---:|']
    for item in latest:
        for h, predictions_for_day in item['pred'].items():
            target=(date.fromisoformat(item['origin'])+timedelta(days=h)).isoformat()
            lines.append(f"|{item['name']}|{target}|"+'|'.join(f"{predictions_for_day[m]:,.0f}" for m in ['last','existing','arima110','ets_damped'])+'|')
    lines += ['',f"입력 SHA-256: {result['inputSha256']}"]
    (ROOT/'report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps(dict(full=full,recent=recent,failures=len(failures),latest=len(latest)),ensure_ascii=False),flush=True)
