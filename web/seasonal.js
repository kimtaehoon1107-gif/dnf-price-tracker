const $=id=>document.getElementById(id),fmt=v=>v==null?'—':v.toFixed(1),DAYS=['월','화','수','목','금','토','일'];
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data;
function extrema(rows){const valid=rows.filter(r=>r.index!=null&&r.n>=3);if(!valid.length)return null;const sorted=[...valid].sort((a,b)=>a.index-b.index);return {lo:sorted[0],hi:sorted.at(-1)}}
function graph(rows,weekly=false){rows=rows.map(r=>!weekly&&r.n<3?{...r,index:null,median:null}:r);const valid=rows.filter(r=>r.index!=null);if(!valid.length)return '<p>공통 관측 표본이 부족합니다. 관측이 쌓이면 자동으로 표시됩니다.</p>';
 const lo=Math.min(99,...valid.flatMap(r=>r.median==null?[r.index]:[r.index,r.median]))-1,hi=Math.max(101,...valid.flatMap(r=>r.median==null?[r.index]:[r.index,r.median]))+1,x=i=>42+i*390/(rows.length-1),y=v=>180-(v-lo)/(hi-lo)*145;
 let out='<svg viewBox="0 0 470 224" role="img" aria-label="평균 100 기준 '+(weekly?'요일':'시간대')+' 지수"><line x1="42" x2="432" y1="'+y(100)+'" y2="'+y(100)+'" class="sl-base"/><text x="4" y="'+y(100)+'" font-size="11">100</text><text x="4" y="33" font-size="11">'+fmt(hi)+'</text><text x="4" y="184" font-size="11">'+fmt(lo)+'</text>';
 rows.forEach((r,i)=>{const label=weekly?DAYS[r.dow]:r.hour+'시';if(i&&r.index!=null&&rows[i-1].index!=null)out+='<line x1="'+x(i-1)+'" y1="'+y(rows[i-1].index)+'" x2="'+x(i)+'" y2="'+y(r.index)+'" class="sl-mean"/>';if(r.index!=null)out+='<circle cx="'+x(i)+'" cy="'+y(r.index)+'" r="3" class="sl-dot"><title>'+label+' · '+fmt(r.index)+' · '+r.n+(weekly?'주':'일')+'</title></circle>';if(weekly||i%4===0||i===rows.length-1)out+='<text text-anchor="middle" x="'+x(i)+'" y="211" font-size="11">'+label+'</text>'});if(!weekly)for(let i=1;i<rows.length;i++)if(rows[i].median!=null&&rows[i-1].median!=null)out+='<line x1="'+x(i-1)+'" y1="'+y(rows[i-1].median)+'" x2="'+x(i)+'" y2="'+y(rows[i].median)+'" class="sl-median"/>';return out+'</svg>';
}
function render(){const set=data.sets.find(s=>s.id===$('group').value),metric=$('metric').value,p=set[metric],b=p.boundaries.find(b=>b.boundary===+$('boundary').value);
 $('basis').textContent=metric==='listings'?'관측 매물 건수입니다. 품목군은 총 건수 합계가 아니라 각 품목의 정규화 지수를 동일 비중으로 평균합니다.':set.id.startsWith('legendary:')?'레전더리 미업글 카드의 호가 지표입니다.':'일반 품목: 체결 시간봉 VWAP · 카드: 미업글 최저호가. 품목군은 각 품목을 동일 비중으로 평균합니다.';
 $('coverage').textContent=p.members.length+'개 구성 · 공통 유효일 '+p.days+'일'+(p.from?' ('+p.from+' ~ '+p.to+')':'')+' · 완전한 공통 주 '+p.weeks+'주';
 const ex=extrema(b.hourly);$('headline').textContent=ex?'평균 곡선에서 '+ex.lo.hour+'시가 낮고('+fmt(ex.lo.index)+'), '+ex.hi.hour+'시가 높았습니다('+fmt(ex.hi.index)+'). 매일 같은 방향이라는 뜻은 아닙니다.':'평균 흐름을 요약하기에는 관측이 부족합니다.';if(ex?.hi.median!=null&&Math.abs(ex.hi.index-ex.hi.median)>3)$('headline').textContent+=' 높은 시각의 중앙값은 '+fmt(ex.hi.median)+'로, 일부 날짜가 평균을 끌어올렸을 수 있습니다.';
 $('hourly').innerHTML=graph(b.hourly);$('weekly').innerHTML=graph(b.weekday,true);
 $('hour-note').textContent='파랑: 평균 · 금색 점선: 날짜별 중앙값. 두 선의 차이가 크면 일부 날짜가 평균에 크게 영향을 준 것입니다. 3일 미만 시간은 표시하지 않습니다. 시간별 표본 '+Math.min(...b.hourly.map(r=>r.n))+'~'+Math.max(...b.hourly.map(r=>r.n))+'일. 하루 첫·끝 3시간 비교 '+b.changes.n+'일 중 상승 '+b.changes.up+'일, 하락 '+b.changes.down+'일.';
 $('week-note').textContent=p.weeks+'주 평균입니다. '+(p.weeks<4?'아직 표본이 매우 적어 요일 효과를 판단할 수 없습니다.':'장기 추세·이벤트를 통제한 유의성 검정은 별도입니다.');
 $('members').innerHTML='<table><thead><tr><th>품목</th><th>유효일</th><th>주 수</th><th>평균상 낮은 시각</th><th>높은 시각</th></tr></thead><tbody>'+p.members.map(m=>{const child=data.sets.find(s=>s.id===m.id),cp=child?.[metric]??p,cb=cp.boundaries.find(b=>b.boundary===+$('boundary').value),e=extrema(cb.hourly);return '<tr><td><button data-item="'+escape(m.id)+'">'+escape(m.name)+'</button></td><td>'+cp.days+'</td><td>'+cp.weeks+'</td><td>'+(e?e.lo.hour+'시':'—')+'</td><td>'+(e?e.hi.hour+'시':'—')+'</td></tr>'}).join('')+'</tbody></table>';
 renderActivity(set.id);
 $('members').querySelectorAll('button').forEach(btn=>btn.onclick=()=>{$('group').value=btn.dataset.item;render()});
}
function renderActivity(id){
 const a=data.activity?.find(a=>a.id===id);
 if(!a){$('activity-coverage').textContent='소울 결정·유랑악단 패키지·레전더리 P10에서 제공하는 비교입니다.';$('activity-charts').replaceChildren();$('activity-quality').textContent='';return;}
 const labels={price:'가격',traded:'API 관측 체결 수량',stock:'관측 매물 잔량(개)',listings:'미업글 관측 매물(건)'};
 const p=a.metrics[0].profile;
 $('activity-coverage').textContent=p.members.length+'개 구성 · 공통 '+p.days+'일 / '+p.weeks+'주'+(p.from?' · '+p.from+' ~ '+p.to:'')+'. 위의 단일 지표 분석보다 표본이 줄어들 수 있습니다.';
 $('activity-charts').innerHTML=a.metrics.map(m=>{const b=m.profile.boundaries.find(b=>b.boundary===+$('boundary').value);return '<div><h3>'+labels[m.metric]+'</h3><h4>24시간 · 평균과 중앙값</h4>'+graph(b.hourly)+'<p class="muted">시간별 '+Math.min(...b.hourly.map(h=>h.n))+'~'+Math.max(...b.hourly.map(h=>h.n))+'일 · 파랑 평균 / 금색 중앙값</p><h4>요일별 · '+p.weeks+'주 평균</h4>'+graph(b.weekday,true)+'</div>'}).join('');
 if(id==='legendary:p10'){$('activity-quality').textContent='레전더리는 가격·미업글 매물 건수만 비교합니다. 체결 API에서 업그레이드 단계를 구분할 수 없어 체결량을 미업글 수요로 표시하지 않습니다. 요일 표본은 아직 제한적입니다.';return;}
 const qs=(data.activityQuality??[]).filter(q=>p.members.some(m=>m.id===q.item_id)),sum=k=>qs.reduce((s,q)=>s+q[k],0);
 $('activity-quality').textContent='최근 7일 범위에 남아 있는 수집 기록 (구성 '+qs.length+'/'+p.members.length+'개): 성공 '+sum('succeeded')+'회 · 실패 '+sum('failed')+'회 · 100건 응답의 이전 수집과 겹침 부족 표시 '+sum('saturated')+'회. 기록이 없던 구간의 정상 수집을 보증하거나 전체 분석 기간의 누락을 보정한 수치는 아닙니다. 요일 평균은 소수 주의 탐색 결과입니다.';
}
function status(){const hours=(Date.now()-Date.parse(data.asOf))/3600000;$('status').className=hours>3?'stale':'';$('status').textContent=(hours>3?'⚠ 오래된 데이터 · ':'')+'자료 기준 '+new Date(data.asOf).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+' KST · 페이지는 5분마다 새 빌드 여부를 확인합니다.'}
async function refresh(){try{const r=await fetch('data/seasonal.json',{cache:'no-store'});if(!r.ok)throw Error();const next=await r.json(),selected=$('group').value;data=next;$('group').replaceChildren();for(const s of data.sets){const o=document.createElement('option');o.value=s.id;o.textContent=(s.id.startsWith('group:')?'품목군 · ':'')+s.name;$('group').append(o)}$('group').value=data.sets.some(s=>s.id===selected)?selected:'legendary:p10';render();status()}catch{$('status').textContent='자료를 갱신하지 못했습니다. '+(data?'이전 결과를 표시하고 있습니다.':'잠시 후 다시 시도해 주세요.')}}
for(const id of ['group','boundary','metric'])$(id).onchange=()=>{if(data)render()};
refresh();setInterval(refresh,300000);
