"""저장된 분석 결과만 그린다. DB/네트워크 접근 없음."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = Path('docs/evidence/d-note-20261103')
data = json.loads((root / 'results.json').read_text(encoding='utf-8'))
plt.rcParams['font.family'] = 'Malgun Gothic'
plt.rcParams['axes.unicode_minus'] = False
items = [x for x in data['items'] if x['comparisons'][1]['status'] == '평소 범위 밖(탐색)']
fig, axes = plt.subplots(len(items), 1, figsize=(10, 3 * len(items)), squeeze=False)
for ax, item in zip(axes[:, 0], items):
    path = item['path']
    # None은 공백으로 남긴다. 막대는 해당 시각부터 1시간의 VWAP다.
    ax.plot([p['offset'] + .5 for p in path], [p['index'] for p in path], marker='.', lw=1.5)
    ax.axhline(100, color='gray', lw=.8)
    ax.axvline(0, color='#a33', ls='--', label='방송 예정 19시')
    ax.axvline(1, color='#666', ls=':', label='서버 개방 예정 20시')
    ax.set(title=item['name'], ylabel='직전 6시간 평균=100', xlim=(-24, 24))
    ax.grid(alpha=.2)
axes[0, 0].legend(loc='upper left')
axes[-1, 0].set_xlabel('방송 예정 시각으로부터 시간 (각 점은 1시간 구간의 중앙)')
fig.suptitle('D-NOTE 전후 원본 체결 가격 경로 · 사후 탐색 분석\n평소 범위 이탈 3종; 인과효과·통계적 유의성 판정 아님', fontsize=12)
fig.tight_layout(rect=(0, 0, 1, .94))
fig.savefig(root / 'price-path.png', dpi=160)
fig.savefig(root / 'price-path.svg')
