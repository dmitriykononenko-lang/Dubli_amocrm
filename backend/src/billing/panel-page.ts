/* Вендор-панель «Дубли» — одностраничник, отдаётся бэкендом на GET /vendor/panel.
   Данные берёт с /vendor/billing/* по сессионной cookie (credentials:include). */
export const PANEL_HTML = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Дубли — подписки</title>
<style>
  :root{--ink:#141414;--red:#d22730;--line:#e6e6e6;--muted:#6b6b6b;--ok:#1a7f37;--warn:#b26a00}
  *{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--ink);background:#fafafa}
  header{background:var(--ink);color:#fff;padding:12px 18px;display:flex;align-items:center;gap:12px}
  header b{font-size:16px}header .sp{flex:1}
  header .dot{width:10px;height:10px;border-radius:50%;background:var(--red)}
  main{padding:18px;max-width:1200px;margin:0 auto}
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  input,select,button{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:#fff}
  button{cursor:pointer}button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
  button.red{background:var(--red);color:#fff;border-color:var(--red)}
  button.sm{padding:4px 8px;font-size:12px;border-radius:6px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  th{background:#f3f3f3;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}
  tr:hover td{background:#fcfcfc}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
  .st-active{color:var(--ok);border-color:#bfe3c6}.st-trial{color:#0b63c4;border-color:#bcd9f5}
  .st-awaiting_invoice_payment{color:var(--warn);border-color:#f2d9a8}
  .st-past_due,.st-canceled{color:var(--red);border-color:#f3c2c4}
  .days-neg{color:var(--red);font-weight:600}.days-soon{color:var(--warn);font-weight:600}
  .row-actions{display:flex;gap:4px;flex-wrap:wrap}
  .sub{cursor:pointer;color:var(--ink);text-decoration:underline dotted}
  #login{max-width:320px;margin:12vh auto;background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px}
  #login h1{font-size:18px;margin:0 0 14px}#login input{width:100%;margin-bottom:10px}
  #login .err{color:var(--red);font-size:13px;min-height:18px}
  dialog{border:none;border-radius:12px;padding:0;max-width:640px;width:92%}
  dialog .hd{background:var(--ink);color:#fff;padding:12px 16px;display:flex;align-items:center}
  dialog .hd .sp{flex:1}dialog .bd{padding:16px;max-height:60vh;overflow:auto}
  .muted{color:var(--muted)}.tabs{display:flex;gap:6px;margin:10px 0}
  .tabs button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
  .empty{padding:24px;text-align:center;color:var(--muted)}
</style></head><body>

<div id="login" hidden>
  <h1>Дубли — вход оператора</h1>
  <input id="lu" placeholder="Логин" autocomplete="username">
  <input id="lp" type="password" placeholder="Пароль" autocomplete="current-password">
  <div class="err" id="lerr"></div>
  <button class="primary" style="width:100%" onclick="login()">Войти</button>
</div>

<div id="app" hidden>
  <header><span class="dot"></span><b>Дубли</b> <span class="muted">управление подписками</span>
    <span class="sp"></span><button class="sm" onclick="logout()">Выйти</button></header>
  <main>
    <div class="filters">
      <input id="q" placeholder="поиск по субдомену" oninput="debounced()">
      <select id="status" onchange="load()">
        <option value="">все статусы</option>
        <option value="trial">trial</option><option value="active">active</option>
        <option value="awaiting_invoice_payment">ждут счёт</option>
        <option value="past_due">past_due</option><option value="canceled">canceled</option>
      </select>
      <select id="exp" onchange="load()">
        <option value="">срок: любой</option>
        <option value="7">истекают ≤ 7 дн</option><option value="14">≤ 14 дн</option><option value="30">≤ 30 дн</option>
      </select>
      <button class="sm" onclick="quickAwaiting()">Ожидают оплаты по счёту</button>
      <span class="sp" style="flex:1"></span>
      <button class="sm" onclick="load()">Обновить</button>
    </div>
    <table><thead><tr>
      <th>Субдомен</th><th>Статус</th><th>Метод</th><th>Оплачено до</th><th>Grace</th>
      <th>Триал</th><th>Дней</th><th>Посл. платёж</th><th>Действия</th>
    </tr></thead><tbody id="rows"></tbody></table>
    <div class="empty" id="empty" hidden>Ничего не найдено</div>
  </main>
</div>

<dialog id="dlg"><div class="hd"><b id="dtitle"></b><span class="sp"></span>
  <button class="sm" onclick="dlg.close()">✕</button></div><div class="bd" id="dbody"></div></dialog>

<script>
const $=s=>document.querySelector(s), rows=$('#rows'), dlg=$('#dlg');
const fmt=d=>d?new Date(d).toLocaleDateString('ru-RU'):'—';
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(path,opts={}){const r=await fetch(path,{credentials:'include',headers:{'Content-Type':'application/json'},...opts});
  if(r.status===401){showLogin();throw new Error('401')} if(!r.ok)throw new Error(await r.text().catch(()=>r.status));
  return r.status===204?null:r.json()}
function showLogin(){$('#app').hidden=true;$('#login').hidden=false}
function showApp(){$('#login').hidden=true;$('#app').hidden=false}
async function login(){$('#lerr').textContent='';
  try{await api('/vendor/panel/login',{method:'POST',body:JSON.stringify({user:$('#lu').value,password:$('#lp').value})});showApp();load()}
  catch(e){$('#lerr').textContent='Неверный логин или пароль'}}
async function logout(){try{await api('/vendor/panel/logout',{method:'POST'})}catch(e){}showLogin()}
let t;function debounced(){clearTimeout(t);t=setTimeout(load,300)}
function quickAwaiting(){$('#status').value='awaiting_invoice_payment';$('#exp').value='';load()}
function daysCell(n){if(n==null)return '—';const c=n<0?'days-neg':n<=7?'days-soon':'';return '<span class="'+c+'">'+n+'</span>'}
async function load(){
  const p=new URLSearchParams();const q=$('#q').value.trim(),s=$('#status').value,e=$('#exp').value;
  if(q)p.set('query',q);if(s)p.set('status',s);if(e)p.set('expiring_in_days',e);p.set('limit','200');
  let data=[];try{data=await api('/vendor/billing/subscriptions?'+p)}catch(err){if(String(err.message)==='401')return}
  showApp();$('#empty').hidden=data.length>0;
  rows.innerHTML=data.map(r=>{
    const sub=esc(r.subdomain);
    return '<tr><td><span class="sub" onclick="card(\\''+sub+'\\')">'+sub+'</span></td>'+
      '<td><span class="pill st-'+r.status+'">'+r.status+'</span></td>'+
      '<td>'+(r.paymentMethod||'none')+'</td><td>'+fmt(r.paidTill)+'</td><td>'+fmt(r.graceUntil)+'</td>'+
      '<td>'+fmt(r.trialEndsAt)+'</td><td>'+daysCell(r.daysLeft)+'</td>'+
      '<td>'+(r.lastAmount!=null?r.lastAmount+' ₽':'—')+'</td>'+
      '<td><div class="row-actions">'+
        '<button class="sm" onclick="extend(\\''+sub+'\\')">продлить</button>'+
        '<button class="sm" onclick="act(\\''+sub+'\\',\\'suspend\\')">стоп</button>'+
        '<button class="sm" onclick="act(\\''+sub+'\\',\\'resume\\')">снять</button>'+
      '</div></td></tr>';
  }).join('');
}
async function extend(sub){
  const v=prompt('Продлить '+sub+': введите число месяцев (напр. 3) ИЛИ дату YYYY-MM-DD');
  if(!v)return;const body=/^\\d{4}-\\d{2}-\\d{2}/.test(v)?{paid_till:new Date(v+'T23:59:59Z').toISOString()}:{add_months:Number(v)};
  body.reason=prompt('Причина (для аудита):')||'panel';
  try{await api('/vendor/billing/subscriptions/'+encodeURIComponent(sub)+'/extend',{method:'POST',body:JSON.stringify(body)});load()}catch(e){alert('Ошибка: '+e.message)}
}
async function act(sub,a){if(!confirm(a+' '+sub+'?'))return;const body=a==='suspend'?{reason:prompt('Причина:')||'panel'}:{};
  try{await api('/vendor/billing/subscriptions/'+encodeURIComponent(sub)+'/'+a,{method:'POST',body:JSON.stringify(body)});load()}catch(e){alert('Ошибка: '+e.message)}}
async function markPaid(num){if(!confirm('Отметить счёт '+num+' оплаченным?'))return;
  try{await api('/vendor/billing/invoices/'+encodeURIComponent(num)+'/mark-paid',{method:'POST',body:JSON.stringify({actor:'panel'})});card(cardSub);load()}catch(e){alert('Ошибка: '+e.message)}}
async function toggleRenew(sub,on){try{await api('/vendor/billing/subscriptions/'+encodeURIComponent(sub)+'/auto-renew',{method:'POST',body:JSON.stringify({enabled:on})});card(sub)}catch(e){alert('Ошибка: '+e.message)}}
let cardSub='';
async function card(sub){cardSub=sub;let d;try{d=await api('/vendor/billing/subscriptions/'+encodeURIComponent(sub))}catch(e){return}
  $('#dtitle').textContent=sub;
  const pays=(d.payments||[]).map(p=>'<tr><td>'+fmt(p.at)+'</td><td>'+p.source+'</td><td>'+(p.amount!=null?p.amount+' ₽':'—')+'</td><td>'+(p.months||'')+'</td><td>'+esc(p.reason||'')+'</td><td>'+esc(p.actor||'')+'</td></tr>').join('')||'<tr><td colspan=6 class="muted">нет</td></tr>';
  const invs=(d.invoices||[]).map(i=>'<tr><td>'+esc(i.number)+'</td><td>'+(i.amount!=null?i.amount+' ₽':'—')+'</td><td>'+(i.periodMonths||'')+' мес</td><td>'+i.status+'</td><td>'+(i.status!=='paid'?'<button class="sm red" onclick="markPaid(\\''+esc(i.number)+'\\')">оплачен</button>':fmt(i.paidAt))+'</td></tr>').join('')||'<tr><td colspan=5 class="muted">нет</td></tr>';
  $('#dbody').innerHTML=
    '<p><b>Статус:</b> '+d.status+' · <b>Метод:</b> '+(d.paymentMethod||'none')+' · <b>Доступ:</b> '+(d.allowed?'✔':'✖')+'<br>'+
    '<b>Оплачено до:</b> '+fmt(d.paidTill)+' · <b>Grace:</b> '+fmt(d.graceUntil)+' · <b>Триал:</b> '+fmt(d.trialEndsAt)+'</p>'+
    '<div class="tabs"><button class="sm" onclick="toggleRenew(\\''+esc(sub)+'\\',true)">auto-renew ON</button>'+
      '<button class="sm" onclick="toggleRenew(\\''+esc(sub)+'\\',false)">OFF</button></div>'+
    '<h4>Счета</h4><table><thead><tr><th>Номер</th><th>Сумма</th><th>Период</th><th>Статус</th><th></th></tr></thead><tbody>'+invs+'</tbody></table>'+
    '<h4 style="margin-top:14px">Платежи</h4><table><thead><tr><th>Дата</th><th>Источник</th><th>Сумма</th><th>Мес</th><th>Причина</th><th>Актор</th></tr></thead><tbody>'+pays+'</tbody></table>';
  dlg.showModal();
}
load();
</script></body></html>`;
