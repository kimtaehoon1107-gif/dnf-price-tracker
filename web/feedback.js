const endpoint='https://ypmnadqnmadrburkrcka.supabase.co/functions/v1/feedback';
const $=id=>document.getElementById(id);
const categories={bug:'오류 제보',idea:'기능 제안',general:'자유 의견'};
const statuses={open:'접수',reviewing:'검토 중',done:'반영 완료',closed:'보류'};
let adminPassword='', adminTimer, post=null, editing=false, cursors=[null], nextCursor=null, generation=0;
const date=value=>new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})+' KST';
function node(tag,text,cls) { const el=document.createElement(tag); if(text!=null) el.textContent=text; if(cls) el.className=cls; return el; }
function badge(text,cls='') { return node('span',text,`fb-badge ${cls}`); }
function badges(p) { const result=[badge(categories[p.category]),badge(statuses[p.status],p.status)]; if(p.hidden) result.push(badge('숨김','hidden')); return result; }
function message(text='') { $('message').textContent=text; $('message').hidden=!text; }
function screen(name) { for(const id of ['list','detail','compose']) $(`${id}-section`).hidden=id!==name; }
function field(form,name) { return form.elements.namedItem(name); }
function resetForm(form) { form.reset(); form.querySelector('.form-message').textContent=''; }
async function api(action,data={}) {
  let response;
  try {
    response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,data}),credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000)});
  } catch { throw new Error('연결을 확인해 주세요. 등록·수정 중이었다면 목록에서 반영 여부를 먼저 확인해 주세요.'); }
  let result;
  try { result=await response.json(); } catch { throw new Error('게시판 응답을 받지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
  if(!response.ok) throw new Error(result.error || '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return result;
}
const adminData=()=>adminPassword?{admin:true,adminPassword}:{};
async function submit(form,task) {
  const buttons=[...form.querySelectorAll('button')]; buttons.forEach(b=>b.disabled=true);
  const output=form.querySelector('.form-message'); output.textContent='처리 중입니다…';
  try { await task(); output.textContent=''; } catch(error) { output.textContent=error.message; }
  finally { buttons.forEach(b=>b.disabled=false); }
}
async function loadList() {
  const turn=++generation; screen('list'); message(); $('posts').replaceChildren(node('p','의견을 불러오는 중입니다…','fb-empty'));
  $('previous').disabled=true; $('next').disabled=true;
  try {
    const result=await api('list',{before:cursors.at(-1),...adminData()});
    if(turn!==generation) return;
    const rows=result.posts.slice(0,20); nextCursor=result.posts.length>20?rows.at(-1).id:null;
    $('posts').replaceChildren();
    for(const p of rows) {
      const link=node('a',null,'feedback-post'); link.href=`#${p.id}`;
      const tags=node('div',null,'fb-badges'); tags.append(...badges(p));
      if(p.answered) tags.append(badge('관리자 답변','answered'));
      link.append(tags,node('h2',p.title),node('p',`${p.nickname} · ${date(p.created_at)}`,'fb-meta'));
      $('posts').append(link);
    }
    if(!rows.length) $('posts').append(node('p','아직 등록된 의견이 없어요.\n첫 번째 피드백을 남겨 주세요.','fb-empty'));
    $('page').textContent=`${cursors.length} 페이지`;
    $('previous').disabled=cursors.length===1; $('next').disabled=!nextCursor;
  } catch(error) {
    if(turn!==generation) return;
    $('posts').replaceChildren(node('p','의견을 불러오지 못했습니다.','fb-empty')); message(error.message);
    const retry=node('button','다시 불러오기','fb-button'); retry.type='button'; retry.onclick=loadList; $('posts').append(retry);
  }
}
function showPost(value) {
  post=value; screen('detail'); message();
  $('post-badges').replaceChildren(...badges(post)); $('post-title').textContent=post.title;
  $('post-meta').textContent=`${post.nickname} · ${date(post.created_at)}${post.updated_at!==post.created_at?' · 변경 '+date(post.updated_at):''}`;
  $('post-body').textContent=post.body; $('reply-section').hidden=!post.reply;
  $('reply-body').textContent=post.reply; $('reply-date').textContent=post.replied_at?date(post.replied_at):'';
  $('owner-actions').hidden=post.hidden; $('moderation').hidden=!adminPassword;
  $('moderation-status').value=post.status; $('moderation-reply').value=post.reply; $('moderation-hidden').checked=post.hidden;
  $('moderation').querySelector('.form-message').textContent=''; $('post-title').focus();
}
async function route() {
  const id=Number(location.hash.slice(1));
  if(!Number.isSafeInteger(id) || id<1) return loadList();
  const turn=++generation; screen('list'); $('posts').replaceChildren(node('p','글을 불러오는 중입니다…','fb-empty')); message();
  try { const result=await api('detail',{id,...adminData()}); if(turn===generation) showPost(result.post); }
  catch(error) { if(turn===generation) { screen('list'); $('posts').replaceChildren(node('p',error.message,'fb-empty')); const back=node('button','목록으로','fb-button'); back.onclick=goList; $('posts').append(back); } }
}
function goList() { generation++; if(location.hash) location.hash=''; else loadList(); }
function compose(isEdit) {
  generation++; editing=isEdit; const form=$('compose'); resetForm(form);
  if(isEdit) for(const key of ['nickname','category','title','body']) field(form,key).value=post[key];
  $('compose-title').textContent=isEdit?'글 수정':'의견 남기기'; $('compose-submit').textContent=isEdit?'수정 저장':'등록하기';
  $('post-password').autocomplete=isEdit?'current-password':'new-password'; screen('compose'); message(); $('compose-title').focus();
}
$('write').onclick=()=>compose(false);
$('edit').onclick=()=>compose(true);
document.querySelectorAll('.back-list').forEach(b=>b.onclick=goList);
$('compose-cancel').onclick=()=>{ resetForm($('compose')); editing&&post?showPost(post):goList(); };
$('previous').onclick=()=>{cursors.pop(); loadList();};
$('next').onclick=()=>{if(nextCursor){cursors.push(nextCursor); loadList();}};
$('compose').onsubmit=event=>{
  event.preventDefault(); const form=event.currentTarget;
  submit(form,async()=>{
    const data=Object.fromEntries(new FormData(form));
    if(editing) Object.assign(data,{id:post.id,version:post.updated_at});
    const result=await api(editing?'edit':'create',data); resetForm(form);
    if(location.hash===`#${result.post.id}`) showPost(result.post); else location.hash=String(result.post.id);
  });
};
$('delete').onclick=()=>{resetForm($('delete-form')); $('delete-dialog').showModal();};
$('delete-cancel').onclick=()=>{$('delete-dialog').close(); resetForm($('delete-form'));};
$('delete-dialog').addEventListener('close',()=>resetForm($('delete-form')));
$('delete-form').onsubmit=event=>{
  event.preventDefault(); const form=event.currentTarget;
  submit(form,async()=>{await api('delete',{id:post.id,version:post.updated_at,password:field(form,'password').value}); $('delete-dialog').close(); resetForm(form); post=null; cursors=[null]; goList();});
};
function logout() {
  clearTimeout(adminTimer); adminPassword=''; $('admin-toggle').textContent='관리자'; $('admin-notice').hidden=true;
  resetForm($('admin-form')); $('moderation').hidden=true; cursors=[null]; route();
}
$('admin-toggle').onclick=()=>{if(adminPassword) logout(); else {resetForm($('admin-form')); $('admin-dialog').showModal();}};
$('admin-cancel').onclick=()=>{$('admin-dialog').close(); resetForm($('admin-form'));};
$('admin-dialog').addEventListener('close',()=>resetForm($('admin-form')));
$('admin-form').onsubmit=event=>{
  event.preventDefault(); const form=event.currentTarget;
  submit(form,async()=>{
    const password=field(form,'password').value; await api('admin-login',{adminPassword:password}); adminPassword=password;
    resetForm(form); $('admin-dialog').close(); $('admin-toggle').textContent='관리자 로그아웃'; $('admin-notice').hidden=false;
    clearTimeout(adminTimer); adminTimer=setTimeout(logout,20*60*1000); cursors=[null]; await route();
  });
};
$('moderation').onsubmit=event=>{
  event.preventDefault(); const form=event.currentTarget;
  submit(form,async()=>{const result=await api('moderate',{id:post.id,version:post.updated_at,adminPassword,status:$('moderation-status').value,reply:$('moderation-reply').value,hidden:$('moderation-hidden').checked}); showPost(result.post);});
};
window.addEventListener('hashchange',route);
window.addEventListener('pagehide',()=>{adminPassword=''; document.querySelectorAll('input[type=password]').forEach(el=>el.value='');});
window.addEventListener('pageshow',event=>{if(event.persisted) logout();});
route();
