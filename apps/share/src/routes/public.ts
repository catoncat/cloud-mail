import { Hono } from "hono";
import { messagesByMailbox, toLatest } from "../lib/intake";
import * as store from "../lib/store";
import type { Env, LatestMessage } from "../lib/types";
import { isValidLinkId, normalizeMailbox } from "../lib/validate";

export const publicRoutes = new Hono<{ Bindings: Env }>();

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function csv(mailbox: string, latest: LatestMessage | null): string {
  const cols = ["mailbox", "code", "subject", "from", "received_at"];
  const row = [mailbox, latest?.code ?? "", latest?.subject ?? "", latest?.from ?? "", latest?.receivedAt ?? ""];
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return `${cols.join(",")}\n${row.map(esc).join(",")}`;
}

/** Minimal, dependency-free page. Recipients only need the code. */
function inboxPage(mailbox: string, latestUrl: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#18181b"><meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(mailbox)}</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#fafafa;color:#18181b;display:grid;place-items:start center;padding:28px 16px 48px}
main{width:100%;max-width:440px}
.addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#71717a;word-break:break-all;margin-bottom:16px;cursor:pointer}
.card{border:1px solid #e4e4e7;border-radius:12px;background:#fff;padding:26px 20px;text-align:center}
.k{font-size:12px;color:#71717a;margin-bottom:10px}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:36px;font-weight:650;letter-spacing:.12em;line-height:1.1;word-break:break-all}
.meta{margin-top:10px;font-size:12px;color:#a1a1aa}
.row{display:flex;gap:8px;margin-top:16px}
button,a.btn{flex:1;display:inline-flex;align-items:center;justify-content:center;height:38px;padding:0 14px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;color:#18181b;font:inherit;font-size:13px;font-weight:550;cursor:pointer;text-decoration:none}
button.primary{background:#18181b;border-color:#18181b;color:#fff}
button:active{transform:scale(.98)}
.empty{color:#a1a1aa;font-size:14px;padding:22px 0}
.sec{margin-top:26px}
.sec-t{font-size:12.5px;font-weight:620;color:#3f3f46;margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline}
.sec-t span{font-weight:400;color:#a1a1aa;font-size:12px}
.list{border:1px solid #e4e4e7;border-radius:10px;background:#fff;overflow:hidden}
.item{border-top:1px solid #f4f4f5}
.item-head{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer}
.item-head:hover{background:#fafafa}
.body{padding:0 12px 12px;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#3f3f46;border-top:1px dashed #e4e4e7;margin:0 12px 12px;padding-top:10px}
.arrow{color:#d4d4d8;font-size:11px;transition:transform .15s}
.arrow.open{transform:rotate(90deg)}
.item:first-child{border-top:0}
.item-main{flex:1;min-width:0}
.item-t{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-s{margin-top:2px;font-size:11.5px;color:#a1a1aa}
.pill{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:620;letter-spacing:.06em;background:#f4f4f5;border-radius:6px;padding:4px 9px;cursor:pointer;white-space:nowrap}
.pill:hover{background:#e4e4e7}
.foot{margin-top:14px;text-align:center;font-size:12px;color:#a1a1aa}
details.raw{margin-top:14px;text-align:left;border-top:1px solid #f4f4f5;padding-top:12px}
details.raw summary{font-size:12px;color:#71717a;cursor:pointer;list-style:none;user-select:none}
details.raw summary::-webkit-details-marker{display:none}
details.raw summary::before{content:'▸ ';color:#a1a1aa}
@media(prefers-color-scheme:dark){pre.rawbody{background:#09090b;color:#a1a1aa}details.raw{border-color:#27272a}}
details.raw[open] summary::before{content:'▾ '}
pre.rawbody{margin:10px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#3f3f46;background:#fafafa;border-radius:8px;padding:12px;max-height:320px;overflow:auto}
@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}.card,.list,button,a.btn{background:#18181b;border-color:#27272a;color:#fafafa}.item{border-color:#27272a}.item-head:hover{background:#27272a}.body{color:#a1a1aa;border-color:#3f3f46}button.primary{background:#fafafa;color:#09090b;border-color:#fafafa}.pill{background:#27272a}.pill:hover{background:#3f3f46}}
</style></head>
<body><main>
<div class="addr" id="addr" title="点击复制">${escapeHtml(mailbox)}</div>
<div class="card" id="card"><div class="empty">正在读取…</div></div>
<div class="sec" id="hist-sec" hidden>
  <div class="sec-t">历史验证码 <span id="hist-n"></span></div>
  <div class="list" id="hist"></div>
</div>
<div class="foot" id="foot"></div>
</main>
<script>
const URL_=${JSON.stringify(latestUrl)},MAILBOX=${JSON.stringify(mailbox)};
const card=document.getElementById('card'),foot=document.getElementById('foot');
const histSec=document.getElementById('hist-sec'),hist=document.getElementById('hist'),histN=document.getElementById('hist-n');
let lastId=null;
const cp=async t=>{try{await navigator.clipboard.writeText(t);return 1}catch{return 0}};
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function when(iso){if(!iso)return'';const d=(Date.now()-new Date(iso).getTime())/1000;
  if(d<60)return'刚刚';if(d<3600)return Math.floor(d/60)+' 分钟前';if(d<86400)return Math.floor(d/3600)+' 小时前';
  return new Date(iso).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}
function renderLatest(l){
  card.textContent='';
  if(!l){card.append(el('div','empty','还没有收到邮件'));return}
  card.append(el('div','k',l.code?'最新验证码':'最新邮件'));
  card.append(el('div',l.code?'code':'',l.code||l.subject||'无主题'));
  card.append(el('div','meta',[l.subject,when(l.receivedAt)].filter(Boolean).join(' · ')));
  const row=el('div','row');
  if(l.code){const b=el('button','primary','复制验证码');b.onclick=async()=>{b.textContent=await cp(l.code)?'已复制':'复制失败';setTimeout(()=>b.textContent='复制验证码',1400)};row.append(b)}
  if(l.link){const a=el('a','btn','打开链接');a.href=l.link;a.target='_blank';a.rel='noopener';row.append(a)}
  if(row.children.length)card.append(row);
  if(l.text){
    const wrap=el('details','raw');
    const sum=el('summary','','查看邮件原文');
    wrap.append(sum,el('pre','rawbody',l.text));
    card.append(wrap);
  }
}
function renderHistory(list){
  const rest=list.slice(1);
  if(!rest.length){histSec.hidden=true;return}
  histSec.hidden=false;histN.textContent=rest.length+' 条';
  hist.textContent='';
  for(const m of rest){
    const it=el('div','item');
    const head=el('div','item-head');
    const arrow=el('span','arrow','\u203A');
    const main=el('div','item-main');
    main.append(el('div','item-t',m.subject||'无主题'),el('div','item-s',when(m.receivedAt)));
    head.append(arrow,main);
    if(m.code){const p=el('div','pill',m.code);p.title='点击复制';
      p.onclick=async e=>{e.stopPropagation();const o=p.textContent;p.textContent=await cp(m.code)?'已复制':'失败';setTimeout(()=>p.textContent=o,1200)};
      head.append(p)}
    it.append(head);
    if(m.text){
      const body=el('div','body',m.text);
      body.hidden=true;
      it.append(body);
      head.onclick=()=>{body.hidden=!body.hidden;arrow.classList.toggle('open',!body.hidden)};
    }
    hist.append(it);
  }
}
async function tick(){
  try{
    const r=await fetch(URL_,{cache:'no-store'});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'读取失败');
    const list=d.messages||(d.latest?[d.latest]:[]);
    const top=list[0]||null;
    if(!top||top.id!==lastId){lastId=top?top.id:null;renderLatest(top);renderHistory(list)}
    foot.textContent='更新于 '+new Date().toLocaleTimeString();
  }catch(e){foot.textContent='刷新失败：'+e.message}
}
tick();setInterval(tick,4000);
document.getElementById('addr').onclick=()=>cp(MAILBOX);
</script></body></html>`;
}

publicRoutes.get("/s/:id", async (c) => {
  const id = c.req.param("id");
  const format = c.req.query("format");
  if (!isValidLinkId(id)) return c.json({ error: "not_found" }, 404);
  const record = await store.getLink(c.env, id);
  if (!record) return c.json({ error: "not_found" }, 404);

  if (format === "json" || format === "csv") {
    const items = await messagesByMailbox(c.env, record.mailbox, 20);
    const messages = items.map((m) => toLatest(m, record.mailbox));
    const latest = messages[0] ?? null;
    if (format === "csv") return c.text(csv(record.mailbox, latest), 200, { "content-type": "text/plain; charset=utf-8" });
    return c.json({ mailbox: record.mailbox, latest, messages });
  }
  return c.html(inboxPage(record.mailbox, `/s/${id}?format=json`));
});

publicRoutes.get("/", async (c) => {
  const mail = c.req.query("mail");
  if (mail === undefined) return c.redirect("/admin", 302);

  const mailbox = normalizeMailbox(mail);
  const format = c.req.query("format");
  if (!mailbox) return c.json({ error: "invalid_mailbox" }, 400);

  const record = await store.getMailbox(c.env, mailbox);
  if (!record) return c.json({ error: "not_found" }, 404);

  if (format === "json" || format === "csv") {
    const items = await messagesByMailbox(c.env, mailbox, 20);
    const messages = items.map((m) => toLatest(m, mailbox));
    const latest = messages[0] ?? null;
    if (format === "csv") return c.text(csv(mailbox, latest), 200, { "content-type": "text/plain; charset=utf-8" });
    return c.json({ mailbox, latest, messages });
  }
  return c.html(inboxPage(mailbox, `/?mail=${encodeURIComponent(mailbox)}&format=json`));
});

/** Legacy alias. */
publicRoutes.get("/all-mail", (c) => c.redirect(`/${new URL(c.req.url).search}`, 302));
