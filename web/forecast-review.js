import {comparisonSummary} from './forecast-review-model.js';
const item=document.querySelector('#fr-item'),horizon=document.querySelector('#fr-horizon');
const status=document.querySelector('#fr-status'),content=document.querySelector('#fr-content');
const labels={last:'마지막 가격 유지',arima110:'일반 ARIMA',weekday_arima:'요일 추가 ARIMA'};
const colors={actual:'#172b40',last:'#8995a5',arima110:'#b06a32',weekday_arima:'#327bfa'};
const format=n=>Math.round(n).toLocaleString('ko-KR');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data;
function render(){
  const selected=data.items[Number(item.value)];
  const rows=selected.rows.filter(r=>r.h===Number(horizon.value)).sort((a,b)=>a.target.localeCompare(b.target));
  if(!rows.length){status.textContent='이 거리의 평가 자료가 없습니다.';content.replaceChildren();return;}
  const scores=comparisonSummary(rows);
  status.textContent=`${rows[0].target} ~ ${rows.at(-1).target} · ${rows.length}건 평가 · 낮은 오차가 더 좋습니다.${rows.length<5?' 표본이 매우 적어 성능 판단에 사용할 수 없습니다.':''}`;
  const values=rows.flatMap(r=>[r.actual,...Object.values(r.pred)]);
  const low=Math.min(...values),high=Math.max(...values),pad=Math.max((high-low)*.15,high*.01);
  const min=low-pad,max=high+pad;
  const W=880,H=300,L=85,R=20,T=15,B=45;
  const dates=rows.map(r=>Date.parse(r.target)),start=dates[0],span=dates.at(-1)-start;
  const x=i=>span?L+(dates[i]-start)/span*(W-L-R):(L+W-R)/2;
  const y=v=>T+(max-v)/(max-min)*(H-T-B);
  let svg=`<svg class="fr-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(selected.name)} 과거 예측과 실제 가격 비교. 아래 표에서 수치를 확인할 수 있습니다.">`;
  for(let i=0;i<4;i++){
    const v=min+(max-min)*i/3,py=y(v);
    svg+=`<line x1="${L}" x2="${W-R}" y1="${py}" y2="${py}" stroke="#e5eaf0"/><text x="${L-10}" y="${py+4}" text-anchor="end" font-size="12" fill="#65758a">${format(v)}</text>`;
  }
  for(const key of ['last','arima110','weekday_arima','actual']){
    const value=r=>key==='actual'?r.actual:r.pred[key];
    // Calendar gaps remain gaps; never imply observations across missing dates.
    for(let i=1;i<rows.length;i++)if(dates[i]-dates[i-1]===86400000)
      svg+=`<line x1="${x(i-1)}" y1="${y(value(rows[i-1]))}" x2="${x(i)}" y2="${y(value(rows[i]))}" stroke="${colors[key]}" stroke-width="2" ${key==='actual'?'':'stroke-dasharray="5 4"'}/>`;
    rows.forEach((r,i)=>{
      const failed=r.failed.includes(key);
      svg+=`<circle cx="${x(i)}" cy="${y(value(r))}" r="${failed?6:3.5}" fill="${failed?'white':colors[key]}" stroke="${colors[key]}" stroke-width="2"><title>${r.target} ${key==='actual'?'실제 가격':labels[key]} ${format(value(r))}골드${failed?' · 적합 실패로 마지막 가격 대체':''}</title></circle>`;
    });
  }
  rows.forEach((r,i)=>{if(i===0||i===rows.length-1||i%Math.ceil(rows.length/6)===0)svg+=`<text x="${x(i)}" y="${H-16}" text-anchor="middle" font-size="12" fill="#65758a">${r.target.slice(5).replace('-','/')}</text>`;});
  svg+='</svg>';
  content.innerHTML=`<div class="fr-scores">${Object.entries(scores).map(([m,s])=>`<div><span>${labels[m]} · 평균 오차</span><strong>${s.mape.toFixed(2)}%</strong><span>적합 실패 ${s.failures}/${rows.length}건</span></div>`).join('')}</div>
    <div class="fr-legend">${Object.keys(colors).map(k=>`<span style="color:${colors[k]}">${k==='actual'?'━ 실제 가격':'┄ '+labels[k]}</span>`).join('')}<span>○ 적합 실패 → 마지막 가격 대체</span></div><div class="fr-plot" tabindex="0" aria-label="가격 비교 그래프, 좁은 화면에서는 좌우로 스크롤">${svg}</div>
    <p class="fr-note">두 ARIMA의 차수는 (1,1,0), 드리프트 없음입니다. 요일 추가 모델만 월~토 변수 6개를 사용합니다. 적합 실패 시 마지막 가격으로 대체한 결과도 오차에 포함합니다.</p>
    <details><summary>날짜별 수치·예측 기준일 확인</summary><div class="fr-table"><table><caption>단위: 골드 · * 적합 실패로 마지막 가격 대체</caption><thead><tr><th>목표일</th><th>예측 기준일</th><th>실제</th><th>마지막 가격</th><th>일반 ARIMA</th><th>요일 추가 ARIMA</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r.target}</td><td>${r.origin}</td><td>${format(r.actual)}</td>${['last','arima110','weekday_arima'].map(m=>`<td>${format(r.pred[m])}${r.failed.includes(m)?' *':''}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
try{
  const response=await fetch('forecast-review.json?v=20261007');
  if(!response.ok)throw new Error('fetch');
  data=await response.json();
  item.replaceChildren(...data.items.map((i,index)=>new Option(i.name,String(index))));
  item.addEventListener('change',render);horizon.addEventListener('change',render);render();
}catch{status.textContent='예측 비교 자료를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.';}
