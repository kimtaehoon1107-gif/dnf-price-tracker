import {comparisonSummary,forecastItemNames,forecastModels,MIN_COMPARABLE,niceTicks,overview} from './forecast-review-model.js?v=20261007-review';
let dataPromise;
const labels={last:'마지막 가격 유지',arima110:'일반 ARIMA',weekday_arima:'요일 추가 ARIMA'};
// 색만으로 구분하지 않도록 선 모양도 다르게 한다. 색은 forecast-review.css의 --fr-* 변수(다크모드 대응).
const dash={actual:'',last:'2 4',arima110:'7 4',weekday_arima:'11 3 2 3'};
const horizonLabel={1:'내일',3:'3일 뒤',7:'7일 뒤'};
const format=n=>Math.round(n).toLocaleString('ko-KR');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 해석 주의는 숫자 바로 옆에 둔다. 페이지 맨 아래에 두면 큰 숫자만 읽힌다.
const caution='<p class="fr-badge" role="note"><b>해석 주의</b> 결과를 알고 난 뒤 고른 3품목 · 평가 구간 약 1주 · 같은 시장이라 서로 독립이 아님 → 성능이 검증된 결과가 아닙니다.</p>';
export function itemForecastPanel(id){
  if(!forecastItemNames[id])return '';
  return `<section class="panel" id="forecast-review" aria-labelledby="forecast-review-title">
    <h3 id="forecast-review-title">과거 예측과 실제 가격 비교</h3>
    <p class="fr-note">2026년 10월 5일까지의 고정 연구 결과 · 미래 전망이나 자동 갱신 예측이 아닙니다.</p>${caution}
    <div class="fr-controls"><label hidden>품목 <select id="fr-item"></select></label><label>예측 거리 <select id="fr-horizon"><option value="1">내일</option><option value="3">3일 뒤</option><option value="7">7일 뒤</option></select></label></div>
    <p id="fr-status" role="status">비교 자료를 불러오는 중입니다.</p><div id="fr-content"></div>
    <p class="fr-note">각 점은 서로 다른 기준일에서 직전 완료 21일로 학습한 예측입니다. 당일 미완성 자료는 제외했고, 목표는 하루 수량 가중평균(VWAP)입니다. 현재 가격 그래프의 수량 가중 중앙값과 기준이 다릅니다. 이상치 제거는 적용하지 않았습니다. API 관측 체결은 전체 거래를 포함하지 못할 수 있습니다. <a href="research.html#forecast-review">다른 품목의 예측 비교 →</a></p>
  </section>`;
}
function legend(){
  return `<div class="fr-legend">${['actual','last','arima110','weekday_arima'].map(k=>`<span class="fr-key"><svg width="30" height="8" viewBox="0 0 30 8" aria-hidden="true"><line x1="0" x2="30" y1="4" y2="4" class="fr-line fr-s-${k}" stroke-width="2.5"${dash[k]?` stroke-dasharray="${dash[k]}"`:''}/></svg>${k==='actual'?'실제 가격':labels[k]}</span>`).join('')}<span class="fr-key"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5" class="fr-dot failed fr-s-last" stroke-width="2"/></svg>적합 실패 → 마지막 가격 대체</span></div>`;
}
function chart(name,rows,W){
  const compact=W<520;
  const L=compact?74:88,R=compact?14:22,T=14,B=compact?42:46,H=compact?260:300;
  const values=rows.flatMap(r=>[r.actual,...Object.values(r.pred)]);
  const {ticks,lo,hi}=niceTicks(Math.min(...values),Math.max(...values),compact?5:6);
  const dates=rows.map(r=>Date.parse(r.target)),start=dates[0],span=dates.at(-1)-start;
  const x=i=>span?L+(dates[i]-start)/span*(W-L-R):(L+W-R)/2;
  const y=v=>T+(hi-v)/(hi-lo)*(H-T-B);
  let svg=`<svg class="fr-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(name)} 과거 예측과 실제 가격 비교. 아래 표에서 수치를 확인할 수 있습니다.">`;
  for(const v of ticks){
    const py=y(v);
    svg+=`<line class="fr-grid" x1="${L}" x2="${W-R}" y1="${py}" y2="${py}"/><text class="fr-axis" x="${L-10}" y="${py+4}" text-anchor="end">${format(v)}</text>`;
  }
  for(const key of ['last','arima110','weekday_arima','actual']){
    const value=r=>key==='actual'?r.actual:r.pred[key];
    const attrs=`class="fr-line fr-s-${key}" stroke-width="2"${dash[key]?` stroke-dasharray="${dash[key]}"`:''}`;
    // Calendar gaps remain gaps; never imply observations across missing dates.
    for(let i=1;i<rows.length;i++)if(dates[i]-dates[i-1]===86400000)
      svg+=`<line x1="${x(i-1)}" y1="${y(value(rows[i-1]))}" x2="${x(i)}" y2="${y(value(rows[i]))}" ${attrs}/>`;
    rows.forEach((r,i)=>{
      const failed=r.failed.includes(key);
      svg+=`<circle class="fr-dot fr-s-${key}${failed?' failed':''}" cx="${x(i)}" cy="${y(value(r))}" r="${failed?6:3.5}" stroke-width="2"><title>${r.target} ${key==='actual'?'실제 가격':labels[key]} ${format(value(r))}골드${failed?' · 적합 실패로 마지막 가격 대체':''}</title></circle>`;
    });
  }
  const every=Math.ceil(rows.length/(compact?3:6)),shown=new Set([0]);
  for(let i=every;i<rows.length;i+=every)shown.add(i);
  if(rows.length-1-Math.max(...shown)>=every/2)shown.add(rows.length-1);
  shown.forEach(i=>{svg+=`<text class="fr-axis" x="${x(i)}" y="${H-16}" text-anchor="middle">${rows[i].target.slice(5).replace('-','/')}</text>`;});
  return svg+'</svg>';
}
function scoreBoard(scores,n){
  return `<div class="fr-scores">${Object.entries(scores).map(([m,s])=>`<div><span>${labels[m]} · 평균 오차</span><strong>${s.mape.toFixed(2)}%</strong><span>${m==='last'?'비교 기준':`기준보다 나은 날 ${s.wins}/${n}`}</span>${m==='last'?'':`<span>적합 실패 ${s.failures}/${n}건</span>`}</div>`).join('')}</div>`;
}
function summaryHTML(items){
  const body=overview(items).map(o=>{
    const comparable=o.n>=MIN_COMPARABLE;
    const cell=m=>o.n<3?'—':`${o.scores[m].mape.toFixed(2)}%${m==='last'?'':` (${o.scores[m].wins}/${o.n})`}`;
    return `<tr${comparable?'':' class="fr-dim"'}><th scope="row">${escape(o.name)}</th><td>${horizonLabel[o.h]}</td><td>${o.n}${comparable?'':' †'}</td>${forecastModels.map(m=>`<td>${cell(m)}</td>`).join('')}</tr>`;
  }).join('');
  return `<h3>9개 조합 전체 결과</h3><div class="fr-table"><table><caption>평균 오차 · 괄호는 마지막 가격 유지보다 오차가 작았던 날 수 · † 평가 ${MIN_COMPARABLE}건 미만은 참고용 · 3건 미만은 값을 표시하지 않음</caption><thead><tr><th>품목</th><th>예측 거리</th><th>평가 수</th>${forecastModels.map(m=>`<th>${labels[m]}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="fr-note">아래에서 고르는 한 조합만 보면 가장 유리한 칸을 고른 것처럼 보일 수 있어 전체를 먼저 보여 드립니다. 평가 구간이 겹치고 같은 시장의 품목이라 9칸은 독립된 9번의 시험이 아닙니다.</p>`;
}
export async function mountForecastReview(root,id){
if(!root)return;
const item=root.querySelector('#fr-item'),horizon=root.querySelector('#fr-horizon');
const status=root.querySelector('#fr-status'),content=root.querySelector('#fr-content');
const summary=id?null:root.querySelector('#fr-summary');
let data,lastWidth=0;
function render(){
  const selected=data.items[Number(item.value)];
  const rows=selected.rows.filter(r=>r.h===Number(horizon.value)).sort((a,b)=>a.target.localeCompare(b.target));
  if(!rows.length){status.textContent='이 거리의 평가 자료가 없습니다.';content.replaceChildren();return;}
  const comparable=rows.length>=MIN_COMPARABLE;
  status.textContent=`${rows[0].target} ~ ${rows.at(-1).target} · ${rows.length}건 평가${comparable?' · 낮은 오차가 더 좋습니다.':` · ${MIN_COMPARABLE}건(한 주)보다 적어 평균 오차는 비교하지 않습니다.`}`;
  // 숨겨진 탭에서는 너비가 0이라 기본 너비로 그리고, 보이는 순간 ResizeObserver가 다시 그린다.
  const W=Math.round(Math.min(880,Math.max(300,content.clientWidth||880)));
  lastWidth=content.clientWidth;
  content.innerHTML=`${comparable?scoreBoard(comparisonSummary(rows),rows.length):`<p class="fr-low" role="note">평가가 ${rows.length}건뿐이라 평균 오차를 표시하지 않습니다. 아래 표의 날짜별 수치만 확인하세요.</p>`}
    ${rows.length>=3?`${legend()}<div class="fr-plot">${chart(selected.name,rows,W)}</div>
    <p class="fr-note">두 ARIMA의 차수는 (1,1,0), 드리프트 없음입니다. 요일 추가 모델만 월~토 변수 6개를 사용합니다. 적합 실패 시 마지막 가격으로 대체한 결과도 오차에 포함합니다.</p>`:''}
    <details${rows.length<3?' open':''}><summary>날짜별 수치·예측 기준일 확인</summary><div class="fr-table"><table><caption>단위: 골드 · * 적합 실패로 마지막 가격 대체</caption><thead><tr><th>목표일</th><th>예측 기준일</th><th>실제</th><th>마지막 가격</th><th>일반 ARIMA</th><th>요일 추가 ARIMA</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r.target}</td><td>${r.origin}</td><td>${format(r.actual)}</td>${['last','arima110','weekday_arima'].map(m=>`<td>${format(r.pred[m])}${r.failed.includes(m)?' *':''}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
try{
  dataPromise??=fetch('forecast-review.json?v=20261007').then(response=>{
    if(!response.ok)throw new Error('fetch');return response.json();
  }).catch(error=>{dataPromise=null;throw error;});
  data=await dataPromise;
  if(!root.isConnected)return;
  item.replaceChildren(...data.items.map((i,index)=>new Option(i.name,String(index))));
  if(id){
    const index=data.items.findIndex(i=>i.name===forecastItemNames[id]);
    if(index<0)throw new Error('item');
    item.value=String(index);
  }
  if(summary)summary.innerHTML=summaryHTML(data.items);
  item.addEventListener('change',render);horizon.addEventListener('change',render);render();
  if(typeof ResizeObserver==='function')new ResizeObserver(()=>{
    if(content.clientWidth&&Math.abs(content.clientWidth-lastWidth)>8)render();
  }).observe(content);
}catch{status.textContent='예측 비교 자료를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.';}
}
mountForecastReview(document.querySelector('[data-forecast-review]'));
