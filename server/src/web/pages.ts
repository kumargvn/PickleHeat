// HTML pages the API serves itself: the one-time DUPR connect page and the DUPR stand-in login.
import { escapeHtml } from "../http";

export function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{margin:0;background:#0A0F24;color:#F4F6FF;font:16px/1.45 -apple-system,system-ui,Inter,sans-serif;min-height:100vh;display:flex;flex-direction:column}
header{padding:16px 20px;font-weight:700;font-size:20px;letter-spacing:-.3px}header b{color:#D4FF3A}
main{flex:1;display:flex;flex-direction:column;padding:0 16px 24px;gap:12px}
iframe{flex:1;width:100%;min-height:640px;border:0;border-radius:18px;background:#fff}
.card{background:#141B38;border:1px solid #2A3466;border-radius:18px;padding:18px}
button,a.btn{display:block;width:100%;height:52px;border:0;border-radius:16px;background:#D4FF3A;color:#0A0F24;font-weight:700;font-size:17px;text-align:center;line-height:52px;text-decoration:none}
.muted{color:#A9B1D6}.err{color:#FF8A6E}
</style></head><body><header>Pickle<b>Heat</b></header><main>${body}</main>${script}</body></html>`;
}

export function duprConnectPage(ssoUrl: string, connectToken: string, doneUrl: string, apiBase: string): string {
  const origin = new URL(ssoUrl).origin;
  return page(
    "Connect DUPR",
    `<p class="muted" id="msg">Log in to DUPR to connect it to PickleHeat. You only do this once.</p>
<iframe id="dupr" src="${escapeHtml(ssoUrl)}" allow="payment" title="DUPR login"></iframe>`,
    `<script>
(function(){
  var msg=document.getElementById('msg');
  window.addEventListener('message', function(ev){
    if (ev.origin !== ${JSON.stringify(origin)}) return;
    var d = ev.data || {};
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    var token = d.userToken || d.accessToken; var refresh = d.refreshToken;
    if (!token || !refresh) return;
    msg.textContent='Connecting your DUPR account…';
    fetch(${JSON.stringify(apiBase + "/v1/dupr/link")}, {method:'POST', headers:{'content-type':'application/json','authorization':'Bearer '+${JSON.stringify(connectToken)}}, body: JSON.stringify({userToken: token, refreshToken: refresh})})
      .then(function(r){ return r.json().then(function(b){ if(!r.ok) throw new Error(b.error||'Could not connect'); return b; }); })
      .then(function(){ location.replace(${JSON.stringify(doneUrl)} + '?status=connected'); })
      .catch(function(e){ msg.className='err'; msg.textContent=e.message+' Try again.'; });
  }, false);
})();
</script>`,
  );
}

