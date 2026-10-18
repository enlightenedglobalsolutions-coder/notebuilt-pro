#!/usr/bin/env node
// Notebuilt Pro — the gate for stages 1 to 3, in a real browser.
// Copyright (c) 2026 Enlightened Global Solutions. All rights reserved.
//
// Serves this folder on 127.0.0.1 and drives index.html in real headless
// Chrome over CDP, on REAL time: --virtual-time-budget fires watchdogs before
// genuine async work, so it is never used. Node alone cannot see the things
// this checks (service worker, IndexedDB, CompressionStream, layout).
//
//   node test_pro.js                 exit 0 = every check passed
//   node test_pro.js --shots <dir>   also write screenshots into <dir>
//   node test_pro.js --bail          stop at the first failure (for mutation runs)
//
// The port is this app's fixed local-test port: a port is an origin, and a
// service worker left on a shared one serves the wrong app.
const { spawn, spawnSync } = require('child_process');
const http = require('http'), path = require('path'), os = require('os'), fs = require('fs');

const ROOT = __dirname;
const WEB = +process.env.NBPRO_TEST_PORT || 8708;      // the override is for mutation runs side by side, each in its own throwaway profile
const ORIGIN = 'http://127.0.0.1:' + WEB;
const URL0 = ORIGIN + '/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.argv.indexOf('--shots') > 0 ? path.resolve(process.argv[process.argv.indexOf('--shots') + 1]) : null;
const ID_RE = /^[A-Za-z0-9_-]{10}[AEIMQUYcgkosw048]$/;
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

const BAIL = process.argv.includes('--bail');
let fails = 0, passes = 0, bailed = false;
const ok = (c, label, extra) => { if(c) passes++; else fails++; console.log((c ? '  PASS ' : '  FAIL ') + label + (!c && extra !== undefined ? '  → ' + extra : ''));
  if(!c && BAIL && !bailed){ bailed = true; setTimeout(() => finish(1), 0); } };
const section = t => console.log('\n== ' + t + ' ==');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- static checks: no browser needed ----------------------------------------
section('Static');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
{
  const canon = path.join(ROOT, '..', '..', 'platform', 'crew_task.js');
  if(fs.existsSync(canon)){
    const B = '/* EGS-SHARED:crew-task BEGIN */\n', E = '/* EGS-SHARED:crew-task END */\n';
    const a = HTML.indexOf(B), b = HTML.indexOf(E);
    ok(a > 0 && b > a && HTML.slice(a, b + E.length) === fs.readFileSync(canon, 'utf8'), 'crew-task copy is byte-identical to the platform source');
    ok(fs.readFileSync(path.join(ROOT, 'sw_logic.js'), 'utf8') === fs.readFileSync(path.join(ROOT, '..', '..', 'platform', 'sw_logic.js'), 'utf8'), 'sw_logic.js is a straight copy of the platform file');
    const strip = s => s.replace(/const APP_NAME\s*=\s*'[^']*';/, '').replace(/const CACHE_VERSION = '[^']*';\s*/, '');
    ok(strip(fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8')).replace(/\s+/g, ' ') === strip(fs.readFileSync(path.join(ROOT, '..', '..', 'platform', 'service-worker.js'), 'utf8')).replace(/\s+/g, ' '), 'service-worker.js differs from the platform file only in APP_NAME and CACHE_VERSION');
  } else console.log('  SKIP platform folder not beside this repo: copy checks not run');
  const mk = spawnSync(process.execPath, [path.join(ROOT, 'make_icons.js'), '--check-mark'], { encoding:'utf8' });
  ok(mk.status === 0, 'PRO_MARK matches the icon geometry in make_icons.js', (mk.stdout || '').trim());
  ok(!/onclick=/.test(HTML), 'no inline onclick anywhere');
  ['skeleton','coldopen-version','install-banner','share-v2','backup','privacy-page','schema','themes','infomode','support']
    .forEach(m => ok(HTML.indexOf('EGS-STD:' + m) >= 0, 'marker EGS-STD:' + m));
  ok(HTML.indexOf('EGS-STD:apps-directory') < 0 && HTML.indexOf('EGS-STD:gate') < 0, 'no marker on a row the app does not meet: apps-directory (no deploy sync exists) and gate (no price yet)');
  const keys = HTML.match(/'notebuiltpro[^']*'/g) || [];
  ok(keys.length >= 9 && keys.every(k => k === "'notebuiltpro'" || k.indexOf("'notebuiltpro.") === 0), 'every storage name is notebuiltpro or notebuiltpro.*');
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  ok(man.icons.length === 3 && man.icons.every(i => fs.existsSync(path.join(ROOT, i.src))) && man.icons.some(i => i.purpose === 'maskable'), 'manifest wires the committed icons, maskable included');
  ok(fs.existsSync(path.join(ROOT, 'icons', 'icon-180.png')) && HTML.indexOf('icons/icon-180.png') > 0, 'apple-touch icon wired');
  ok(/const APP_NAME\s*=\s*'notebuilt-pro'/.test(fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8')), 'service worker cache is named for this app');
}

// ---- server + browser ---------------------------------------------------------
// The stage 3 build, as it went live, served at /stage3/ on the same origin, so
// it shares this build's storage the way a second tab on the phone does. It
// still holds 128-bit IDs and reads the crew and jobs with no version gate of
// its own; the checks that use it can go once no stage 3 build is left running.
const STAGE3_REV = '3568279';
const STAGE3 = (() => { const g = spawnSync('git', ['-C', ROOT, 'show', STAGE3_REV + ':index.html'], { encoding:'utf8' }); return g.status === 0 ? g.stdout : null; })();
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if(p === '/') p = '/index.html';
  if(p === '/stage3/' || p === '/stage3/index.html'){
    if(!STAGE3){ r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type':TYPES['.html'], 'cache-control':'no-store' }); r.end(STAGE3); return;
  }
  if(p.indexOf('/stage3/') === 0) p = p.slice(7);
  const f = path.join(ROOT, p);
  if(f.indexOf(ROOT) !== 0 || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type':TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control':'no-store' });
  r.end(fs.readFileSync(f));
});
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'nbpro-chrome-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nbpro-files-'));
let chrome = null;
const finish = code => {
  try { srv.closeAllConnections(); srv.close(); } catch(e){}
  const done = () => { [prof, work].forEach(d => { try { fs.rmSync(d, { recursive:true, force:true, maxRetries:5 }); } catch(e){} }); process.exit(code); };
  if(chrome){ chrome.once('exit', done); chrome.kill(); } else done();
};
setTimeout(() => { console.log("FAIL timed out"); finish(1); }, 480000);

srv.listen(WEB, '127.0.0.1', () => run().catch(e => { console.log('FAIL ' + (e && e.stack || e)); finish(1); }));
srv.on('error', e => { console.log('FAIL cannot serve on 127.0.0.1:' + WEB + ' (' + e.code + ')'); process.exit(1); });

async function run(){
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    // A fresh profile fetches Chrome's own component updates in the background,
    // and with downloads pointed at `work` those land there too. Switched off.
    '--disable-component-update', '--disable-background-networking',
    '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio:'ignore' });
  let port = null;
  for(let i = 0; i < 100 && !port; i++){ await sleep(100); try { port = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch(e){} }
  if(!port){ console.log('FAIL no chrome'); return finish(1); }
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find(t => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let seq = 0; const pending = {};
  const dialogs = { answer:true, seen:[] }, requests = [], errors = [];
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq;
    pending[id] = m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result);
    ws.send(JSON.stringify({ id, method, params:params || {} })); });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if(m.id && pending[m.id]){ pending[m.id](m); delete pending[m.id]; return; }
    if(m.method === 'Page.javascriptDialogOpening'){ dialogs.seen.push(m.params.message); send('Page.handleJavaScriptDialog', { accept:dialogs.answer }).catch(() => {}); }
    if(m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
    if(m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if(m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error ' + JSON.stringify(m.params.args).slice(0, 200));
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('DOM.enable');
  await send('Browser.setDownloadBehavior', { behavior:'allow', downloadPath:work });

  const ev = async expr => { const m = await send('Runtime.evaluate', { expression:expr, returnByValue:true, awaitPromise:true });
    if(m.exceptionDetails) throw new Error((m.exceptionDetails.exception && m.exceptionDetails.exception.description || JSON.stringify(m.exceptionDetails)).slice(0, 400) + '  in  ' + expr.slice(0, 120));
    return m.result.value; };
  const until = async (expr, ms, what) => { const t = Date.now(); for(;;){ const v = await ev(expr); if(v) return v; if(Date.now() - t > (ms || 8000)) throw new Error('timeout: ' + (what || expr) + (errors.length ? '  [last page error: ' + errors[errors.length - 1] + ']' : '')); await sleep(50); } };
  const q = s => JSON.stringify(s);
  const size = (w, h) => send('Emulation.setDeviceMetricsOverride', { width:w, height:h, deviceScaleFactor:1, mobile:true });
  const scheme = v => send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-color-scheme', value:v }] });
  const ready = () => until('document.readyState==="complete" && typeof render==="function" && !!document.querySelector("#app > *")', 10000, 'app painted');
  // One tab runs the whole suite. Chrome keeps at most 50 history entries, and
  // when it is full it drops entries that were made without a tap first: under
  // a script, that is every entry this app seeds beneath a cold open. So each
  // cold open starts from an empty history, as a freshly opened app does.
  const blank = async () => { await send('Page.navigate', { url:'about:blank' });
    for(let i = 0; ; i++){ try { await ev('location.href==="about:blank"||(function(){throw new Error("not yet")})()'); await send('Page.resetNavigationHistory'); return; } catch(e){ if(i > 60) throw e; await sleep(25); } } };
  const load = async hash => { await blank(); await send('Page.navigate', { url:URL0 + (hash || '') }); await sleep(80); await ready(); };
  const reload = async () => { await send('Page.reload'); await sleep(120); await ready(); };
  const wipe = async () => { await blank(); await send('Storage.clearDataForOrigin', { origin:ORIGIN, storageTypes:'all' }); };
  const snap = () => ev('JSON.stringify(Object.keys(localStorage).sort().map(function(k){return [k,localStorage.getItem(k)]}))');
  const raw = k => ev('localStorage.getItem(' + q(k) + ')');
  const click = sel => ev('(function(){var e=document.querySelector(' + q(sel) + ');if(!e)throw new Error("no element ' + sel.replace(/"/g, "'") + '");e.click();return true})()');
  const text = sel => ev('(function(){var e=document.querySelector(' + q(sel) + ');return e?e.textContent:null})()');
  const type = async (sel, value) => { await ev('(function(){var i=document.querySelector(' + q(sel) + ');i.focus();i.select();return true})()');
    await send('Input.insertText', { text:value || '' });
    if(!value) await ev('(function(){var i=document.querySelector(' + q(sel) + ');i.value="";i.dispatchEvent(new Event("input",{bubbles:true}));return true})()'); };
  const shot = async name => { if(!SHOTS) return; fs.mkdirSync(SHOTS, { recursive:true });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from((await send('Page.captureScreenshot', { format:'png' })).data, 'base64')); };
  const pickFile = async (sel, file) => { const doc = await send('DOM.getDocument', { depth:0 });
    const n = await send('DOM.querySelector', { nodeId:doc.root.nodeId, selector:sel });
    if(!n.nodeId) throw new Error('no file input ' + sel);
    try { await send('DOM.setFileInputFiles', { files:[file], nodeId:n.nodeId }); }
    catch(e){ /* a redraw between the two calls leaves the node id stale: look it up again, once */
      const d2 = await send('DOM.getDocument', { depth:0 }), n2 = await send('DOM.querySelector', { nodeId:d2.root.nodeId, selector:sel });
      await send('DOM.setFileInputFiles', { files:[file], nodeId:n2.nodeId }); } };
  // Backup files sitting in the download folder. Each one a test makes is renamed at once, so this is normally none.
  const backups = () => fs.readdirSync(work).filter(f => /^notebuilt-pro-backup-/.test(f));
  const tmpFile = (name, body) => { const f = path.join(work, name); fs.writeFileSync(f, body); return f; };
  const download = async before => { const t = Date.now();
    for(;;){ const fresh = fs.readdirSync(work).filter(f => !before.includes(f) && /^notebuilt-pro-backup-.*\.json$/.test(f));
      if(fresh.length){ await sleep(150); return fresh[0]; } if(Date.now() - t > 8000) throw new Error('no backup file was downloaded'); await sleep(60); } };
  // Nothing may be wider than the screen: the page itself, or any box in it.
  const overflow = () => ev(`(function(){var w=window.innerWidth,bad=[];
    if(document.documentElement.scrollWidth>w) bad.push('page scrollWidth '+document.documentElement.scrollWidth);
    document.querySelectorAll('body *').forEach(function(e){var r=e.getBoundingClientRect();
      if(r.width&&r.height&&(r.right>w+0.5||r.left<-0.5)&&getComputedStyle(e).position!=='fixed'||(r.width>w+0.5)) bad.push(e.tagName+'.'+e.className+' '+Math.round(r.left)+'..'+Math.round(r.right));});
    return bad.slice(0,4).join(' | ')})()`);
  const svgs = () => ev(`(function(){var bad=[];document.querySelectorAll('svg').forEach(function(s){var r=s.getBoundingClientRect();if(r.width>110||r.height>110||!r.width)bad.push(Math.round(r.width)+'x'+Math.round(r.height));});return bad.join(',')})()`);
  const boxes = () => ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('#app *, #sheet-root *'),function(e){
    /* .rule is the absorber: the hairline that gives up the marker's width so nothing else has to. */
    if(e.classList.contains('help-i')||e.classList.contains('rule'))return null;var r=e.getBoundingClientRect();return [e.tagName,Math.round(r.left*10),Math.round(r.top*10),Math.round(r.width*10),Math.round(r.height*10)].join(',')}).filter(Boolean))`);
  const contrast = sel => ev(`(function(){function lum(c){var m=c.match(/[\\d.]+/g).slice(0,3).map(function(v){v=v/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*m[0]+0.7152*m[1]+0.0722*m[2]}
    var e=document.querySelector(${q(sel)}),a=lum(getComputedStyle(e).color),b=lum(getComputedStyle(document.body).backgroundColor);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)})()`);
  const VERSION = (HTML.match(/window\.EGS_VERSION = '([^']*)'/) || [])[1];
  const seed = async pairs => { await send('Page.navigate', { url:URL0 + 'manifest.webmanifest' }); await sleep(120);
    await ev('(function(p){localStorage.clear();p.forEach(function(x){localStorage.setItem(x[0],x[1])});return true})(' + JSON.stringify(pairs) + ')'); };
  const setup = async name => { await wipe(); await load(); await type('#boss-name', name); await click('[data-action="setup-save"]');
    await until('!!document.querySelector(".topbar")', 8000, 'home after setup'); };

  const closed = what => until('!document.getElementById("sheet-root").innerHTML', 5000, what || 'sheet closed');
  // Add a worker or a job through the screen, the way a person does.
  const addRec = async (name, extra) => { await click('[data-action="rec-add"]'); await type('#rec-name', name);
    if(extra) await type('#rec-extra', extra); await click('[data-action="rec-save"]'); await closed('saved ' + name); };
  const openRec = async name => { await ev('(function(n){var b=Array.prototype.filter.call(document.querySelectorAll("[data-action=rec-edit]"),function(e){return e.querySelector(".rec-name").textContent===n})[0];if(!b)throw new Error("no row "+n);b.click();return true})(' + q(name) + ')');
    await until('!!document.getElementById("rec-name")', 3000, 'record sheet for ' + name); };
  const names = sel => ev('JSON.stringify(Array.prototype.map.call(document.querySelectorAll(' + q(sel + ' .rec-name') + '),function(e){return e.textContent}))').then(JSON.parse);
  const stored = async key => JSON.parse(await raw('notebuiltpro.' + key));
  const newIds = n => ev('JSON.stringify(Array.from({length:' + n + '},function(){return EGSCrew.newId()}))').then(JSON.parse);
  const rec = (id, name, extraKey, extra, at, archived) => { const r = { id, name }; r[extraKey] = extra || ''; r.archived = !!archived; r.createdAt = at; r.updatedAt = at; return r; };
  const NOW = Math.floor(Date.now() / 1000);

  // ---- stage 3 helpers: lists, the Day screen, the share sheet ----
  const dump = () => ev('idbDump().then(function(d){return JSON.stringify(d.lists)})').then(JSON.parse);
  const listsReady = () => until('listsState==="ready"', 8000, 'lists read');
  const hookShare = () => ev('window.__shares=window.__shares||[],window.__shareFail=null,navigator.share=function(d){(window.__shareMeta=window.__shareMeta||[]).push({sync:!!window.__inTap,active:!!(navigator.userActivation&&navigator.userActivation.isActive)});if(window.__shareFail==="throw")throw new TypeError("x");if(window.__shareFail==="hang")return new Promise(function(){});if(window.__shareFail){var e=new Error("x");e.name=window.__shareFail;return Promise.reject(e)}window.__shares.push(d);return Promise.resolve()},true');
  const shares = () => ev('JSON.stringify(window.__shares||[])').then(JSON.parse);
  const chip = (name, box) => ev('(function(n){var c=Array.prototype.filter.call(document.querySelectorAll(' + q((box || '#day-who') + ' .chip') + '),function(e){return e.textContent===n})[0];if(!c)throw new Error("no chip "+n);c.click();return true})(' + q(name) + ')');
  const taskCount = () => ev('document.querySelectorAll("#day-body .task").length');
  const addTask = async (who, words) => { if(who) await chip(who); const n = await taskCount(); await type('#task-new', words); await click('[data-action="task-add"]');
    await until('document.querySelectorAll("#day-body .task").length===' + (n + 1), 6000, 'task added: ' + words.slice(0, 24)); };
  const openTask = async words => { await ev('(function(n){var b=Array.prototype.filter.call(document.querySelectorAll("#day-body [data-action=task-edit]"),function(e){return (e.querySelector(".gone-text")||e).textContent===n})[0];if(!b)throw new Error("no task "+n);b.click();return true})(' + q(words) + ')');
    await until('!!document.getElementById("sheet-root").innerHTML', 3000, 'task sheet'); };
  // {name: state} for every worker heading on the Day screen, or every card on Send.
  const dayStates = () => ev('JSON.stringify(Array.prototype.map.call(document.querySelectorAll("#day-body .grp[data-wid]"),function(g){return [g.querySelector(".who").textContent,g.querySelector(".pill").dataset.state]}))').then(a => Object.fromEntries(JSON.parse(a)));
  const cards = () => ev('JSON.stringify(Array.prototype.map.call(document.querySelectorAll(".send-w"),function(c){return {name:c.querySelector(".who").textContent,state:c.dataset.state,refused:c.dataset.refused||"",pill:c.querySelector(".pill").textContent,parts:Array.prototype.map.call(c.querySelectorAll(".part"),function(p){var o=p.nextElementSibling;o=o&&o.classList.contains("part-out")?o:null;return {done:p.dataset.done==="1",chars:+p.dataset.chars,out:p.dataset.out,outText:o?o.querySelector(".grow").textContent:"",mark:!!(o&&o.querySelector("[data-action=send-mark]")),undo:!!(o&&o.querySelector("[data-action=send-unmark]"))}}),note:(c.querySelector(".send-note")||{dataset:{}}).dataset.outcome||"",text:c.textContent,fix:!!c.querySelector("[data-action=send-fix]"),again:!!c.querySelector("[data-action=send-again]")}}))').then(JSON.parse);
  const card = async name => (await cards()).find(c => c.name === name);
  const measured = () => until('!!document.querySelector(".send-w") && !/Measuring/.test(document.getElementById("app").textContent)', 20000, 'links measured');
  const inCard = (name, sel) => ev('(function(n){var c=Array.prototype.filter.call(document.querySelectorAll(".send-w"),function(e){return e.querySelector(".who").textContent===n})[0];var b=c&&c.querySelector(' + q(sel) + ');if(!b)throw new Error("nothing matching ' + sel.replace(/"/g, "'") + ' for "+n);b.click();return true})(' + q(name) + ')');
  const decode = link => ev('EGSCrew.decode(' + q(link.slice(link.indexOf('#crew=') + 6)) + ',"list").then(function(r){return JSON.stringify(r)})').then(JSON.parse);
  const linkOf = share => share.text.split('\n')[1];
  // A tap whose handler runs with __inTap set: anything the app calls after an await sees it cleared.
  const tapSync = sel => ev('(function(){var e=document.querySelector(' + q(sel) + ');if(!e)throw new Error("no element");window.__inTap=true;try{e.click()}finally{window.__inTap=false}return true})()');
  // A real tap through the input pipeline, so the page gets genuine user activation.
  const realTap = async sel => { const r = JSON.parse(await ev('(function(){var e=document.querySelector(' + q(sel) + ');e.scrollIntoView({block:"center"});var b=e.getBoundingClientRect();return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2})})()'));
    for(const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x:r.x, y:r.y, button:'left', clickCount:1 }); };
  const sheetText = () => ev('document.getElementById("sheet-root").textContent');
  const goHome = async () => { await ev('go("home")'); await until('location.hash==="#/home"', 4000, 'home'); };
  // Lists put straight into the phone's storage, the way a restore leaves them.
  const seedLists = arr => ev(`new Promise(function(res,rej){var r=indexedDB.open('notebuiltpro',3);
    r.onupgradeneeded=function(){var d=r.result;if(!d.objectStoreNames.contains('lists'))d.createObjectStore('lists',{keyPath:'listId'});if(!d.objectStoreNames.contains('reports'))d.createObjectStore('reports',{keyPath:['listId','workerId']})};
    r.onsuccess=function(){var d=r.result,tx=d.transaction('lists','readwrite');${JSON.stringify(arr)}.forEach(function(x){tx.objectStore('lists').put(x)});tx.oncomplete=function(){d.close();res(true)};tx.onerror=function(){rej(tx.error)}};
    r.onerror=function(){rej(r.error)}})`);
  const nodeId = () => require('crypto').randomBytes(8).toString('base64url');
  // Deterministic text in one script: the same fixtures on every run.
  let _seed = 0x2545F491;
  const rnd = () => { _seed |= 0; _seed = _seed + 0x6D2B79F5 | 0; let t = Math.imul(_seed ^ _seed >>> 15, 1 | _seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const scriptText = (from, span, n) => Array.from({ length:n }, () => String.fromCodePoint(from + Math.floor(rnd() * span))).join('');
  const cyr = n => scriptText(0x430, 32, n), han = n => scriptText(0x4E00, 20000, n), rare = n => scriptText(0x20000, 42719, n);

  // Mark sent sits under its part, in the row that says how it went out.
  const MARK = ' + .part-out [data-action="send-mark"]', UNMARK = ' + .part-out [data-action="send-unmark"]';
  // Send the next part, wait for it to be handed over, then mark it sent by hand: Send itself never does.
  const sendOne = async () => { const b = JSON.parse(await ev('(function(){var b=document.getElementById("send-next");return JSON.stringify({wid:b.dataset.wid,n:b.dataset.n})})()'));
    const sel = '.send-w[data-wid="' + b.wid + '"] .part[data-n="' + b.n + '"]';
    await click('#send-next'); await until('(function(){var p=document.querySelector(' + q(sel) + ');return !!(p&&p.dataset.out)})()', 6000, 'handed to the share sheet');
    await click(sel + MARK); await until('(function(){var p=document.querySelector(' + q(sel) + ');return !p||p.dataset.done==="1"})()', 6000, 'marked by hand'); };
  // The same from a worker's own card: their first part.
  const sendIn = async name => { const w = await ev('(function(n){return Array.prototype.filter.call(document.querySelectorAll(".send-w"),function(e){return e.querySelector(".who").textContent===n})[0].dataset.wid})(' + q(name) + ')');
    const sel = '.send-w[data-wid="' + w + '"] .part[data-n="0"]';
    await inCard(name, '[data-action="send-part"]'); await until('(function(){var p=document.querySelector(' + q(sel) + ');return !!(p&&p.dataset.out)})()', 6000, name + ' handed over');
    await click(sel + MARK); await until('(function(){var p=document.querySelector(' + q(sel) + ');return !p||p.dataset.done==="1"})()', 6000, name + ' marked'); };
  const sendAll = async () => { for(let i = 0; i < 80; i++){ const t = await text('#send-next'); if(t === null) break; await sendOne();
      await until('(function(){var b=document.getElementById("send-next");return !b||b.textContent!==' + q(t) + '})()', 6000, 'the queue to move past ' + t); }
    await until('!!document.getElementById("send-done")', 6000, 'everything sent'); };

  await size(320, 568); await scheme('dark');

  // ---- cold open ---------------------------------------------------------------
  section('Cold open, storage empty');
  await wipe(); await load();
  ok(await ev('!!document.getElementById("boss-name")'), 'first run lands on the name screen');
  ok(VERSION && (await text('.ver-stamp')) === VERSION, 'version stamp on the first-run screen reads ' + VERSION, await text('.ver-stamp'));
  ok(await ev('(function(){var r=document.querySelector(".ver-stamp").getBoundingClientRect();return r.height>0&&r.bottom<=window.innerHeight&&r.top>=0})()'), 'the stamp is on screen at 320x568 without scrolling');
  { const c = await contrast('.ver-stamp'); ok(c >= 4.5, 'the stamp is readable on the dark ground (contrast ' + c.toFixed(2) + ')', c.toFixed(2)); }
  ok(await ev('(function(){var r=document.querySelector(".mark-lg svg").getBoundingClientRect();return Math.round(r.width)===88&&Math.round(r.height)===88})()'), 'the mark is drawn at its set size');
  await sleep(500);
  ok((await snap()) === '[]', 'startup wrote nothing to localStorage', await snap());
  ok(await ev('indexedDB.databases().then(function(d){return !d.some(function(x){return x.name==="notebuiltpro"})})'), 'startup did not create the IndexedDB database');
  ok(!(await overflow()), 'no horizontal scroll at 320px, dark', await overflow());
  await shot('01-first-run-dark-320');

  // ---- the name check ----------------------------------------------------------
  section('Name check, while typing');
  const CYR = 'Константин Александрович Рождественский!';   // 40 characters
  const HAN = '建筑工程有限公司第三施工队木工班组负责人张伟先生项目经理兼安全员质量检查员技术员资料员测量'.slice(0, 40);
  ok(Array.from(CYR).length === 40 && Array.from(HAN).length === 40, 'fixtures are exactly 40 characters');
  await type('#boss-name', 'Mike'); await sleep(400);
  ok((await text('#name-msg')) === '', 'a short name gets no warning');
  await type('#boss-name', HAN);
  await until('document.getElementById("name-msg").className.indexOf("warn")>=0', 5000, 'warning for a long Chinese name');
  ok((await text('#name-msg')).length > 40, 'a 40-character Chinese name warns without a tap', await text('#name-msg'));
  console.log('       "' + (await text('#name-msg')) + '"');
  await shot('02-long-name-warning-320');
  ok(!(await overflow()), 'the warning does not widen the page', await overflow());
  await type('#boss-name', 'Mike'); await until('document.getElementById("name-msg").textContent===""', 4000, 'warning cleared');
  ok(true, 'shortening the name clears the warning');
  // Reported, not asserted: 40 Cyrillic characters sit near the line. With 128-bit ids this read "tight"; at 64 it reads "ok".
  { const r = await ev('nameCheck(' + q(CYR) + ').then(function(r){return r.level})'); console.log('       40 Cyrillic characters measure as: ' + r); }
  // The stronger level needs the other two names; they are passed in once the app knows them.
  { let s = 0x9e3779b9; const r32 = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const pick = () => Array.from({ length:40 }, () => String.fromCodePoint(0x20000 + Math.floor(r32() * 42719))).join('');
    const r = await ev('nameCheck(' + q(pick()) + ',"boss",null,{job:' + q(pick()) + ',worker:' + q(pick()) + '}).then(function(r){return r.level+"|"+r.msg})');
    ok(/^none\|.*no room/.test(r), 'three unrelated 40-character names in rare CJK characters measure as no room at all', r); }
  await type('#boss-name', 'M' + 'i'.repeat(40));
  await until('document.getElementById("name-msg").className.indexOf("bad")>=0', 5000, '41 characters refused');
  ok(/40 characters/.test(await text('#name-msg')), '41 characters is refused with the limit named');
  await type('#boss-name', 'Mike <b>');
  await until('document.getElementById("name-msg").className.indexOf("bad")>=0 && /markup/.test(document.getElementById("name-msg").textContent)', 5000, 'markup refused');
  await click('[data-action="setup-save"]'); await sleep(300);
  ok(await ev('!!document.getElementById("boss-name")') && (await snap()) === '[]', 'a refused name saves nothing and stays on the screen');
  await type('#boss-name', ''); await click('[data-action="setup-save"]');
  await until('/Type your name/.test(document.getElementById("name-msg").textContent)', 4000, 'empty name refused');
  ok((await snap()) === '[]', 'an empty name saves nothing; typing wrote nothing either');

  // ---- first run mints the id ---------------------------------------------------
  section('First run');
  await type('#boss-name', '  Mike  '); await click('[data-action="setup-save"]');
  await until('!!document.querySelector(".topbar")', 8000, 'home after setup');
  const S1 = await raw('notebuiltpro.settings'), s1 = JSON.parse(S1);
  ok(ID_RE.test(s1.boss.id), 'first run minted a permanent ID', S1);
  ok(s1.boss.name === 'Mike', 'and took the name, trimmed', s1.boss.name);
  ok(s1.schemaVersion === 4 && Object.keys(s1).join() === 'schemaVersion,boss' && Object.keys(s1.boss).join() === 'id,name', 'the save stamped schema 4, in a fixed key order', S1);
  ok((await text('.ver-stamp')) === VERSION && /Mike/.test(await text('#app')), 'Home shows the name and the stamp');
  ok((await ev('location.hash')) === '#/home' && (await ev('history.state.d')) === 1, 'history is seeded: guard, then Home');
  ok(!(await overflow()), 'Home: no horizontal scroll at 320px', await overflow());
  await shot('03-home-dark-320');

  // ---- restart ---------------------------------------------------------------------
  section('Restart');
  await sleep(300); const before = await snap();
  await reload(); await sleep(400);
  ok((await raw('notebuiltpro.settings')) === S1, 'a reload keeps the ID and the name, byte for byte');
  ok((await snap()) === before, 'a reload with data on the phone writes nothing at all');
  await load(); await sleep(300);
  ok((await raw('notebuiltpro.settings')) === S1 && /Mike/.test(await text('#app')), 'a cold open keeps them too');
  ok((await text('.ver-stamp')) === VERSION, 'stamp readable on a cold open into Home');

  // ---- schema stamp only on a user-action save --------------------------------------
  section('Schema stamp');
  const UNSTAMPED = JSON.stringify({ boss:s1.boss });
  await seed([['notebuiltpro.settings', UNSTAMPED], ['notebuiltpro.selfcheck.marker', 'harness']]);
  const seeded = await snap();
  await load(); await sleep(500);
  ok((await snap()) === seeded, 'startup did not stamp the schema number, or touch the harness key');
  await click('[data-go="settings"]'); await click('[data-action="guide"]'); await click('[data-action="theme"][data-mode="light"]'); await sleep(200);
  ok((await raw('notebuiltpro.settings')) === UNSTAMPED, 'moving around and changing phone preferences still does not stamp it');
  await click('[data-action="theme"][data-mode="system"]'); await click('[data-action="guide"]');
  await click('[data-action="edit-name"]'); await type('#edit-name', 'Mike S'); await click('[data-action="name-save"]');
  await until('localStorage.getItem("notebuiltpro.settings").indexOf("Mike S")>0', 5000, 'rename saved');
  const S2 = JSON.parse(await raw('notebuiltpro.settings'));
  ok(S2.schemaVersion === 4, 'the first ordinary save stamps it');
  ok(S2.boss.id === s1.boss.id && S2.boss.name === 'Mike S', 'renaming keeps the ID', JSON.stringify(S2));
  ok((await raw('notebuiltpro.settings__bak')) === UNSTAMPED, 'the save backed up what was there first');
  ok((await raw('notebuiltpro.selfcheck.marker')) === null, 'the harness key is dropped by that save');
  ok(await ev('!document.getElementById("sheet-root").innerHTML') && (await text('#set-name')) === 'Mike S', 'the sheet closed and Settings shows the new name');

  // A phone still on the stage 1 shape: schema 1, no crew, no jobs.
  const V1 = JSON.stringify({ schemaVersion:1, boss:s1.boss });
  await seed([['notebuiltpro.settings', V1]]);
  await load('#/home'); await sleep(500);
  ok((await snap()) === JSON.stringify([['notebuiltpro.settings', V1]]) && /Mike/.test(await text('#app')), 'a phone on schema 1 opens as it was, and startup does not move it up');
  await click('[data-go="crew"]'); await addRec('Joe');
  { const st = JSON.parse(await raw('notebuiltpro.settings')), ro = await stored('roster');
    ok(ro.length === 1 && st.schemaVersion === 4 && st.boss.id === s1.boss.id, 'adding the first worker writes the crew and, with it, stamps schema 4', JSON.stringify(st));
    ok((await raw('notebuiltpro.settings__bak')) === V1, 'and the schema 1 settings are kept as the backup copy'); }
  await seed([['notebuiltpro.settings', JSON.stringify(S2)]]); await load('#/settings'); await sleep(200);

  // ---- rename with a long name ---------------------------------------------------
  section('Settings: your name');
  // 40 Chinese characters: since ids went to 64 bits, 40 Cyrillic ones leave room for a full task and no longer warn.
  await click('[data-action="edit-name"]'); await type('#edit-name', HAN);
  await until('document.getElementById("edit-name-msg").className.indexOf("warn")>=0', 5000, 'rename warning');
  ok(true, 'the Settings row runs the same check, while typing');
  ok(!(await overflow()), 'name sheet: no horizontal scroll at 320px', await overflow());
  await shot('04-rename-sheet-320');
  await click('[data-action="name-save"]');
  await until('localStorage.getItem("notebuiltpro.settings").indexOf("项目经理")>0', 5000, 'long name saved');
  await until('document.getElementById("set-name-msg") && document.getElementById("set-name-msg").textContent.length>20', 5000, 'standing warning in Settings');
  ok(JSON.parse(await raw('notebuiltpro.settings')).boss.id === s1.boss.id, 'a warned name still saves, and still keeps the ID');
  ok(!(await overflow()), 'Settings with a 40-character name: no horizontal scroll', await overflow());
  // A name the component accepts, and which only reads back the same if it was escaped.
  const TRICKY = '&lt;b&gt; A&B "q" \'z\'';
  await click('[data-action="edit-name"]'); await type('#edit-name', TRICKY); await click('[data-action="name-save"]');
  await until('JSON.parse(localStorage.getItem("notebuiltpro.settings")).boss.name===' + q(TRICKY), 5000, 'tricky name saved');
  await until('!document.getElementById("sheet-root").innerHTML', 4000, 'sheet closed');
  ok((await text('#set-name')) === TRICKY && await ev('document.getElementById("set-name").children.length===0'), 'a name is escaped where Settings draws it', await text('#set-name'));
  await click('[data-action="edit-name"]');
  ok((await ev('document.getElementById("edit-name").value')) === TRICKY, 'and round-trips through the edit field intact', await ev('document.getElementById("edit-name").value'));
  await ev('history.back()'); await until('!document.getElementById("sheet-root").innerHTML', 4000, 'sheet closed by back');
  ok((await ev('location.hash')) === '#/settings', 'back closes the sheet and stays on Settings');
  await click('[data-back]'); await until('location.hash==="#/home"', 4000, 'home');
  ok((await text('#app .card')).indexOf(TRICKY) === 0, 'and where Home draws it', await text('#app .card'));

  // ---- hostile stored data ---------------------------------------------------------
  section('Damaged or hostile storage');
  const EVIL = JSON.stringify({ schemaVersion:1, boss:{ id:s1.boss.id, name:'<img src=x onerror="window.__x=1">' } });
  await seed([['notebuiltpro.settings', EVIL]]);
  await load(); await sleep(400);
  ok(await ev('!!document.querySelector("[data-action=\\"start-fresh\\"]") && !window.__x && !document.querySelector("#app img")'), 'markup in a stored name is never rendered: the damaged gate shows instead');
  ok((await text('.ver-stamp')) === VERSION, 'the damaged gate carries the stamp');
  ok(!(await overflow()), 'damaged gate: no horizontal scroll', await overflow());
  dialogs.seen.length = 0; dialogs.answer = false;
  await click('[data-action="start-fresh"]'); await sleep(200);
  ok(dialogs.seen.length === 1 && /NEW ID/.test(dialogs.seen[0]), 'Start fresh asks first');
  ok(await ev('!!document.querySelector("[data-action=\\"start-fresh\\"]")') && (await raw('notebuiltpro.settings')) === EVIL, 'declining changes nothing');
  dialogs.answer = true; await click('[data-action="start-fresh"]');
  await until('!!document.getElementById("boss-name")', 4000, 'setup after fresh start');
  ok((await raw('notebuiltpro.settings')) === EVIL, 'accepting writes nothing until a name is saved');
  await type('#boss-name', 'Mike'); await click('[data-action="setup-save"]');
  await until('!!document.querySelector(".topbar")', 8000, 'home after fresh start');
  { const n = JSON.parse(await raw('notebuiltpro.settings'));
    ok(ID_RE.test(n.boss.id) && n.boss.id !== s1.boss.id && (await raw('notebuiltpro.settings__bak')) === EVIL, 'then a new ID is minted and the unreadable original is kept as the backup copy'); }

  // The main copy is damaged but the backup copy is good: heal, do not gate.
  await seed([['notebuiltpro.settings', '{not json'], ['notebuiltpro.settings__bak', S1]]);
  await load(); await sleep(300);
  ok(/Mike/.test(await text('#app')) && await ev('!!document.querySelector(".topbar")'), 'a damaged main copy heals from the backup copy, same ID');
  ok((await raw('notebuiltpro.settings')) === '{not json', 'and healing writes nothing at startup');

  // Saved by a newer build.
  const FUTURE = JSON.stringify({ schemaVersion:7, who:{ ident:'x' }, extra:[1, 2] });
  await seed([['notebuiltpro.settings', FUTURE]]);
  await load(); await sleep(400);
  ok(/newer version/.test(await text('#app')) && await ev('!document.querySelector("input")'), 'data from a newer schema shows a gate, with nothing to type into');
  ok((await text('.ver-stamp')) === VERSION && (await snap()) === JSON.stringify([['notebuiltpro.settings', FUTURE]]), 'the gate carries the stamp and the data is untouched');
  ok(!(await overflow()), 'newer-version gate: no horizontal scroll', await overflow());

  // ---- crew ---------------------------------------------------------------------------
  section('Crew');
  await setup('Mike');
  ok(/Nobody yet/.test(await text('#home-crew')) && /No jobs yet/.test(await text('#home-jobs')), 'Home says there is no crew and no jobs yet');
  await click('[data-go="crew"]');
  ok((await ev('location.hash')) === '#/crew' && /Nobody yet/.test(await text('#app')) && (await raw('notebuiltpro.roster')) === null, 'Crew opens empty, and opening it writes nothing');
  await addRec('joe', 'Framer'); await addRec('Zed'); await addRec('Joe', '555-0100'); await addRec('amy');
  let ro = await stored('roster');
  ok(ro.length === 4 && ro.every(w => ID_RE.test(w.id)) && new Set(ro.map(w => w.id)).size === 4, 'each worker gets a permanent ID when added', JSON.stringify(ro.map(w => w.id)));
  ok(ro.every(w => Object.keys(w).join() === 'id,name,note,archived,createdAt,updatedAt' && w.archived === false && w.createdAt === w.updatedAt && Math.abs(w.createdAt - NOW) < 600), 'a worker is stored as id, name, note, archived and two times, in that order');
  ok(ro.map(w => w.name).join() === 'joe,Zed,Joe,amy' && ro[0].note === 'Framer' && ro[1].note === '', 'stored in the order they were added, with the note');
  { const shown = await names('#rec-list'), want = ro.slice().sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : (a.id < b.id ? -1 : 1)).map(w => w.name);
    ok(shown.join() === want.join() && shown[0] === 'amy' && shown[3] === 'Zed', 'shown sorted by name, ties broken by ID, never in stored order', shown.join() + ' vs ' + want.join()); }
  ok(/555-0100/.test(await text('#rec-list')) && /Framer/.test(await text('#rec-list')), 'the note shows under the name');
  await reload(); await sleep(200);
  ok((await ev('location.hash')) === '#/crew' && (await names('#rec-list')).length === 4, 'the crew survives a reload');

  // Edit: the ID and the created time never move.
  await openRec('Zed'); await type('#rec-name', 'Zed R'); await type('#rec-extra', 'Electrician'); await click('[data-action="rec-save"]'); await closed();
  { const z0 = ro[1], z = (await stored('roster'))[1];
    ok(z.id === z0.id && z.createdAt === z0.createdAt && z.name === 'Zed R' && z.note === 'Electrician' && z.updatedAt >= z0.updatedAt, 'editing a worker keeps their ID and position, and changes only what was edited', JSON.stringify(z)); }
  { const b4 = await snap(); await openRec('amy'); await click('[data-action="rec-save"]'); await closed();
    ok((await snap()) === b4, 'saving with nothing changed writes nothing'); }

  // The name check, in the worker's own slot.
  await click('[data-action="rec-add"]'); await type('#rec-name', HAN);
  await until('document.getElementById("rec-name-msg").className.indexOf("warn")>=0', 5000, 'worker name warning');
  ok(/takes up a lot of a link|no room/.test(await text('#rec-name-msg')), 'a 40-character worker name warns while typing', await text('#rec-name-msg'));
  console.log('       "' + (await text('#rec-name-msg')) + '"');
  ok(!(await overflow()), 'worker sheet with a warning: no horizontal scroll at 320px', await overflow());
  await shot('06-worker-sheet-warning-320');
  await click('[data-action="rec-save"]'); await closed('warned worker saved');
  ok((await stored('roster')).length === 5 && (await stored('roster'))[4].name === HAN, 'and the warning does not stop the save');
  { const b4 = await snap(); dialogs.answer = true;
    for(const [bad, why] of [['', /Type a name/], ['x'.repeat(41), /40 characters/], ['Joe <b>', /markup/]]){
      await click('[data-action="rec-add"]'); await type('#rec-name', bad); await click('[data-action="rec-save"]');
      await until(why.toString() + '.test(document.getElementById("rec-name-msg").textContent)', 4000, 'refusal ' + why);
      await ev('history.back()'); await closed(); }
    await click('[data-action="rec-add"]'); await type('#rec-name', 'Sam'); await type('#rec-extra', 'n'.repeat(121)); await click('[data-action="rec-save"]');
    await until('/120 characters/.test(document.getElementById("rec-extra-msg").textContent)', 4000, 'long note refused');
    await ev('history.back()'); await closed();
    ok((await snap()) === b4 && (await ev('location.hash')) === '#/crew', 'an empty name, 41 characters, markup and a 121-character note are each refused, and nothing is written'); }

  // Archive asks first, deletes nothing, and can be undone.
  await openRec('joe'); dialogs.seen.length = 0; dialogs.answer = false;
  await click('[data-action="rec-archive"]'); await sleep(200);
  ok(dialogs.seen.length === 1 && /Archive joe\?/.test(dialogs.seen[0]) && /Nothing is deleted/.test(dialogs.seen[0]), 'archiving asks first', dialogs.seen.join('|'));
  ok((await stored('roster'))[0].archived === false && await ev('!!document.getElementById("rec-name")'), 'declining changes nothing');
  dialogs.answer = true; await click('[data-action="rec-archive"]'); await closed('archived');
  ro = await stored('roster');
  ok(ro.length === 5 && ro[0].archived === true && ro[0].id && (await names('#rec-list')).indexOf('joe') < 0 && (await names('#rec-archived')).join() === 'joe', 'accepting moves them to Archived; the record and its ID stay');
  await click('[data-back]'); await until('location.hash==="#/home"', 4000, 'home');
  ok((await text('#home-crew')) === '4 people', 'Home counts the crew still in use', await text('#home-crew'));
  await click('[data-go="crew"]'); await openRec('joe'); dialogs.seen.length = 0;
  await click('[data-action="rec-unarchive"]'); await closed('brought back');
  ok(dialogs.seen.length === 0 && (await stored('roster'))[0].archived === false && (await names('#rec-list')).indexOf('joe') >= 0 && await ev('!document.getElementById("rec-archived")'), 'Bring back restores them without asking');

  // Escaping, and back.
  await addRec('&lt;i&gt; O\'Neil & "Co"', '&amp; <b>bold</b> "note"');
  ok((await names('#rec-list')).indexOf('&lt;i&gt; O\'Neil & "Co"') >= 0 && await ev('!document.querySelector("#rec-list b, #rec-list i")') && /&amp; <b>bold<\/b> "note"/.test(await text('#rec-list')), 'a worker\u2019s name and note are escaped where they are drawn');
  await openRec('&lt;i&gt; O\'Neil & "Co"');
  ok((await ev('document.getElementById("rec-name").value')) === '&lt;i&gt; O\'Neil & "Co"' && (await ev('document.getElementById("rec-extra").value')) === '&amp; <b>bold</b> "note"', 'and both round-trip through the edit fields intact');
  ok((await ev('history.state.o')) === 'sheet', 'the worker sheet owns a history entry');
  await ev('history.back()'); await closed('sheet closed by back');
  ok((await ev('location.hash')) === '#/crew', 'back closes the sheet and stays on Crew');
  await ev('history.back()'); await until('location.hash==="#/home"', 4000, 'back to home');
  ok(true, 'and back again returns to Home');
  await load('#/crew'); await sleep(150); await ev('history.back()'); await until('location.hash==="#/home"', 4000, 'seeded crew parent');
  ok(true, 'a cold open on Crew is seeded with Home beneath it');

  // ---- jobs ---------------------------------------------------------------------------
  section('Jobs');
  await click('[data-go="jobs"]');
  ok((await ev('location.hash')) === '#/jobs' && /No jobs yet/.test(await text('#app')) && (await raw('notebuiltpro.jobs')) === null, 'Jobs opens empty, and opening it writes nothing');
  await addRec('Oak St reno', '12 Oak St'); await addRec('alder duplex');
  let jb = await stored('jobs');
  ok(jb.length === 2 && jb.every(j => ID_RE.test(j.id) && Object.keys(j).join() === 'id,name,address,archived,createdAt,updatedAt') && jb[0].address === '12 Oak St', 'a job is stored as id, name, address, archived and two times, with a permanent ID', JSON.stringify(jb));
  ok((await names('#rec-list')).join() === 'alder duplex,Oak St reno' && /12 Oak St/.test(await text('#rec-list')), 'jobs are shown sorted by name, with the address');
  ok(await ev('!/mode|private|crew link/i.test(document.getElementById("app").textContent)'), 'a job has no send-mode setting');
  await openRec('Oak St reno'); await type('#rec-name', 'Oak Street reno'); await click('[data-action="rec-save"]'); await closed();
  ok((await stored('jobs'))[0].id === jb[0].id && (await stored('jobs'))[0].name === 'Oak Street reno', 'renaming a job keeps its ID');
  // A different long name from the worker's: two identical names really do compress into less room.
  const HAN2 = '北京市朝阳区望京街道花家地南里小区旧楼翻新改造及外墙保温屋面防水厨卫水电更换项目二期工程'.slice(0, 40);
  await click('[data-action="rec-add"]'); await type('#rec-name', HAN2);
  await until('document.getElementById("rec-name-msg").className.indexOf("warn")>=0', 5000, 'job name warning');
  ok(/Beside the longest names you already have/.test(await text('#rec-name-msg')), 'a long job name warns while typing, weighed against the real names on the phone', await text('#rec-name-msg'));
  await type('#rec-extra', 'a'.repeat(161)); await click('[data-action="rec-save"]');
  await until('/160 characters/.test(document.getElementById("rec-extra-msg").textContent)', 4000, 'long address refused');
  await type('#rec-extra', 'Unit 4'); await click('[data-action="rec-save"]'); await closed('warned job saved');
  ok((await stored('jobs')).length === 3, 'the warning does not stop the save, and a 161-character address was refused first');
  await openRec('alder duplex'); dialogs.seen.length = 0; dialogs.answer = true;
  await click('[data-action="rec-archive"]'); await closed('job archived');
  ok(dialogs.seen.length === 1 && /Archive alder duplex\?/.test(dialogs.seen[0]) && (await stored('jobs'))[1].archived === true && (await names('#rec-archived')).join() === 'alder duplex', 'archiving a job asks first and deletes nothing');
  await click('[data-back]'); await until('location.hash==="#/home"', 4000, 'home');
  ok((await text('#home-jobs')) === '2 jobs' && (await text('#home-crew')) === '6 people', 'Home counts both', (await text('#home-jobs')) + ' / ' + (await text('#home-crew')));
  ok(!(await overflow()), 'Home with crew and jobs: no horizontal scroll at 320px', await overflow());
  await shot('07-home-stage2-320');
  ok(JSON.parse(await raw('notebuiltpro.settings')).schemaVersion === 4 && JSON.parse(await snap()).every(p => p[0].indexOf('notebuiltpro.') === 0), 'every key is still notebuiltpro.*');

  // A boss rename is now weighed against the real crew and jobs.
  await click('[data-go="settings"]'); await click('[data-action="edit-name"]'); await type('#edit-name', CYR);
  await until('/Beside the longest names you already have/.test(document.getElementById("edit-name-msg").textContent)', 5000, 'boss rename weighed against real names');
  ok(true, 'the boss\u2019s own name is weighed against the real crew and jobs once they exist');
  await ev('history.back()'); await closed();

  // ---- unsaved typing ---------------------------------------------------------------------
  section('Unsaved typing');
  await click('[data-back]'); await until('location.hash==="#/home"', 4000, 'home'); await click('[data-go="crew"]');
  const ask = async (label, act, expectOpen) => { dialogs.seen.length = 0; await act(); await sleep(300);
    const open = await ev('!!document.getElementById("sheet-root").innerHTML');
    ok(dialogs.seen.length === 1 && /Discard what you typed\? It hasn\u2019t been saved\./.test(dialogs.seen[0]) && open === expectOpen, label, dialogs.seen.join('|') + ' open=' + open); };
  const quiet = async (label, act) => { dialogs.seen.length = 0; await act(); await closed(label); ok(dialogs.seen.length === 0, label, dialogs.seen.join('|')); };
  const depth = await ev('history.state.d'), kept = await snap();
  await openRec('amy'); await type('#rec-name', 'Amy B'); await type('#rec-extra', 'Painter');
  dialogs.answer = false;
  await ask('back out of a worker sheet with typed changes: it asks, and No keeps the sheet', () => ev('history.back()'), true);
  ok((await ev('document.getElementById("rec-name").value')) === 'Amy B' && (await ev('document.getElementById("rec-extra").value')) === 'Painter' && (await ev('history.state.o')) === 'sheet' && (await ev('history.state.d')) === depth + 1 && (await ev('location.hash')) === '#/crew', 'what was typed is still there, and the sheet still owns its history entry');
  await ask('tapping outside the sheet asks too', () => click('.scrim'), true);
  await ask('so does a help marker, which would replace the sheet', () => click('.scrim .help-corner'), true);
  await ask('and Archive, which acts on the saved record', () => click('[data-action="rec-archive"]'), true);
  ok((await ev('!!document.getElementById("rec-name")')) && (await snap()) === kept, 'four refusals later the form is intact and nothing was written');
  await ev('location.hash="#report=1ZZZZ"'); await sleep(300);
  ok(/Save or close this first/.test(await text('#toast')) && (await ev('location.href')).indexOf('report=') < 0 && (await ev('document.getElementById("rec-name").value')) === 'Amy B', 'a report link tapped mid-edit is stripped from the address and the typing is kept');
  dialogs.answer = true;
  await ask('Yes discards and closes', () => ev('history.back()'), false);
  await until('!history.state.o && history.state.d===' + depth, 4000, 'back on the Crew entry');
  ok((await snap()) === kept && (await ev('location.hash')) === '#/crew' && (await names('#rec-list')).indexOf('amy') >= 0, 'discarding saves nothing and lands back on Crew');
  await openRec('amy');
  await quiet('a sheet with nothing typed closes without asking', () => ev('history.back()'));
  await openRec('amy'); await type('#rec-name', 'Amy B'); await type('#rec-name', ' amy ');
  await quiet('typing that ends up back where it started is not a change', () => click('.scrim'));
  await openRec('amy'); await type('#rec-extra', 'Painter');
  await quiet('Save never asks: there is nothing left to lose', () => click('[data-action="rec-save"]'));
  ok((await stored('roster')).filter(w => w.name === 'amy')[0].note === 'Painter', 'and the save went through');
  await click('[data-action="rec-add"]'); await type('#rec-name', 'Half typed'); dialogs.answer = false;
  await ask('a new worker half typed asks before it is thrown away', () => ev('history.back()'), true);
  dialogs.answer = true; await ask('and goes on Yes', () => click('.scrim'), false);
  ok((await stored('roster')).every(w => w.name !== 'Half typed'), 'without being saved');
  await click('[data-back]'); await until('location.hash==="#/home"', 4000, 'home'); await click('[data-go="jobs"]');
  await openRec('Oak Street reno'); await type('#rec-extra', '14 Oak St'); dialogs.answer = false;
  await ask('a job sheet asks the same way', () => ev('history.back()'), true);
  dialogs.answer = true; await ev('history.back()'); await closed();
  await click('[data-back]'); await until('location.hash==="#/home"', 4000, 'home'); await click('[data-go="settings"]');
  await click('[data-action="edit-name"]'); await type('#edit-name', 'Mike Q'); dialogs.answer = false;
  await ask('and so does the Your name sheet', () => ev('history.back()'), true);
  dialogs.answer = true; await ev('history.back()'); await closed();
  ok(JSON.parse(await raw('notebuiltpro.settings')).boss.name === 'Mike' && (await ev('location.hash')) === '#/settings', 'discarding there leaves the name as it was');
  await click('[data-help="look"]'); await quiet('a help sheet has nothing to lose and never asks', () => ev('history.back()'));

  // ---- stores this phone cannot read -----------------------------------------------------
  section('Damaged crew or jobs');
  const GOODSET = await raw('notebuiltpro.settings'), GOODJOBS = await raw('notebuiltpro.jobs');
  const BADROSTER = JSON.stringify([{ id:JSON.parse(GOODSET).boss.id, name:'<img src=x onerror="window.__z=1">', note:'', archived:false, createdAt:1, updatedAt:1 }]);
  await seed([['notebuiltpro.settings', GOODSET], ['notebuiltpro.jobs', GOODJOBS], ['notebuiltpro.roster', BADROSTER], ['notebuiltpro.installPromptDismissed', '1']]);
  await load('#/crew'); await sleep(300);
  ok(/can\u2019t read the crew/.test(await text('#app')) && await ev('!window.__z && !document.querySelector("#app img") && !document.querySelector("[data-action=rec-add]")'), 'a stored worker that fails the check is never drawn: Crew says it cannot read the crew');
  ok((await raw('notebuiltpro.roster')) === BADROSTER, 'and leaves it untouched');
  { await click('[data-go="support"]'); await click('[data-action="export"]'); await sleep(700);
    ok(backups().length === 0 && /didn\u2019t make a backup/.test(await text('#toast')), 'export refuses rather than write a backup with the crew missing', (await text('#toast')) + ' | ' + backups().join()); }
  await ev('history.back()'); await until('location.hash==="#/crew"', 4000, 'crew');
  dialogs.seen.length = 0; dialogs.answer = false; await click('[data-action="store-fresh"]'); await sleep(150);
  ok(dialogs.seen.length === 1 && await ev('!!document.querySelector("[data-action=store-fresh]")'), 'Start again asks first, and declining changes nothing');
  dialogs.answer = true; await click('[data-action="store-fresh"]'); await until('!!document.querySelector("[data-action=rec-add]")', 3000, 'fresh crew');
  ok((await raw('notebuiltpro.roster')) === BADROSTER, 'accepting writes nothing until someone is added');
  await addRec('Sam');
  ok((await stored('roster')).length === 1 && (await raw('notebuiltpro.roster__bak')) === BADROSTER, 'then the new crew is saved and the unreadable original is kept as the backup copy');
  // A damaged main copy with a good backup copy heals.
  { const good1 = await raw('notebuiltpro.roster');
    await seed([['notebuiltpro.settings', GOODSET], ['notebuiltpro.roster', '[oops'], ['notebuiltpro.roster__bak', good1]]);
    await load('#/crew'); await sleep(250);
    ok((await names('#rec-list')).join() === 'Sam' && (await raw('notebuiltpro.roster')) === '[oops', 'a damaged crew heals from its backup copy, without writing at startup'); }
  // Nothing is ever deleted, so a save that would shorten a store is refused.
  { await seed([['notebuiltpro.settings', GOODSET], ['notebuiltpro.jobs', GOODJOBS]]); await load('#/jobs'); await sleep(200);
    ok((await ev('(function(){var keep=jobs;jobs=jobs.slice(1);var ok=commit("jobs");jobs=keep;return ok})()')) === false && (await raw('notebuiltpro.jobs')) === GOODJOBS, 'a write that would shorten the jobs is refused'); }

  // A report link opened before there is a name: nothing to show, and nothing left in the address.
  await wipe(); await load('#report=1AAAAbbbbCCCC'); await sleep(200);
  ok((await ev('location.href')).indexOf('report=') < 0 && await ev('!!document.getElementById("boss-name") && !document.getElementById("sheet-root").innerHTML') && (await snap()) === '[]', 'a report link on a phone with no name yet is stripped, and first run carries on');

  // ---- export, restore, round trip ----------------------------------------------------
  section('Backup round trip');
  await setup('Mike');
  await click('[data-go="crew"]'); await addRec('Joe', 'Framer'); await addRec('Maria'); await addRec('Old Tom');
  await openRec('Old Tom'); dialogs.answer = true; await click('[data-action="rec-archive"]'); await closed();
  await click('[data-back]'); await until('location.hash==="#/home"', 4000, 'home'); await click('[data-go="jobs"]'); await addRec('Oak St reno', '12 Oak St'); await addRec('Alder duplex');
  await click('[data-back]'); await until('location.hash==="#/home"', 4000, 'home');
  const A = await raw('notebuiltpro.settings'), a = JSON.parse(A), AR = await raw('notebuiltpro.roster'), AJ = await raw('notebuiltpro.jobs');
  await click('[data-go="settings"]'); await click('[data-go="support"]');
  ok((await ev('location.hash')) === '#/support' && /No backup has been saved/.test(await text('#last-backup')), 'Support & Backup opens and says no backup yet');
  let had = fs.readdirSync(work);
  await click('[data-action="export"]');
  const F1 = await download(had), T1 = fs.readFileSync(path.join(work, F1), 'utf8'), B1 = JSON.parse(T1);
  const today = await ev('(function(){var d=new Date(),p=function(n){return String(n).padStart(2,"0")};return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())})()');
  ok(F1 === 'notebuilt-pro-backup-' + today + '.json', 'the file is named notebuilt-pro-backup-<date>.json', F1);
  ok(B1.app === 'notebuilt-pro' && B1.kind === 'backup' && B1.version === 1 && JSON.stringify(B1.settings) === A, 'it carries the settings exactly as stored, ID included');
  ok(JSON.stringify(B1.roster) === AR && JSON.stringify(B1.jobs) === AJ && B1.roster.length === 3 && B1.jobs.length === 2, 'the crew and the jobs exactly as stored, the archived worker included');
  ok(JSON.stringify(B1.crew) === '{"lists":[],"reports":[]}', 'and a section for lists and reports, empty until they exist');
  ok((await raw('notebuiltpro.settings')) === A && (await raw('notebuiltpro.roster')) === AR && (await raw('notebuiltpro.jobs')) === AJ, 'exporting does not change the data');
  await until('/Last backup from this phone/.test(document.getElementById("last-backup").textContent)', 4000, 'last-backup line updated');
  ok((await raw('notebuiltpro.lastBackupAt')) === B1.exportedAt, 'the export is recorded on this phone, outside the data');
  const stateA = await ev('indexedDB.databases().then(function(d){return JSON.stringify(d.filter(function(x){return x.name==="notebuiltpro"}))})');

  await wipe(); await load();
  ok(await ev('!!document.getElementById("boss-name")') && (await snap()) === '[]', 'a wiped phone is back at first run');
  dialogs.seen.length = 0;
  await pickFile('.setup input[data-import]', path.join(work, F1));
  await until('!!document.querySelector(".topbar")', 8000, 'home after restore');
  ok(dialogs.seen.length === 0, 'restoring onto an empty phone has nothing to replace, so nothing to confirm');
  ok((await raw('notebuiltpro.settings')) === A, 'the restored settings are byte-identical: same ID, not a new one', await raw('notebuiltpro.settings'));
  ok((await raw('notebuiltpro.roster')) === AR && (await raw('notebuiltpro.jobs')) === AJ, 'the restored crew and jobs are byte-identical: same IDs, same order, same archive flags');
  ok((await text('#home-crew')) === '2 people' && (await text('#home-jobs')) === '2 jobs', 'and Home counts them straight away');
  ok((await raw('notebuiltpro.lastBackupAt')) === B1.exportedAt, 'the phone remembers the file it was restored from');
  ok((await ev('indexedDB.databases().then(function(d){return JSON.stringify(d.filter(function(x){return x.name==="notebuiltpro"}))})')) === stateA, 'the crew database is back at the same version');
  await click('[data-go="settings"]'); await click('[data-go="support"]');
  had = fs.readdirSync(work).concat([F1]); fs.renameSync(path.join(work, F1), path.join(work, 'first.json'));
  await click('[data-action="export"]');
  const F2 = await download(fs.readdirSync(work)), T2 = fs.readFileSync(path.join(work, F2), 'utf8');
  const strip = t => t.replace(/"exportedAt": "[^"]*"/, '"exportedAt": ""');
  ok(strip(T1) === strip(T2) && T1.length === T2.length, 'export, restore, export again: the two files are byte-identical apart from the export time');
  fs.renameSync(path.join(work, F2), path.join(work, 'second.json'));

  // Restoring over an existing identity asks first.
  await setup('Dana');
  const D = await raw('notebuiltpro.settings');
  await click('[data-go="settings"]'); await click('[data-go="support"]');
  dialogs.seen.length = 0; dialogs.answer = false;
  await pickFile('.wrap input[data-import]', path.join(work, 'first.json')); await sleep(400);
  ok(dialogs.seen.length === 1 && /REPLACES/.test(dialogs.seen[0]) && /Mike, 2 on the crew, 2 jobs/.test(dialogs.seen[0]) && /different/.test(dialogs.seen[0]), 'restoring over a name and ID asks first, says what the file holds, and says the ID differs', dialogs.seen.join('|'));
  ok((await raw('notebuiltpro.settings')) === D, 'declining leaves everything as it was');
  dialogs.answer = true;
  await pickFile('.wrap input[data-import]', path.join(work, 'first.json'));
  await until('localStorage.getItem("notebuiltpro.settings")===' + q(A), 6000, 'restore applied');
  ok((await raw('notebuiltpro.settings__bak')) === D && (await ev('location.hash')) === '#/home' && (await raw('notebuiltpro.roster')) === AR && (await raw('notebuiltpro.jobs')) === AJ, 'accepting restores the file, crew and jobs with it, keeps the replaced settings as the backup copy, and lands on Home');
  // A stage 1 backup: schema 1, nothing but a name and an ID. It replaces the crew with none, after asking.
  { const old = JSON.parse(T1); old.settings.schemaVersion = 1; old.roster = []; old.jobs = [];
    dialogs.seen.length = 0; dialogs.answer = true;
    await click('[data-go="settings"]'); await click('[data-go="support"]');
    await pickFile('.wrap input[data-import]', tmpFile('stage1.json', JSON.stringify(old)));
    await until('localStorage.getItem("notebuiltpro.roster")==="[]"', 6000, 'stage 1 backup restored');
    ok(/Mike, 0 on the crew, 0 jobs/.test(dialogs.seen[0]) && JSON.parse(await raw('notebuiltpro.settings')).schemaVersion === 4 && (await raw('notebuiltpro.roster__bak')) === AR, 'a stage 1 backup restores, says it holds no crew, comes up to schema 4, and the replaced crew is kept as the backup copy');
    await click('[data-go="settings"]'); await click('[data-go="support"]');
    await pickFile('.wrap input[data-import]', path.join(work, 'first.json'));
    await until('localStorage.getItem("notebuiltpro.roster")===' + q(AR), 6000, 'full backup restored again'); }

  // ---- hostile backup files ---------------------------------------------------------
  section('Hostile backup files');
  await click('[data-go="settings"]'); await click('[data-go="support"]');
  const good = () => JSON.parse(T1);
  const bad = [
    ['not JSON', '{nope'],
    ['a JSON array', '[]'],
    ['another app’s backup', JSON.stringify(Object.assign(good(), { app:'notebuilt' }))],
    ['a newer backup version', JSON.stringify(Object.assign(good(), { version:2 }))],
    ['a newer schema', (() => { const g = good(); g.settings.schemaVersion = 9; return JSON.stringify(g); })()],
    ['a malformed ID', (() => { const g = good(); g.settings.boss.id = 'AAAA'; return JSON.stringify(g); })()],
    ['markup in the name', (() => { const g = good(); g.settings.boss.name = '<img src=x onerror="window.__y=1">'; return JSON.stringify(g); })()],
    ['a 41-character name', (() => { const g = good(); g.settings.boss.name = 'x'.repeat(41); return JSON.stringify(g); })()],
    ['no boss at all', (() => { const g = good(); delete g.settings.boss; return JSON.stringify(g); })()],
    ['a worker with a malformed ID', (() => { const g = good(); g.roster[0].id = 'short'; return JSON.stringify(g); })()],
    ['two workers with one ID', (() => { const g = good(); g.roster[1].id = g.roster[0].id; return JSON.stringify(g); })()],
    ['markup in a worker\u2019s name', (() => { const g = good(); g.roster[0].name = '<script>window.__y=1</script>'; return JSON.stringify(g); })()],
    ['a 41-character worker name', (() => { const g = good(); g.roster[0].name = 'x'.repeat(41); return JSON.stringify(g); })()],
    ['a worker with no name', (() => { const g = good(); delete g.roster[0].name; return JSON.stringify(g); })()],
    ['a 121-character note', (() => { const g = good(); g.roster[0].note = 'n'.repeat(121); return JSON.stringify(g); })()],
    ['a line break in a note', (() => { const g = good(); g.roster[0].note = 'a\nb'; return JSON.stringify(g); })()],
    ['a note that is not text', (() => { const g = good(); g.roster[0].note = { a:1 }; return JSON.stringify(g); })()],
    ['an archive flag that is not true or false', (() => { const g = good(); g.roster[0].archived = 'yes'; return JSON.stringify(g); })()],
    ['a negative time', (() => { const g = good(); g.roster[0].createdAt = -1; return JSON.stringify(g); })()],
    ['a time that is not a number', (() => { const g = good(); g.roster[0].updatedAt = '1790000000'; return JSON.stringify(g); })()],
    ['a worker that is not a record', (() => { const g = good(); g.roster[0] = 'Joe'; return JSON.stringify(g); })()],
    ['a roster that is not a list', (() => { const g = good(); g.roster = { 0:g.roster[0] }; return JSON.stringify(g); })()],
    ['1,001 workers, each one valid', (() => { const g = good(); const w = g.roster[0]; g.roster = Array.from({ length:1001 }, () => Object.assign({}, w, { id:require('crypto').randomBytes(16).toString('base64url') })); return JSON.stringify(g); })()],
    ['a job with a malformed ID', (() => { const g = good(); g.jobs[0].id = 'B'.repeat(11);   /* right length, but not a canonical ID: the last character carries four bits, so it is one of sixteen, and B is not one */ return JSON.stringify(g); })()],
    ['two jobs with one ID', (() => { const g = good(); g.jobs[1].id = g.jobs[0].id; return JSON.stringify(g); })()],
    ['markup in a job name', (() => { const g = good(); g.jobs[0].name = 'Oak <img src=x onerror="window.__y=1">'; return JSON.stringify(g); })()],
    ['a 161-character address', (() => { const g = good(); g.jobs[0].address = 'a'.repeat(161); return JSON.stringify(g); })()],
    ['a control character in an address', (() => { const g = good(); g.jobs[0].address = 'a\u0007b'; return JSON.stringify(g); })()],
    ['an unchecked crew list', (() => { const g = good(); g.crew.lists = [{ listId:a.boss.id, evil:true }]; return JSON.stringify(g); })()],
    ['an unchecked report', (() => { const g = good(); g.crew.reports = [{ listId:a.boss.id, workerId:a.boss.id }]; return JSON.stringify(g); })()],
    ['a crew section of the wrong shape', (() => { const g = good(); g.crew = { lists:'x' }; return JSON.stringify(g); })()],
    ['a file over the size cap', JSON.stringify(Object.assign(good(), { pad:'x'.repeat(5300000) }))]
  ];
  const stateBefore = await snap();
  for(let i = 0; i < bad.length; i++){
    dialogs.seen.length = 0;
    await pickFile('.wrap input[data-import]', tmpFile('bad' + i + '.json', bad[i][1]));
    await until('/Not restored/.test(document.getElementById("sheet-root").textContent)', 6000, 'refusal sheet for ' + bad[i][0]);
    const same = (await snap()) === stateBefore;
    ok(same && dialogs.seen.length === 0 && await ev('!window.__y'), 'refused whole, nothing changed: ' + bad[i][0], await text('#sheet-root .sheet p'));
    await click('[data-action="sheet-close"]'); await until('!document.getElementById("sheet-root").innerHTML', 3000, 'refusal sheet closed');
  }
  // A backup with no crew section is valid and leaves crew data alone (rule 8).
  { const g = good(); delete g.crew; g.junk = { a:1 }; g.settings.junk = 'dropped'; g.roster[0].junk = '<b>'; g.jobs[0].phone = 'x'; delete g.jobs[1].address;
    dialogs.answer = true;
    await pickFile('.wrap input[data-import]', tmpFile('nocrew.json', JSON.stringify(g)));
    await until('location.hash==="#/home"', 6000, 'restore without a crew section');
    ok((await raw('notebuiltpro.settings')) === A && (await raw('notebuiltpro.roster')) === AR && (await raw('notebuiltpro.jobs')) === AJ, 'a backup with no lists section restores; unknown keys are dropped and a missing address reads as none'); }

  // ---- day ---------------------------------------------------------------------------------
  section('Day');
  await setup('Mike');
  await listsReady();
  ok(await ev('indexedDB.databases().then(function(d){return d.some(function(x){return x.name==="notebuiltpro"})})'), 'the lists are read once there is a name, and not before');
  await click('[data-go="crew"]'); await addRec('Joe'); await addRec('Maria'); await addRec('Zed');
  await goHome(); await click('[data-go="jobs"]'); await addRec('Oak St reno', '12 Oak St'); await goHome();
  ok(/No lists yet/.test(await text('#home-days')), 'Home says there are no lists yet', await text('#home-days'));
  const boss3 = JSON.parse(await raw('notebuiltpro.settings')).boss, crew3 = await stored('roster'), job3 = (await stored('jobs'))[0];
  const wid = n => crew3.find(w => w.name === n).id;
  const DAYR = '#/day/' + job3.id + '/' + today, SENDR = '#/send/' + job3.id + '/' + today;
  await click('[data-go="day"]');
  ok((await ev('location.hash')) === '#/day' && (await ev('document.getElementById("day-date").value')) === today && (await names('#day-jobs')).join() === 'Oak St reno', 'Days opens on today, with the jobs to pick from');
  ok(!(await overflow()), 'Days: no horizontal scroll at 320px', await overflow());
  await ev('(function(){var d=document.getElementById("day-date");d.value="2027-03-05";d.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  await click('#day-jobs [data-action="day-open"]'); await until('location.hash===' + q('#/day/' + job3.id + '/2027-03-05'), 4000, 'the picked day');
  ok(/Mar 5/.test(await text('.topbar .eyebrow')), 'picking another day opens that day, and the header says which', await text('.topbar .eyebrow'));
  await ev('history.back()'); await until('location.hash==="#/day"', 4000, 'back to Days');
  ok((await ev('document.getElementById("day-date").value')) === '2027-03-05', 'and Days remembers the day that was picked');
  await ev('(function(){var d=document.getElementById("day-date");d.value="";return true})()'); await click('#day-jobs [data-action="day-open"]'); await sleep(200);
  ok((await ev('location.hash')) === '#/day' && /Pick a day first/.test(await text('#toast')), 'with no day picked, tapping a job goes nowhere and says why');
  await ev('(function(){var d=document.getElementById("day-date");d.value=' + q(today) + ';d.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  await click('#day-jobs [data-action="day-open"]');
  ok((await ev('location.hash')) === DAYR && (await ev('history.state.d')) === 3 && (await text('.topbar h1')) === 'Oak St reno', 'tapping a job opens that job\u2019s day, as its own history entry', await ev('location.hash'));
  ok((await dump()).length === 0, 'opening a day writes nothing');
  await type('#task-new', 'Hang 6 doors'); await click('[data-action="task-add"]');
  await until('/Tap who/.test(document.getElementById("task-new-msg").textContent)', 3000, 'no worker picked');
  await chip('Joe');
  ok((await text('#task-new-msg')) === '' && (await ev('document.getElementById("task-new").value')) === 'Hang 6 doors', 'picking who clears the message and keeps what was typed');
  await type('#task-new', ''); await click('[data-action="task-add"]');
  await until('/Type the task/.test(document.getElementById("task-new-msg").textContent)', 3000, 'empty task');
  await type('#task-new', 'x'.repeat(201));
  await until('/200 characters\\. This one is 201/.test(document.getElementById("task-new-msg").textContent)', 3000, '201 characters, while typing');
  await click('[data-action="task-add"]'); await sleep(250);
  await type('#task-new', 'Fix <b>door'); await click('[data-action="task-add"]');
  await until('/markup/.test(document.getElementById("task-new-msg").textContent)', 3000, 'markup');
  ok((await dump()).length === 0 && (await taskCount()) === 0, 'nobody picked, no words, 201 characters and markup are each refused, and nothing is written');
  await type('#task-new', 'x'.repeat(200)); await sleep(150);
  ok((await text('#task-new-msg')) === '', 'exactly 200 characters is allowed');
  await type('#task-new', '');
  await ev('window.__field=document.getElementById("task-new"),true');
  await addTask('Joe', 'Hang 6 doors, unit 204'); await addTask(null, 'Case the windows in 204'); await addTask(null, '  Fill and sand trim  ');
  ok(await ev('document.activeElement===window.__field && window.__field===document.getElementById("task-new") && window.__field.value===""'), 'after Add the field is the same node, still focused and empty, so the keyboard stays up');
  await addTask('Maria', 'Prime bedroom walls'); await addTask(null, 'Cut in ceilings');
  let L = (await dump())[0];
  ok((await dump()).length === 1 && ID_RE.test(L.listId) && Object.keys(L).join() === 'listId,createdAt,updatedAt,boss,job,day,workers,tasks,sent,queue', 'the first task makes one list with a permanent ID, stored in a fixed key order', Object.keys(L).join());
  ok(L.boss.id === boss3.id && L.boss.name === 'Mike' && L.job.id === job3.id && L.job.name === 'Oak St reno' && L.day === today, 'it carries the boss, the job and the day');
  ok(L.workers.map(w => w.id).join() === [wid('Joe'), wid('Maria')].sort().join() && L.workers.every(w => Object.keys(w).join() === 'id,name'), 'only people with a task are on it, kept in ID order');
  ok(L.tasks.map(t => t.id).join() === '1,2,3,4,5' && L.tasks.map(t => t.order).join() === '1,2,3,4,5' && L.tasks.every(t => t.gone === null && Object.keys(t).join() === 'id,worker,text,order,editedAt,gone' && Math.abs(t.editedAt - NOW) < 900), 'tasks get short list-scoped IDs, an order and an edit time', JSON.stringify(L.tasks[0]));
  ok(L.tasks.slice(0, 3).every(t => t.worker === wid('Joe')) && L.tasks.slice(3).every(t => t.worker === wid('Maria')) && L.tasks[2].text === 'Fill and sand trim', 'each task is assigned to whoever was picked, and the name stays picked between tasks; text is trimmed');
  ok(JSON.stringify(L.sent) === '{}' && JSON.stringify(L.queue) === '{}', 'nothing is recorded as sent');
  ok(JSON.stringify(await dayStates()) === JSON.stringify({ Joe:'new', Maria:'new' }), 'the screen groups tasks by worker, sorted by name, each marked not sent', JSON.stringify(await dayStates()));
  await addTask('Zed', '&lt;i&gt; cut < 8ft & "trim" \'x\'');
  ok(await ev('(function(){var b=Array.prototype.slice.call(document.querySelectorAll("#day-body .task-text")).pop();return b.textContent===' + q('&lt;i&gt; cut < 8ft & "trim" \'x\'') + ' && b.children.length===0})()'), 'task text is escaped where it is drawn');
  ok(!(await overflow()), 'Day with tasks: no horizontal scroll at 320px', await overflow());
  await shot('20-day-dark-320');

  // Reorder.
  const joeTexts = () => ev('JSON.stringify(Array.prototype.map.call(document.querySelectorAll(' + q('.tasks[data-wid="' + wid('Joe') + '"] .task-text') + '),function(e){return e.textContent}))').then(JSON.parse);
  ok(await ev('(function(){var t=document.querySelectorAll(' + q('.tasks[data-wid="' + wid('Joe') + '"] .task') + ');return t[0].querySelector("[data-action=task-up]").disabled && !t[0].querySelector("[data-action=task-down]").disabled && t[2].querySelector("[data-action=task-down]").disabled})()'), 'the first task cannot move up and the last cannot move down');
  await click('.tasks[data-wid="' + wid('Joe') + '"] .task:nth-child(2) [data-action="task-up"]');
  await until('document.querySelector(' + q('.tasks[data-wid="' + wid('Joe') + '"] .task-text') + ').textContent==="Case the windows in 204"', 4000, 'moved up');
  { const M = (await dump())[0], t1 = M.tasks.find(t => t.id === '1'), t2 = M.tasks.find(t => t.id === '2');
    ok(t2.order === 1 && t1.order === 2 && t1.editedAt >= L.tasks[0].editedAt && M.tasks.find(t => t.id === '4').order === 4 && (await joeTexts()).join('|') === 'Case the windows in 204|Hang 6 doors, unit 204|Fill and sand trim', 'moving a task up swaps it with the one above, and only those two change', JSON.stringify(M.tasks.map(t => [t.id, t.order]))); }
  await click('.tasks[data-wid="' + wid('Joe') + '"] .task:nth-child(1) [data-action="task-down"]');
  await until('document.querySelector(' + q('.tasks[data-wid="' + wid('Joe') + '"] .task-text') + ').textContent==="Hang 6 doors, unit 204"', 4000, 'moved down');
  ok(true, 'and moving it down puts it back');

  // Edit and reassign.
  await openTask('Fill and sand trim'); await type('#task-text', 'Fill, sand and caulk trim'); await click('[data-action="task-save"]'); await closed('task saved');
  { const M = (await dump())[0], t = M.tasks.find(x => x.id === '3');
    ok(t.text === 'Fill, sand and caulk trim' && t.worker === wid('Joe') && M.tasks.length === 6, 'changing a task\u2019s words keeps its ID and its owner'); }
  { const b4 = JSON.stringify(await dump()); await openTask('Cut in ceilings'); await click('[data-action="task-save"]'); await closed();
    ok(JSON.stringify(await dump()) === b4, 'saving a task with nothing changed writes nothing'); }
  await openTask('Cut in ceilings'); await chip('Zed', '#task-who-chips'); await click('[data-action="task-save"]'); await closed('reassigned');
  { const M = (await dump())[0], t = M.tasks.find(x => x.id === '5');
    ok(t.worker === wid('Zed') && t.gone === null && t.order === 7 && M.tasks.length === 6, 'reassigning with a chip moves the task to that worker, at the end of their list; nothing is removed', JSON.stringify(t)); }
  await openTask('Cut in ceilings'); await type('#task-text', 'x'.repeat(201)); await click('[data-action="task-save"]');
  await until('/200 characters/.test(document.getElementById("task-text-msg").textContent)', 3000, 'long edit refused');
  dialogs.answer = true; await ev('history.back()'); await closed();
  ok((await dump())[0].tasks.find(x => x.id === '5').text === 'Cut in ceilings', 'a 201-character edit is refused and the task is left as it was');

  // Cancel asks first, removes nothing, and can be undone.
  await openTask('Prime bedroom walls'); dialogs.seen.length = 0; dialogs.answer = false;
  await click('[data-action="task-cancel"]'); await sleep(250);
  ok(dialogs.seen.length === 1 && /Cancel \u201cPrime bedroom walls\u201d\? Nothing is deleted/.test(dialogs.seen[0]) && /hasn\u2019t been sent to Maria yet/.test(dialogs.seen[0]), 'cancelling a task asks first, and says it was never sent', dialogs.seen.join('|'));
  ok((await dump())[0].tasks.find(x => x.id === '4').gone === null && await ev('!!document.getElementById("task-text")'), 'declining changes nothing');
  dialogs.answer = true; await click('[data-action="task-cancel"]'); await closed('cancelled');
  { const M = (await dump())[0], t = M.tasks.find(x => x.id === '4');
    ok(t.gone === 'cancelled' && t.worker === wid('Maria') && M.tasks.length === 6 && /Prime bedroom walls/.test(await text('#day-gone')) && !('Maria' in (await dayStates())), 'accepting keeps the task and marks it cancelled; it moves under Cancelled', JSON.stringify(t)); }
  await openTask('Prime bedroom walls'); await click('[data-action="task-restore"]'); await closed('brought back');
  ok((await dump())[0].tasks.find(x => x.id === '4').gone === null && 'Maria' in (await dayStates()) && await ev('!document.getElementById("day-gone")'), 'and Bring back restores it');

  // Restart, the stack, and typing that would be lost.
  const DAY1 = JSON.stringify(await dump());
  await reload(); await listsReady(); await until('document.querySelectorAll("#day-body .task").length===6', 5000, 'tasks after reload');
  ok((await ev('location.hash')) === DAYR && JSON.stringify(await dump()) === DAY1, 'the day survives a reload, and reopening it writes nothing');
  await load(); await listsReady(); await until('document.querySelectorAll("#day-body .task").length===6', 5000, 'tasks after a cold open');
  ok((await ev('location.hash')) === DAYR, 'a cold open comes back to the day it was on');
  await type('#task-new', 'Half a task'); dialogs.seen.length = 0; dialogs.answer = false;
  await ev('history.back()'); await sleep(350);
  ok(dialogs.seen.length === 1 && /Discard the task you typed\? It hasn\u2019t been added\./.test(dialogs.seen[0]) && (await ev('location.hash')) === DAYR && (await ev('document.getElementById("task-new").value')) === 'Half a task' && (await ev('history.state.d')) === 3, 'backing out with a task typed and not added asks first, and No stays put with the words intact', dialogs.seen.join('|') + ' ' + await ev('location.hash'));
  dialogs.seen.length = 0; await click('[data-action="send-open"]'); await sleep(250);
  ok(dialogs.seen.length === 1 && (await ev('location.hash')) === DAYR, 'so does leaving by a button');
  await ev('location.hash="#report=1ZZZZ"'); await sleep(300);
  ok(/Add or clear the task you typed first/.test(await text('#toast')) && (await ev('location.href')).indexOf('report=') < 0 && (await ev('document.getElementById("task-new").value')) === 'Half a task', 'a report link tapped mid-task is stripped from the address and the words are kept');
  dialogs.answer = true; dialogs.seen.length = 0; await ev('history.back()'); await sleep(300);
  ok(dialogs.seen.length === 0 && (await ev('location.hash')) === DAYR && (await ev('document.getElementById("task-new").value')) === 'Half a task', 'back off that stripped link lands on the same day, so nothing is asked and nothing is lost');
  await ev('history.back()');
  await until('location.hash==="#/day"', 4000, 'back to Days');
  ok(JSON.stringify(await dump()) === DAY1, 'Yes leaves, and the half-typed task was never saved');
  ok((await names('#day-past')).join() === 'Oak St reno' && /6 tasks · 3 not sent/.test(await text('#day-past')), 'Days lists the day so far, with its count and what is not sent', await text('#day-past'));
  await ev('history.back()'); await until('location.hash==="#/home"', 4000, 'home');
  ok(/1 day so far/.test(await text('#home-days')) && /Today · 6 tasks/.test(await text('#home-lists')), 'and Home shows today\u2019s list', await text('#home-lists'));
  await click('#home-lists [data-list]'); await until('location.hash===' + q(DAYR), 4000, 'day from home');
  await openTask('Cut in ceilings'); await chip('Maria', '#task-who-chips'); dialogs.seen.length = 0; dialogs.answer = false;
  await ev('history.back()'); await sleep(300);
  ok(dialogs.seen.length === 1 && /Discard what you typed/.test(dialogs.seen[0]) && await ev('!!document.getElementById("task-text")'), 'picking a different person in the task sheet counts as unsaved typing');
  dialogs.answer = true; await ev('history.back()'); await closed();
  await goHome();
  for(const h of ['#/day/' + nodeId() + '/' + today, '#/day/' + job3.id + '/2026-02-30', '#/day/' + job3.id, '#/send', '#/send/' + job3.id + '/' + today + '/x', '#/crew/' + job3.id + '/' + today]){
    await load(h); await sleep(150);
    if((await ev('location.hash')) !== '#/home') ok(false, 'a day route that does not check out falls back to Home', h + ' → ' + await ev('location.hash')); }
  ok(true, 'a job that is not on this phone, an impossible date, and a malformed route all land on Home');

  // A phone still on the stage 2 shape: schema 2, with a day already on it.
  { const st = JSON.parse(await raw('notebuiltpro.settings')); st.schemaVersion = 2;
    await seed([['notebuiltpro.settings', JSON.stringify(st)], ['notebuiltpro.roster', await raw('notebuiltpro.roster')], ['notebuiltpro.jobs', await raw('notebuiltpro.jobs')]]);
    await load(DAYR); await listsReady(); await until('document.querySelectorAll("#day-body .task").length===6', 5000, 'day on a schema 2 phone'); await sleep(200);
    ok(JSON.parse(await raw('notebuiltpro.settings')).schemaVersion === 2, 'a phone on schema 2 opens its day without being moved up');
    await addTask('Joe', 'One more');
    ok(JSON.parse(await raw('notebuiltpro.settings')).schemaVersion === 4 && JSON.parse(await raw('notebuiltpro.settings__bak')).schemaVersion === 2, 'the first list write stamps schema 4, after the list is down, and keeps the old settings as the backup copy'); }

  // ---- send ---------------------------------------------------------------------------------
  section('Send');
  const REAL = ['Hang 6 doors, unit 204', 'Case the windows in 204 and 206', 'Fill, sand and caulk the trim in the hall', 'Install baseboard in bedrooms 1 and 2', 'Set the vanity in the main bath and shim it level',
    'Cut in and hang the closet shelving, unit 206', 'Fix the squeak in the stair tread, third from top', 'Swap the back door weatherstrip and adjust the latch', 'Patch the drywall behind the old thermostat', 'Sweep up and haul scrap to the bin before 4'];
  await setup('Mike'); await listsReady();
  await click('[data-go="crew"]'); await addRec('Joe'); await addRec('Maria'); await addRec('Zed');
  await goHome(); await click('[data-go="jobs"]'); await addRec('Oak St reno'); await goHome();
  const crewS = await stored('roster'), jobS = (await stored('jobs'))[0], bossS = JSON.parse(await raw('notebuiltpro.settings')).boss;
  const sw = n => crewS.find(w => w.name === n).id;
  const DAYS = '#/day/' + jobS.id + '/' + today, SENDS = '#/send/' + jobS.id + '/' + today;
  const one = async () => (await dump()).find(l => l.day === today);
  const toDay = async () => { await load(DAYS); await listsReady(); await until('!!document.getElementById("day-body")', 4000, 'day'); };
  const toSend = async () => { await load(SENDS); await listsReady(); await hookShare(); await measured(); };
  await toDay();
  for(let i = 0; i < REAL.length; i++) await addTask(i ? null : 'Joe', REAL[i]);
  await addTask('Maria', 'Prime bedroom walls'); await addTask(null, 'Cut in ceilings');
  await click('[data-action="send-open"]'); await until('location.hash===' + q(SENDS), 4000, 'send'); await hookShare(); await measured();
  ok((await ev('history.state.d')) === 4, 'Send is its own history entry above the day');
  let cs = await cards();
  ok(cs.map(c => c.name).join() === 'Joe,Maria' && cs.every(c => c.state === 'new' && !c.refused), 'Send lists each worker with something to send, sorted by name');
  ok(cs[0].parts.length === 1 && cs[0].parts[0].chars <= 700, 'a realistic 10-task list measures as ONE part: ' + cs[0].parts[0].chars + ' characters', JSON.stringify(cs[0].parts));
  ok((await text('#send-next')) === 'Send Joe\u2019s list', 'the queue starts with the first worker', await text('#send-next'));
  { const M = await one(); ok(JSON.stringify(M.sent) === '{}' && JSON.stringify(M.queue) === '{}' && (await shares()).length === 0, 'measuring stored nothing and opened no share sheet'); }
  ok(!(await overflow()), 'Send: no horizontal scroll at 320px', await overflow());
  ok((await ev('Array.prototype.every.call(document.querySelectorAll(".send-w .part"),function(p){var b=p.querySelectorAll("button.btn");return b.length===2&&b[0].dataset.action==="send-copy"&&b[0].textContent==="Copy link"&&b[1].dataset.action==="send-part"})&&document.querySelectorAll(".send-w .part").length===2')),
    'every part row has Copy link beside Send, before anything has failed');
  ok(!(await ev('!!document.getElementById("probe")||!!document.querySelector("[data-action=share-probe]")||typeof shareProbe!=="undefined"')), 'the temporary share sheet test is gone');
  // GATE (th_nbp_tick_affordance): nothing that marks a part sent until it has gone out.
  ok((await ev('document.querySelectorAll(".tick,[data-action=send-mark],[data-action=send-unmark],[data-action=send-tick]").length')) === 0, 'GATE: before any Send or Copy link there is no Mark sent, and no bare circle, anywhere on Send');
  { const lab = JSON.parse(await ev('JSON.stringify(Array.prototype.map.call(document.querySelectorAll(".send-w .part .part-label"),function(e){return {t:e.textContent,tag:e.tagName,ctl:!!e.closest("button,a,[data-action],[role=button],[tabindex]")}}))'));
    ok(lab.length === 2 && lab.every(l => l.t === 'One text' && l.tag === 'SPAN' && !l.ctl), '"One text" is a plain label, not a control and inside none', JSON.stringify(lab)); }
  { const b4 = JSON.stringify(await one()), app4 = await ev('document.getElementById("app").innerHTML');
    await ev('window.__shareMeta=[],window.__clip=null,true');
    await realTap('.send-w[data-wid="' + sw('Joe') + '"] .part-label'); await sleep(400);
    ok(b4 === JSON.stringify(await one()) && app4 === (await ev('document.getElementById("app").innerHTML')) && (await shares()).length === 0 && (await ev('window.__shareMeta.length')) === 0 && (await ev('window.__clip')) === null,
      'GATE: tapping the parts label does nothing: no share, no copy, nothing written, the screen unchanged'); }
  await shot('21-send-dark-320');
  await click('#send-next'); await until('document.querySelector(".send-w .part").dataset.out==="share"', 5000, 'Joe handed over');
  let sh = await shares();
  { const c = await card('Joe'), M = await one();
    ok(c.state === 'part' && !c.parts[0].done && c.pill === 'Not sent' && !M.sent[sw('Joe')] && M.queue[sw('Joe')].parts[0].done === false && M.queue[sw('Joe')].parts[0].out.how === 'share',
      'GATE: a share that resolves marks nothing sent, and nothing is recorded as sent', JSON.stringify(c));
    ok(/^Handed to the share sheet \S/.test(c.parts[0].outText) && c.parts[0].outText.indexOf(await ev('sentLabel(' + M.queue[sw('Joe')].parts[0].out.at + ')')) > 0 && c.parts[0].mark && !c.parts[0].undo,
      'Joe\u2019s row says what the app knows, handed to the share sheet and when, with a worded Mark sent beside it', c.parts[0].outText);
    ok((await ev('(function(){var b=document.querySelector(' + q('.send-w[data-wid="' + sw('Joe') + '"] .part' + MARK) + ');return b.tagName==="BUTTON"&&b.textContent==="Mark sent"})()')) && (await ev('!document.querySelector(".tick")')), 'the control says Mark sent in words; there is no bare circle');
    ok((await text('#send-count')) === '0 of 2 sent' && (await text('#send-next')) === 'Send Maria\u2019s list', 'the count stays 0 of 2, and the queue moves on to Maria', await text('#send-count')); }
  { const r = JSON.parse(await ev('(function(){var L=lists[0],w=Object.keys(L.queue)[0],f=function(v){var c=JSON.parse(JSON.stringify(L));if(v===undefined)delete c.queue[w].parts[0].out;else c.queue[w].parts[0].out=v;var k=cleanList(c);return k?JSON.stringify(k.queue[w].parts[0].out||null):"refused"};'
      + 'return JSON.stringify([f(L.queue[w].parts[0].out),f(undefined),f({how:"sms",at:1790000000}),f({how:"share"}),f({how:"copy",at:-5}),f("share"),f({how:"copy",at:1790000000,x:1})])})()'));
    ok(r[0] !== 'refused' && JSON.parse(r[0]).how === 'share' && r[1] === 'null' && r[2] === 'refused' && r[3] === 'refused' && r[4] === 'refused' && r[5] === 'refused' && r[6] === JSON.stringify({ how:'copy', at:1790000000 }),
      'a stored part\u2019s out is judged: share or copy with a good time, or absent; anything else refuses the list, and unknown keys are dropped', JSON.stringify(r)); }
  await toSend();
  ok((await card('Joe')).parts[0].out === 'share' && /^Handed to the share sheet/.test((await card('Joe')).parts[0].outText), 'reopened, the row still says it was handed over');
  // GATE: a mark can be undone from the same row, and the undo puts back exactly what was there.
  { const B4 = await one(), app4 = await ev('document.getElementById("app").innerHTML'), bare = l => JSON.stringify(Object.assign({}, l, { updatedAt:0 }));
    await inCard('Joe', '.part' + MARK); await until('document.querySelector(".send-w").dataset.state==="sent"', 5000, 'Joe marked');
    const c = await card('Joe');
    ok((await text('#send-count')) === '1 of 2 sent' && c.parts[0].done && c.parts[0].undo && !c.parts[0].mark && /^Handed to the share sheet \S.*\. Marked sent\.$/.test(c.parts[0].outText), 'only the boss\u2019s Mark sent makes Joe sent, and the row then offers Undo', JSON.stringify(c));
    await inCard('Joe', '.part' + UNMARK); await until('document.querySelector(".send-w").dataset.state==="part"', 5000, 'Joe unmarked');
    ok(bare(await one()) === bare(B4) && app4 === (await ev('document.getElementById("app").innerHTML')), 'GATE: Undo restores the row exactly: the same screen, and the same stored list, sent map and all', bare(await one()).slice(0, 200));
    await inCard('Joe', '.part' + MARK); await until('document.querySelector(".send-w").dataset.state==="sent"', 5000, 'Joe marked again'); }
  const JOE1 = linkOf(sh[0]);
  ok(sh.length === 1 && Object.keys(sh[0]).join() === 'text' && sh[0].text.split('\n')[0] === 'Mike: tasks for Oak St reno, ' + (await ev('dayLabel(' + q(today) + ')')), 'the share sheet gets one line saying whose tasks, for which job and day', sh[0].text.split('\n')[0]);
  ok(JOE1.indexOf('https://notebuilt.ca/#crew=') === 0 && JOE1.length === cs[0].parts[0].chars && JOE1.length <= 700, 'and the link that was measured, ' + JOE1.length + ' characters');
  { const d = await decode(JOE1), v = d.value || {};
    ok(d.ok && v.mode === 'private' && v.workers.length === 1 && v.workers[0].id === sw('Joe') && v.workers[0].name === 'Joe', 'the link decodes as a private list for Joe alone', JSON.stringify(d).slice(0, 200));
    ok(v.tasks.map(t => t.text).join('|') === REAL.join('|') && v.tasks.every(t => t.worker === sw('Joe') && t.gone === null), 'with his ten tasks, in order');
    ok(JSON.stringify(v).indexOf('Prime bedroom') < 0 && JSON.stringify(v).indexOf(sw('Maria')) < 0, 'and nothing of Maria\u2019s');
    ok(v.listId === (await one()).listId && v.boss.id === bossS.id && v.job.id === jobS.id && v.day === today && v.part === 1 && v.parts === 1, 'it carries the list\u2019s ID, the boss, the job and the day, as part 1 of 1'); }
  { const M = await one(), s = M.sent[sw('Joe')];
    ok(s && s.ids.length === 10 && s.at >= NOW - 5 && M.queue[sw('Joe')].parts.every(p => p.done) && !M.sent[sw('Maria')], 'the sent map records what Joe was given and when; Maria has nothing recorded', JSON.stringify(M.sent)); }
  { const c = await card('Joe');
    ok((await text('#send-next')) === 'Send Maria\u2019s list' && c.parts.length === 1 && c.parts[0].done && c.parts[0].undo, 'the queue moves on to the next worker, and Joe\u2019s row stays, marked sent, so the mark can still be undone', JSON.stringify(c)); }
  ok((await text('#send-count')) === '1 of 2 sent', 'and the queue says how far through it is', await text('#send-count'));
  // The share sheet opens and never comes back: the phone closed the app behind it.
  await ev('window.__shareFail="hang",true'); await click('#send-next'); await sleep(500);
  { const M = await one(), qm = M.queue[sw('Maria')];
    ok(qm && qm.parts.length === 1 && qm.parts[0].done === false && !M.sent[sw('Maria')], 'the send is written down while the share sheet is still open', JSON.stringify(M.queue));
    await toSend(); const c = await card('Maria');
    ok(c.state === 'part' && c.parts.length === 1 && !c.parts[0].done && (await one()).queue[sw('Maria')].parts[0].link === qm.parts[0].link && (await text('#send-next')) === 'Send Maria\u2019s list', 'reopened, Maria\u2019s part is there unticked, the same link, ready to send');
    ok(!c.parts[0].mark && !c.parts[0].out && (await ev('document.querySelectorAll(' + q('.send-w[data-wid="' + sw('Maria') + '"] [data-action=send-mark]') + ').length')) === 0, 'GATE: a send that never came back from the share sheet offers no Mark sent', JSON.stringify(c));
    const b4 = JSON.stringify(await one()); await ev('markPart(' + q(sw('Maria')) + ',0,true)');
    ok(JSON.stringify(await one()) === b4, 'and marking it anyway, from the code, writes nothing: a part that has not gone out cannot be marked'); }
  // Backing out of the share sheet is not a send.
  await ev('window.__shareFail="AbortError",true'); await click('#send-next'); await sleep(400);
  { const M = await one(), c = await card('Maria');
    ok(c.state === 'part' && c.parts.length === 1 && !c.parts[0].done && c.pill === 'Not sent' && !M.sent[sw('Maria')] && (await shares()).length === 0, 'backing out of the share sheet ticks nothing', JSON.stringify(c));
    ok(M.queue[sw('Maria')] && M.queue[sw('Maria')].parts.length === 1 && M.queue[sw('Maria')].parts[0].done === false, 'and the send stays written down');
    ok(c.note === 'closed' && /Not sent\. The share sheet was closed/.test(c.text), 'and Maria\u2019s row says it did not go', JSON.stringify(c)); }
  // GATE (th_nbp_share_gesture): a phone only opens the share sheet straight from a tap.
  await ev('window.__shareMeta=[],true'); await tapSync('#send-next'); await sleep(300);
  { const m = JSON.parse(await ev('JSON.stringify(window.__shareMeta)'));
    ok(m.length === 1 && m[0].sync === true, 'GATE: Send calls navigator.share synchronously inside the tap handler, before any await', JSON.stringify(m)); }
  await realTap('#send-next'); await until('window.__shareMeta.length===2', 4000, 'real tap shared');
  { const m = JSON.parse(await ev('JSON.stringify(window.__shareMeta)'));
    ok(m[1].active === true, 'GATE: on a real tap the page still holds user activation when share is called', JSON.stringify(m)); }
  await sleep(300);
  await ev('window.__clipSync=null,Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:function(t){window.__clipSync=!!window.__inTap;window.__clip=t;return Promise.resolve()}}}),true');
  // GATE: a share the phone refuses, or one that throws, is not a send.
  for(const fail of ['NotAllowedError', 'throw']){
    await ev('window.__shareFail=' + q(fail) + ',true'); await click('#send-next');
    await until('!!document.getElementById("sheet-root").innerHTML', 4000, 'copy sheet');
    const M = await one(), c = await card('Maria');
    ok(c.state === 'part' && !c.parts[0].done && c.pill === 'Not sent' && c.note === 'refused' && !M.sent[sw('Maria')] && M.queue[sw('Maria')].parts[0].done === false && (await shares()).length === 0,
      'GATE: a rejected share (' + fail + ') leaves Maria unticked, and her row says it did not go', JSON.stringify(c));
    ok(/wouldn\u2019t open the share sheet/.test(await sheetText()) && /then tap Mark sent/.test(await sheetText()) && (await ev('!!document.querySelector("#sheet-root [data-action=send-copy]")')) && !c.parts[0].mark, 'and the text is shown with a Copy button, which is a tap of its own; nothing can be marked yet');
    if(fail === 'NotAllowedError'){ await ev('closeSheet(),true'); await sleep(200); continue; }
    await ev('window.__shareFail=null,window.__clip=null,true'); await tapSync('#sheet-root [data-action="send-copy"]');
    await until('!document.getElementById("sheet-root").innerHTML && !!document.querySelector(' + q('.send-w[data-wid="' + sw('Maria') + '"] .part[data-out="copy"]') + ')', 4000, 'copied from the sheet');
    const c2 = await card('Maria');
    ok((await ev('window.__clipSync')) === true && /\n/.test(await ev('window.__clip')) && c2.parts[0].mark && !c2.parts[0].done && /^Copied /.test(c2.parts[0].outText), 'Copy in that sheet copies inside its own tap, closes it, and the row then offers Mark sent', JSON.stringify(c2));
  }
  // Copy link: the same send, copied inside the tap, never shared and never marked sent.
  await ev('window.__shareMeta=[],window.__clipSync=null,true');
  await tapSync('.send-w[data-wid="' + sw('Maria') + '"] [data-action="send-copy"]');
  await until('/Copied\\. Paste it into a text to Maria/.test(document.getElementById("toast").textContent)', 4000, 'copy link');
  { const c = await card('Maria'), M = await one();
    ok((await ev('window.__clipSync')) === true && (await ev('window.__shareMeta.length')) === 0, 'Copy link copies inside the tap and never opens the share sheet');
    ok((await ev('window.__clip')) === 'Mike: tasks for Oak St reno, ' + (await ev('dayLabel(' + q(M.day) + ')')) + '\n' + M.queue[sw('Maria')].parts[0].link && !c.parts[0].done && c.parts[0].out === 'copy' && /^Copied \S/.test(c.parts[0].outText) && c.parts[0].mark && !M.sent[sw('Maria')], 'it copies the line and Maria\u2019s queued link, marks nothing, and the row says Copied, with Mark sent', JSON.stringify(c));
    ok((await text('#send-next')) === null && /Everything has gone out\. Tap Mark sent on each one/.test(await text('#send-tickall')) && (await text('#send-count')) === '1 of 2 sent' && !(await ev('!!document.getElementById("send-done")')),
      'with every part handed over and one unmarked, the screen asks for Mark sent, the count stays 1 of 2, and it does not say everything is sent', await text('#app')); }
  await ev('window.__shareFail=null,true'); await inCard('Maria', '.part' + MARK);
  await until('!!document.getElementById("send-done")', 5000, 'everything sent');
  ok((await cards()).every(c => c.state === 'sent') && Object.values((await one()).queue).every(x => x.parts.every(p => p.done)), 'when every worker is marked the screen says everything is sent');
  await ev('history.back()'); await until('location.hash===' + q(DAYS), 4000, 'day');
  ok(JSON.stringify(await dayStates()) === JSON.stringify({ Joe:'sent', Maria:'sent' }) && /Everything is sent/.test(await text('#day-status')), 'and the Day screen agrees');

  // A worst-case list: eight tasks of 200 Cyrillic characters for Zed.
  const WORST = Array.from({ length:8 }, () => cyr(200));
  for(let i = 0; i < WORST.length; i++) await addTask(i ? null : 'Zed', WORST[i]);
  ok(JSON.stringify(await dayStates()) === JSON.stringify({ Joe:'sent', Maria:'sent', Zed:'new' }), 'adding tasks for Zed marks Zed and nobody else', JSON.stringify(await dayStates()));
  await click('[data-action="send-open"]'); await until('location.hash===' + q(SENDS), 4000, 'send'); await measured();
  let z = await card('Zed');
  ok(z.parts.length >= 2 && z.parts.every(p => p.chars <= 700), 'a worst-case list splits: ' + z.parts.length + ' parts, the longest ' + Math.max.apply(null, z.parts.map(p => p.chars)) + ' characters, every one within 700', JSON.stringify(z.parts));
  ok(new RegExp('goes as ' + z.parts.length + '\\.').test(z.text) && (await text('#send-next')) === 'Send Zed\u2019s list, part 1 of ' + z.parts.length, 'the part count is shown before anything is sent', await text('#send-next'));
  ok((await card('Joe')).state === 'sent' && (await card('Maria')).state === 'sent' && Object.values((await one()).queue).every(x => x.parts.every(p => p.done)), 'the others stay sent');
  await shot('22-send-parts-dark-320');
  await sendOne(); await until('(function(){var p=document.querySelector(".part");return p&&p.dataset.done==="1"})()', 5000, 'part 1 marked');
  const QZ = (await one()).queue[sw('Zed')], NP = QZ.parts.length;
  { const M = await one(), s = M.sent[sw('Zed')]; z = await card('Zed');
    ok(z.state === 'part' && z.pill === '1 of ' + NP + ' sent' && z.parts[0].done && z.parts.slice(1).every(p => !p.done), 'part 1 has its own Mark sent, and Zed shows as part sent');
    ok(s && s.at === 0 && s.ids.join() === QZ.parts[0].ids.slice().sort().join() && s.ids.length < 8, 'what part 1 carried is recorded as given, but Zed is not recorded as sent', JSON.stringify(s));
    ok(QZ.parts.every(p => p.link.length <= 700) && QZ.parts.length === NP && (await text('#send-next')) === 'Send Zed\u2019s list, part 2 of ' + NP, 'the queue holds every link of this send and moves to part 2'); }
  { const got = []; for(const p of QZ.parts) got.push(await decode(p.link));
    const vs = got.map(g => g.value || {}), ids = [].concat.apply([], vs.map(v => (v.tasks || []).map(t => t.id)));
    ok(got.every(g => g.ok) && new Set(vs.map(v => v.sendId)).size === 1 && vs[0].sendId === QZ.sendId && vs.every((v, i) => v.part === i + 1 && v.parts === NP), 'every part decodes, under one sendId, numbered 1 to ' + NP);
    ok(ids.length === 8 && new Set(ids).size === 8 && [].concat.apply([], vs.map(v => v.tasks.map(t => t.text))).join('|') === WORST.join('|'), 'each task travels in exactly one part, and the order holds across parts');
    const fwd = await ev('(async function(ls){var m=null;for(var i=0;i<ls.length;i++){m=EGSCrew.mergeList(m,(await EGSCrew.decode(ls[i].slice(ls[i].indexOf("#crew=")+6),"list")).value).list}return JSON.stringify([m.tasks,EGSCrew.partsStatus(m.send)])})(' + JSON.stringify(QZ.parts.map(p => p.link)) + ')');
    const rev2 = await ev('(async function(ls){var m=null;for(var i=ls.length-1;i>=0;i--){m=EGSCrew.mergeList(m,(await EGSCrew.decode(ls[i].slice(ls[i].indexOf("#crew=")+6),"list")).value).list}return JSON.stringify([m.tasks,EGSCrew.partsStatus(m.send)])})(' + JSON.stringify(QZ.parts.map(p => p.link)) + ')');
    ok(fwd === rev2 && JSON.parse(fwd)[1].complete === true && JSON.parse(fwd)[0].length === 8, 'on the worker\u2019s side the parts merge to the same complete list in either order'); }
  // The sent map survives a restart mid-queue.
  const MID = JSON.stringify(await one());
  await toSend();
  ok(JSON.stringify(await one()) === MID, 'a cold restart mid-queue keeps the sent map and the queue, byte for byte');
  z = await card('Zed');
  ok(z.state === 'part' && z.parts.length === NP && z.parts[0].done && z.parts.slice(1).every(p => !p.done) && (await text('#send-next')) === 'Send Zed\u2019s list, part 2 of ' + NP, 'and the screen comes back with part 1 marked and part 2 next', JSON.stringify(z.parts));
  await inCard('Zed', '.part[data-n="0"]' + UNMARK); await until('document.querySelector(' + q('.send-w[data-wid="' + sw('Zed') + '"] .part') + ').dataset.done==="0"', 4000, 'unmarked');
  { const M = await one(), z0 = (await card('Zed')).parts[0];
    ok(M.queue[sw('Zed')].parts[0].done === false && !M.sent[sw('Zed')] && (await card('Zed')).pill === 'Not sent' && z0.mark && /^Handed to the share sheet \S/.test(z0.outText),
      'a mark can be undone if the text did not go: what part 1 recorded as given goes too, and the row offers Mark sent again', JSON.stringify(M.sent)); }
  await inCard('Zed', '.part[data-n="0"]' + MARK); await until('document.querySelector(' + q('.send-w[data-wid="' + sw('Zed') + '"] .part') + ').dataset.done==="1"', 4000, 'marked again');
  ok(JSON.stringify((await one()).sent) === JSON.stringify(JSON.parse(MID).sent), 'marked again, the sent map is what it was before the undo');
  await ev('window.__shares=[],true');
  for(let i = 1; i < NP; i++){ await sendOne(); await until('document.querySelectorAll(' + q('.send-w[data-wid="' + sw('Zed') + '"] .part[data-done="1"]') + ').length===' + (i + 1) + ' || document.querySelector(' + q('.send-w[data-wid="' + sw('Zed') + '"]') + ').dataset.state==="sent"', 5000, 'part ' + (i + 1));
    if(i < NP - 1 && (await card('Zed')).state === 'sent') ok(false, 'Zed counts as sent only when every part is marked', 'sent after part ' + (i + 1) + ' of ' + NP); }
  await until('document.querySelector(' + q('.send-w[data-wid="' + sw('Zed') + '"]') + ').dataset.state==="sent"', 5000, 'Zed sent');
  sh = await shares();
  ok(sh.length === NP - 1 && sh.every((s, i) => linkOf(s) === QZ.parts[i + 1].link && new RegExp('\\(part ' + (i + 2) + ' of ' + NP + '\\)$').test(s.text.split('\n')[0])), 'after the restart the remaining parts go out as the SAME send, each labelled with its part');
  { const M = await one(), s = M.sent[sw('Zed')];
    ok(s.at === QZ.at && s.at > 0 && s.ids.length === 8 && M.queue[sw('Zed')].parts.every(p => p.done) && !!(await ev('!!document.getElementById("send-done")')), 'Zed counts as sent only once every part is marked, as of when the links were measured'); }
  // Undoing the last mark takes Zed back to part sent, with exactly the sent map he had before it.
  { const all = JSON.stringify((await one()).sent);
    await inCard('Zed', '.part[data-n="' + (NP - 1) + '"]' + UNMARK); await until('document.querySelector(' + q('.send-w[data-wid="' + sw('Zed') + '"]') + ').dataset.state==="part"', 4000, 'last unmarked');
    const M = await one(), s = M.sent[sw('Zed')], want = [].concat.apply([], QZ.parts.slice(0, NP - 1).map(p => p.ids)).sort();
    ok(s.at === 0 && s.ids.join() === want.join() && (await card('Zed')).pill === (NP - 1) + ' of ' + NP + ' sent' && (await text('#send-tickall')) !== null, 'undoing the last mark makes Zed part sent again, with only what the other parts carried recorded', JSON.stringify(s));
    await inCard('Zed', '.part[data-n="' + (NP - 1) + '"]' + MARK); await until('document.querySelector(' + q('.send-w[data-wid="' + sw('Zed') + '"]') + ').dataset.state==="sent"', 4000, 'last marked again');
    ok(JSON.stringify((await one()).sent) === all, 'and marking it again gives back the same sent map, byte for byte'); }

  // An edit after sending marks the right workers and no others.
  await toDay();
  ok(JSON.stringify(await dayStates()) === JSON.stringify({ Joe:'sent', Maria:'sent', Zed:'sent' }), 'everyone starts sent');
  await openTask(REAL[4]); await type('#task-text', 'Set the vanity in the main bath, shim and silicone'); await click('[data-action="task-save"]'); await closed();
  ok(JSON.stringify(await dayStates()) === JSON.stringify({ Joe:'changed', Maria:'sent', Zed:'sent' }) && /1 person has something not sent/.test(await text('#day-status')), 'changing one of Joe\u2019s tasks marks Joe "changes not sent" and nobody else', JSON.stringify(await dayStates()));
  await openTask(REAL[0]); await chip('Maria', '#task-who-chips'); await click('[data-action="task-save"]'); await closed();
  ok(JSON.stringify(await dayStates()) === JSON.stringify({ Joe:'changed', Maria:'changed', Zed:'sent' }), 'giving one of Joe\u2019s tasks to Maria marks both of them, and not Zed', JSON.stringify(await dayStates()));
  await toSend(); await ev('window.__shares=[],true');
  await sendOne(); await until('document.querySelector(' + q('.send-w[data-wid="' + sw('Joe') + '"]') + ').dataset.state==="sent"', 5000, 'Joe resent');
  await sendOne(); await until('!!document.getElementById("send-done")', 5000, 'Maria resent');
  sh = await shares();
  const JOE2 = linkOf(sh[0]), MARIA2 = linkOf(sh[1]);
  { const j = (await decode(JOE2)).value, m = (await decode(MARIA2)).value, moved = j.tasks.find(t => t.text === REAL[0]);
    ok(moved && moved.gone === 'reassigned' && j.tasks.filter(t => !t.gone).length === 9 && j.tasks.find(t => t.id === '5').text === 'Set the vanity in the main bath, shim and silicone', 'Joe\u2019s resend carries the reassigned task as a tombstone, and the new words', JSON.stringify(moved));
    ok(m.tasks.some(t => t.text === REAL[0] && t.gone === null && t.id === moved.id) && m.workers.length === 1 && m.workers[0].id === sw('Maria'), 'Maria\u2019s carries the same task, live'); }
  await toDay();
  await openTask('Cut in ceilings'); dialogs.seen.length = 0; dialogs.answer = true; await click('[data-action="task-cancel"]'); await closed();
  ok(/Maria is told it\u2019s cancelled the next time you send/.test(dialogs.seen[0]) && JSON.stringify(await dayStates()) === JSON.stringify({ Joe:'sent', Maria:'changed', Zed:'sent' }), 'cancelling a task Maria was sent says she will be told, and marks Maria alone', dialogs.seen.join('|') + JSON.stringify(await dayStates()));
  await click('.tasks[data-wid="' + sw('Zed') + '"] .task:nth-child(2) [data-action="task-up"]');
  await until('document.querySelector(' + q('#day-body .grp[data-wid="' + sw('Zed') + '"] .pill') + ').dataset.state==="changed"', 4000, 'Zed changed');
  ok(JSON.stringify(await dayStates()) === JSON.stringify({ Joe:'sent', Maria:'changed', Zed:'changed' }), 'reordering Zed\u2019s tasks marks Zed, and still not Joe');
  await toSend(); await ev('window.__shares=[],true');
  await sendOne(); await until('document.querySelector(' + q('.send-w[data-wid="' + sw('Maria') + '"]') + ').dataset.state==="sent"', 5000, 'Maria resent');
  { const m = (await decode(linkOf((await shares())[0]))).value, c = m.tasks.find(t => t.text === 'Cut in ceilings');
    ok(c && c.gone === 'cancelled' && m.tasks.filter(t => !t.gone).length === 2, 'Maria\u2019s resend carries the cancelled task as a tombstone', JSON.stringify(m.tasks.map(t => [t.id, t.gone]))); }
  // A resend merges into the worker's copy without losing what they did.
  { const out = JSON.parse(await ev('(async function(a,b,wid){var p=function(l){return l.slice(l.indexOf("#crew=")+6)};var first=(await EGSCrew.decode(p(a),"list")).value;var mine=EGSCrew.mergeList(null,first).list;'
      + 'var st=EGSCrew.setStatus({}, "6", "done", "", 1790000100);st=EGSCrew.setStatus(st, "5", "waiting", "Waiting on the plumber", 1790000200);st=EGSCrew.setStatus(st, "1", "done", "", 1790000300);'
      + 'var r=EGSCrew.mergeList(mine,(await EGSCrew.decode(p(b),"list")).value);var rep=EGSCrew.buildReport(r.list,wid,st,1790000400);'
      + 'return JSON.stringify({ok:r.ok,tasks:r.list.tasks,report:rep.tasks,state:st})})(' + q(JOE1) + ',' + q(JOE2) + ',' + q(sw('Joe')) + ')'));
    const t5 = out.tasks.find(t => t.id === '5'), t1 = out.tasks.find(t => t.id === '1'), r5 = out.report.find(t => t.id === '5'), r6 = out.report.find(t => t.id === '6');
    ok(out.ok && out.tasks.length === 10 && t5.text === 'Set the vanity in the main bath, shim and silicone' && t1.gone === 'reassigned', 'merged on the worker\u2019s side, the resend updates the words and marks the task that left');
    ok(r5 && r5.status === 'waiting' && r5.note === 'Waiting on the plumber' && r6 && r6.status === 'done' && !out.report.some(t => t.id === '1') && out.report.length === 9, 'and nothing the worker did is lost: their done and waiting-on marks, and the note, still report', JSON.stringify(out.report.filter(t => t.status !== 'open'))); }
  // Two edits inside one second, then a send in that same second, then another edit.
  { await sendAll();
    const res = JSON.parse(await ev('(async function(job,day,wid){var real=Date.now,T=real.call(Date);Date.now=function(){return T};try{'
      + 'var a=lists[0].tasks.filter(function(t){return t.worker===wid&&!t.gone});'
      + 'await listEdit(job,day,function(r,n){return taskChange(r,n,a[0].id,"once",wid)});await listEdit(job,day,function(r,n){return taskChange(r,n,a[0].id,"twice",wid)});'
      + 'var edited=lists[0].tasks.find(function(t){return t.id===a[0].id}).editedAt;render();'
      + 'for(var i=0;i<200&&(_prep.busy||!_prep.by[wid]);i++)await new Promise(function(r){setTimeout(r,25)});'
      + 'var n=_prep.by[wid].parts.length;for(var p=0;p<n;p++){await sendPart(wid,p);await markPart(wid,p,true)}var afterSend=sendState(lists[0],wid).k,at=lists[0].sent[wid].at;'
      + 'await listEdit(job,day,function(r,n){return taskChange(r,n,a[1].id,"later",wid)});'
      + 'return JSON.stringify({now:Math.floor(T/1000),edited:edited,at:at,afterSend:afterSend,afterEdit:sendState(lists[0],wid).k,second:lists[0].tasks.find(function(t){return t.id===a[1].id}).editedAt})'
      + '}finally{Date.now=real}})(' + q(jobS.id) + ',' + q(today) + ',' + q(sw('Zed')) + ')'));
    ok(res.edited > res.now && res.afterSend === 'sent' && res.at >= res.edited, 'two edits in one second push the edit time past the clock, and the send in that second still counts as covering them', JSON.stringify(res));
    ok(res.afterEdit === 'changed' && res.second > res.at, 'and an edit to another task in that same second is not missed: it is stamped after the send', JSON.stringify(res)); }
  // No share sheet: the link is copied, and copying is not sending.
  await toSend();
  await ev('navigator.share=undefined,Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:function(t){window.__clip=t;return Promise.resolve()}}}),true');
  await ev('window.__clipSync=null,navigator.clipboard.writeText=function(t){window.__clipSync=!!window.__inTap;window.__clip=t;return Promise.resolve()},true');
  await tapSync('#send-next'); await until('/Copied\\. Paste it into a text to Zed, then tap Mark sent\\./.test(document.getElementById("toast").textContent)', 4000, 'copied');
  ok((await ev('window.__clipSync')) === true, 'GATE: with no share sheet, the copy is asked for synchronously inside the tap too');
  ok((await card('Zed')).parts[0].out === 'copy' && /^Copied /.test((await card('Zed')).parts[0].outText), 'and Zed\u2019s row says it is copied, not sent');
  { const c = await card('Zed'); ok(c.state === 'part' && c.parts.every(p => !p.done) && /^Mike: tasks for Oak St reno/.test(await ev('window.__clip')) && (await ev('window.__clip')).split('\n')[1].indexOf('https://notebuilt.ca/#crew=') === 0, 'with no share sheet the same text is copied, and the part is not marked sent for you', JSON.stringify(c)); }
  await inCard('Zed', '.part' + MARK); await until('document.querySelector(' + q('.send-w[data-wid="' + sw('Zed') + '"] .part') + ').dataset.done==="1"', 4000, 'marked by hand');
  ok((await card('Zed')).parts.filter(p => p.done).length === 1 && (await card('Zed')).state === 'part', 'marking it by hand marks that part, and only that part');
  // A copy that fails is not a send either.
  await ev('navigator.clipboard.writeText=function(){return Promise.reject(new Error("no"))},true');
  await click('#send-next'); await until('!!document.getElementById("sheet-root").innerHTML', 4000, 'copy sheet');
  { const c = await card('Zed'); ok(c.parts.filter(p => p.done).length === 1 && c.note === 'nocopy' && /couldn\u2019t be copied/.test(c.text) && /Copy this/.test(await sheetText()), 'a failed copy ticks nothing, the row says so, and the text is shown to copy by hand', JSON.stringify(c)); }
  await ev('closeSheet(),true'); await sleep(200);
  // Make new links is for someone sent with no send kept on this phone, as a restore leaves them.
  await ev('listEdit(' + q(jobS.id) + ',' + q(today) + ',function(r){delete r.queue[' + q(sw('Joe')) + '];return null},true).then(function(){render();return true})'); await measured();
  { const c = await card('Joe');
    ok(c.again && /Make new links$/.test(c.text) && !/Send again/.test(c.text), 'with no links kept, the card says so and its button is Make new links: it does not claim to send', c.text); }
  ok((await ev('(function(b){return b.length>0&&Array.prototype.every.call(b,function(x){return x.textContent==="Send again"})})(document.querySelectorAll(".send-w .part[data-done=\'1\'] [data-action=send-part]"))&&!Array.prototype.some.call(document.querySelectorAll(".send-w button"),function(b){return b.textContent==="Again"})')),
    'a marked part\u2019s own resend says Send again, and nothing is labelled a bare Again');
  const b4again = JSON.stringify(await one());
  await inCard('Joe', '[data-action="send-again"]'); await measured(); await sleep(900);
  { const c = await card('Joe'), b4 = b4again;
    ok(c.parts.length === 1 && !c.parts[0].done && c.state === 'sent' && b4 === JSON.stringify(await one()), 'Make new links measures a fresh send for someone already sent, and stores nothing until it is shared'); }

  // Zed has a send started: one of eight parts marked. Any change to his tasks makes those links stale.
  { const started = async () => { await toSend(); if(!(await one()).queue[sw('Zed')]){ await inCard('Zed', '[data-action="send-part"]'); await until('!!document.querySelector(' + q('.send-w[data-wid="' + sw('Zed') + '"] .part[data-out="share"]') + ')', 5000, 'a part of Zed\u2019s handed over');
        await inCard('Zed', '.part' + MARK); await until('!!document.querySelector(' + q('.send-w[data-wid="' + sw('Zed') + '"] .part[data-done="1"]') + ')', 5000, 'a part of Zed\u2019s marked'); }
      const Q = (await one()).queue[sw('Zed')]; await toDay(); return Q; };
    const dropped = async what => { const M = await one(); ok(!M.queue[sw('Zed')] && (await dayStates()).Zed === 'changed' && M.sent[sw('Zed')].ids.length === 8, what, JSON.stringify(M.queue)); };
    ok(!!(await started()), 'Zed has a send started and not finished');
    await click('.tasks[data-wid="' + sw('Zed') + '"] .task:nth-child(3) [data-action="task-up"]'); await until('document.querySelector(' + q('#day-body .grp[data-wid="' + sw('Zed') + '"] .pill') + ').dataset.state==="changed"', 4000, 'reordered');
    await dropped('reordering his tasks drops the half-finished send: its links no longer say what the list says');
    await started(); const zt = await ev('document.querySelector(' + q('.tasks[data-wid="' + sw('Zed') + '"] .task:nth-child(4) .task-text') + ').textContent');
    await openTask(zt); await type('#task-text', 'Reworded for Zed'); await click('[data-action="task-save"]'); await closed();
    await dropped('so does rewording one');
    await started(); await openTask('Reworded for Zed'); dialogs.answer = true; await click('[data-action="task-cancel"]'); await closed();
    await dropped('so does cancelling one');
    await started(); const before9 = (await one()).tasks.length; await addTask('Zed', 'One more for Zed');
    { const M = await one(); ok(!M.queue[sw('Zed')] && M.tasks.length === before9 + 1 && (await dayStates()).Zed === 'changed', 'and so does adding one', JSON.stringify(M.queue)); }
    await openTask('Reworded for Zed'); await click('[data-action="task-restore"]'); await closed(); }
  // The task that leaves someone with nothing still has to reach them.
  { const D2 = '#/day/' + jobS.id + '/2027-02-01', S2 = '#/send/' + jobS.id + '/2027-02-01';
    const two = async () => (await dump()).find(l => l.day === '2027-02-01');
    await load(D2); await listsReady(); await until('!!document.getElementById("task-new")', 4000, 'second day');
    await addTask('Maria', 'Only task of the day');
    ok((await dump()).length === 2 && (await two()).listId !== (await one()).listId && (await two()).tasks.length === 1, 'a second day for the same job is its own list, with its own ID');
    await load(S2); await listsReady(); await hookShare(); await measured(); await ev('window.__shares=[],true'); await sendAll();
    await load(D2); await listsReady(); await until('!!document.querySelector("#day-body .task")', 4000, 'day 2');
    await openTask('Only task of the day'); await chip('Joe', '#task-who-chips'); await click('[data-action="task-save"]'); await closed();
    ok(JSON.stringify(await dayStates()) === JSON.stringify({ Joe:'new', Maria:'changed' }) && /No tasks now\. They\u2019ll be told on the next send\./.test(await text('#day-body')), 'giving away Maria\u2019s only task leaves her on the list, with nothing, marked changes not sent', JSON.stringify(await dayStates()));
    await load(S2); await listsReady(); await hookShare(); await measured(); await ev('window.__shares=[],true');
    await sendIn('Maria'); await until('document.querySelector(' + q('.send-w[data-wid="' + sw('Maria') + '"]') + ').dataset.state==="sent"', 5000, 'Maria told');
    const m = (await decode(linkOf((await shares())[0]))).value;
    ok(m.tasks.length === 1 && m.tasks[0].gone === 'reassigned' && m.tasks[0].text === 'Only task of the day' && m.workers[0].id === sw('Maria'), 'her link carries that task as a tombstone and nothing else', JSON.stringify(m.tasks));
    ok((await card('Joe')).state === 'new' && (await card('Maria')).state === 'sent', 'and telling her does not count as sending Joe his'); }

  // ---- the three refusals -------------------------------------------------------------------
  section('The three refusals (rule 12)');
  const LONGHAN = han(200);
  await toDay(); await addTask('Zed', LONGHAN);
  await toSend(); await ev('window.__shares=[],true');
  z = await card('Zed');
  ok(z.refused === 'task_too_long' && z.parts.length === 0, 'ONE TASK TOO LONG: a 200-character Chinese task is refused for Zed before any share sheet', JSON.stringify(z).slice(0, 300));
  ok(z.text.indexOf('\u201c' + Array.from(LONGHAN).slice(0, 40).join('') + '\u2026\u201d is too long to send in a link. Shorten it, then send again.') >= 0, 'it names the task and asks for a shorter one', z.text);
  ok(!/name/i.test(z.text.replace('Zed', '')) && z.fix && /Shorten this task/.test(z.text), 'it does not blame the names');
  ok(await ev('!document.querySelector(' + q('.send-w[data-wid="' + sw('Zed') + '"] [data-action="send-part"]') + ')') && (await text('#send-next')) === null && /Nothing else can go until/.test(await text('#app')), 'there is nothing to tap that would send it, and the queue does not offer it');
  ok(!(await card('Joe')).refused && !(await card('Maria')).refused && (await card('Joe')).state === 'sent' && (await card('Maria')).state === 'sent', 'the others are not refused, and stay sent');
  ok(!(await one()).queue[sw('Zed')] && (await shares()).length === 0, 'nothing was queued for Zed and nothing was shared');
  ok(!(await overflow()), 'a refusal: no horizontal scroll at 320px', await overflow());
  await shot('23-refusal-task-dark-320');
  await inCard('Zed', '[data-action="send-fix"]'); await until('!!document.getElementById("task-text")', 3000, 'task sheet from the refusal');
  ok((await ev('document.getElementById("task-text").value')) === LONGHAN, 'Shorten this task opens that very task');
  await type('#task-text', 'Short enough now'); await click('[data-action="task-save"]'); await closed(); await measured();
  z = await card('Zed');
  ok(!z.refused && z.parts.length >= 1 && z.parts.every(p => p.chars <= 700), 'shortened, the refusal goes and Zed\u2019s list measures', JSON.stringify(z.parts));
  // The third case cannot happen with today's limits (spec §6). The component
  // is made to say it, to prove the app shows it plainly and sends nothing.
  await ev('window.__split=EGSCrew.split,EGSCrew.split=function(){return Promise.resolve({ok:false,code:"cannot_fit",reason:EGSCrew.REASONS.cannot_fit})},rev++,render(),true'); await measured();
  z = await card('Zed');
  ok(z.refused === 'cannot_fit' && /This is too big to send as links, however it is split\./.test(z.text) && !z.fix && z.parts.length === 0, 'THE WHOLE LIST CANNOT FIT (unreachable today; the component is stubbed to say so): shown plainly, with nothing to send and nothing blamed', z.text);
  ok(!/too long to send|names leave no room/.test(z.text) && (await shares()).length === 0, 'and it is not dressed up as either of the other two');
  await ev('EGSCrew.split=window.__split,rev++,render(),true'); await measured();

  // The names alone leave no room: three unrelated 40-character names in rare characters.
  const N1 = rare(40), N2 = rare(40), N3 = rare(40);
  await wipe(); await load(); await type('#boss-name', N1); await click('[data-action="setup-save"]'); await until('!!document.querySelector(".topbar")', 8000, 'home'); await listsReady();
  await click('[data-go="crew"]'); await addRec(N3); await addRec('Joe'); await goHome(); await click('[data-go="jobs"]'); await addRec(N2); await goHome();
  { const jb2 = (await stored('jobs'))[0], cr2 = await stored('roster');
    await load('#/day/' + jb2.id + '/' + today); await listsReady(); await until('!!document.getElementById("task-new")', 4000, 'day');
    await addTask(N3, 'Sweep up'); await addTask('Joe', 'Sweep the hall');
    await load('#/send/' + jb2.id + '/' + today); await listsReady(); await hookShare(); await measured();
    const c = await card(N3), j = await card('Joe');
    ok(c.refused === 'names_too_long' && c.parts.length === 0, 'THE NAMES LEAVE NO ROOM: three 40-character names in rare characters are refused before any share sheet', JSON.stringify(c).slice(0, 200));
    const named = [N1, N2, N3].filter(n => c.text.indexOf('\u201c' + n + '\u201d takes the most room') >= 0);
    ok(/The names leave no room for tasks in a link\./.test(c.text) && named.length === 1, 'it says it is the names, and says which name');
    ok(c.text.indexOf('Sweep up') < 0 && !/too long to send in a link/.test(c.text) && c.fix && /Shorten this name/.test(c.text), 'it never blames the task');
    ok(!j.refused || j.refused === 'names_too_long', 'Joe, beside the same two long names, is ' + (j.refused ? 'refused for the names too' : 'not refused') + ': never for his task', j.refused);
    ok((await shares()).length === 0 && JSON.stringify((await dump())[0].queue) === '{}', 'nothing was shared and nothing queued');
    await shot('24-refusal-names-dark-320'); ok(!(await overflow()), 'the names refusal: no horizontal scroll at 320px', await overflow());
    await inCard(N3, '[data-action="send-fix"]'); await until('!!document.querySelector("#sheet-root input[data-name-input]")', 3000, 'name sheet from the refusal');
    ok((await ev('document.querySelector("#sheet-root input[data-name-input]").value')) === named[0], 'Shorten this name opens the sheet for the very name it quoted');
    await type('#sheet-root input[data-name-input]', 'Short'); await ev('document.querySelector("#sheet-root .btn.primary").click()'); await closed(); await measured();
    const cs2 = await cards();
    ok(cs2.length === 2 && cs2.every(x => !x.refused && x.parts.length === 1 && x.parts[0].chars <= 700), 'the shorter name reaches the very next measurement, and with one name shortened both lists fit: ' + cs2.map(x => x.name.slice(0, 5) + '=' + x.parts.map(p => p.chars).join('+')).join(', '), JSON.stringify(cs2.map(x => [x.refused, x.parts.length])));
    await click('#send-next'); await until('window.__shares.length===1', 5000, 'shared'); const d2 = (await decode(linkOf((await shares())[0]))).value;
    ok([d2.boss.name, d2.job.name, d2.workers[0].name].indexOf('Short') >= 0 && [d2.boss.name, d2.job.name, d2.workers[0].name].indexOf(named[0]) < 0, 'and the link that goes out carries the new name, not the one the list was first saved with'); }

  // ---- lists in a backup ----------------------------------------------------------------------
  section('Lists in a backup');
  await setup('Mike'); await listsReady();
  await click('[data-go="crew"]'); await addRec('Joe'); await addRec('Maria'); await goHome(); await click('[data-go="jobs"]'); await addRec('Oak St reno'); await addRec('Alder duplex'); await goHome();
  const jbB = await stored('jobs'), crB = await stored('roster');
  const DB1 = '#/day/' + jbB[0].id + '/' + today, SB1 = '#/send/' + jbB[0].id + '/' + today;
  await load(DB1); await listsReady(); await until('!!document.getElementById("task-new")', 4000, 'day');
  await addTask('Joe', 'Hang 6 doors'); await addTask(null, 'Case the windows'); await addTask('Maria', 'Prime walls');
  await load(SB1); await listsReady(); await hookShare(); await measured();
  await sendOne(); await until('document.querySelector(".send-w").dataset.state==="sent"', 5000, 'Joe sent');
  await ev('window.__shareFail="AbortError",true'); await click('#send-next'); await sleep(400);
  await load('#/day/' + jbB[1].id + '/2027-01-15'); await listsReady(); await until('!!document.getElementById("task-new")', 4000, 'second day'); await addTask('Maria', 'Demo the kitchen');
  const LB = await dump(), LSB = await snap();
  ok(LB.length === 2 && (Q => Object.keys(Q).length === 2 && Object.values(Q).filter(x => x.parts.every(p => p.done)).length === 1)(LB.find(l => l.day === today).queue) && Object.keys(LB.find(l => l.day === today).sent).length === 1, 'the phone holds two lists: one sent to Joe, with a send to Maria started and not finished');
  await load('#/support'); await listsReady();
  had = fs.readdirSync(work); await click('[data-action="export"]');
  const FL = await download(had), TL = fs.readFileSync(path.join(work, FL), 'utf8'), BL = JSON.parse(TL); fs.renameSync(path.join(work, FL), path.join(work, 'lists.json'));
  const noQueue = ls => JSON.stringify(ls.map(l => Object.assign({}, l, { queue:{} })).sort((x, y) => x.listId < y.listId ? -1 : 1));
  ok(BL.settings.schemaVersion === 4 && BL.crew.lists.length === 2 && noQueue(BL.crew.lists) === noQueue(LB) && BL.crew.lists.every(l => JSON.stringify(l.queue) === '{}'), 'the backup carries both lists as stored, sent map included, and leaves the unfinished send behind');
  ok(TL.indexOf('#crew=') < 0, 'so no list link is written into the file');
  await wipe(); await load(); dialogs.seen.length = 0;
  await pickFile('.setup input[data-import]', path.join(work, 'lists.json'));
  await until('!!document.querySelector(".topbar")', 8000, 'home after restore'); await listsReady();
  ok((await raw('notebuiltpro.roster')) === JSON.stringify(crB) && (await raw('notebuiltpro.jobs')) === JSON.stringify(jbB) && LSB.indexOf(JSON.stringify(JSON.stringify(crB))) > 0, 'the restored crew and jobs are as they were');
  ok(noQueue(await dump()) === noQueue(LB) && /2 days so far/.test(await text('#home-days')), 'export, wipe, restore: both lists come back identical, same list IDs, same sent map', await text('#home-days'));
  await load(DB1); await listsReady(); await until('document.querySelectorAll("#day-body .task").length===3', 5000, 'restored tasks');
  ok(JSON.stringify(await dayStates()) === JSON.stringify({ Joe:'sent', Maria:'new' }), 'and Joe is still sent, Maria still not', JSON.stringify(await dayStates()));
  await load('#/support'); await listsReady(); had = fs.readdirSync(work); await click('[data-action="export"]');
  { const f = await download(had), t = fs.readFileSync(path.join(work, f), 'utf8'), st = x => x.replace(/"exportedAt": "[^"]*"/, '"exportedAt": ""'); fs.renameSync(path.join(work, f), path.join(work, 'lists2.json'));
    ok(st(t) === st(TL), 'export again: the two files are byte-identical apart from the export time'); }
  dialogs.seen.length = 0; dialogs.answer = false;
  await pickFile('.wrap input[data-import]', path.join(work, 'lists.json')); await sleep(400);
  ok(dialogs.seen.length === 1 && /Mike, 2 on the crew, 2 jobs, 2 lists\./.test(dialogs.seen[0]), 'restoring over lists asks first and says how many lists the file holds', dialogs.seen.join('|'));
  // Lists on a phone that has lost its name are still something a restore would replace.
  { const keepL = await dump(); await wipe(); await seed([]); await seedLists(keepL); await load();
    ok(await ev('!!document.getElementById("boss-name")') && (await snap()) === '[]', 'a phone with lists but no name is at first run');
    dialogs.seen.length = 0; dialogs.answer = false;
    await pickFile('.setup input[data-import]', path.join(work, 'lists.json')); await sleep(600);
    ok(dialogs.seen.length === 1 && /REPLACES/.test(dialogs.seen[0]) && noQueue(await dump()) === noQueue(keepL) && await ev('!!document.getElementById("boss-name")'), 'restoring there still asks first, because the file\u2019s lists would replace the ones on the phone; declining leaves them', dialogs.seen.join('|'));
    dialogs.answer = true; await pickFile('.setup input[data-import]', path.join(work, 'lists.json')); await until('!!document.querySelector(".topbar")', 8000, 'restored'); await listsReady();
    await load('#/support'); await listsReady(); }
  // A file with no lists section leaves the lists alone (rule 8).
  { const g = JSON.parse(TL); delete g.crew; dialogs.answer = true; const b4 = JSON.stringify(await dump());
    await pickFile('.wrap input[data-import]', tmpFile('nolists.json', JSON.stringify(g))); await until('location.hash==="#/home"', 6000, 'restored without lists');
    ok(/Mike, 2 on the crew, 2 jobs\.$/.test(dialogs.seen[dialogs.seen.length - 1]) && JSON.stringify(await dump()) === b4 && /2 days so far/.test(await text('#home-days')), 'a backup with no lists section restores and leaves this phone\u2019s lists as they are'); }
  // A file whose list is changed but valid restores: the refusals below are not vacuous.
  { const g = JSON.parse(TL); g.crew.lists[0].tasks[0].text = 'Changed in the file'; g.crew.lists[0].junk = { a:1 }; g.crew.lists[0].tasks[0].junk = '<b>';
    g.crew.lists[0].queue = { [g.crew.lists[0].workers[0].id]:{ sendId:'AAAAAAAA', at:NOW, parts:[{ link:'https://evil.example/#crew=1AAAA', ids:[], done:false }] } };
    await load('#/support'); await listsReady(); dialogs.answer = true;
    await pickFile('.wrap input[data-import]', tmpFile('changed.json', JSON.stringify(g))); await until('location.hash==="#/home"', 6000, 'changed list restored');
    const now2 = await dump(), l0 = now2.find(l => l.listId === g.crew.lists[0].listId);
    ok(l0.tasks[0].text === 'Changed in the file' && !('junk' in l0) && !('junk' in l0.tasks[0]) && JSON.stringify(l0.queue) === '{}' && JSON.stringify(now2).indexOf('evil.example') < 0, 'a valid file restores its lists; unknown keys are dropped, and so is any queue the file carries, link and all'); }
  await load('#/support'); await listsReady(); dialogs.answer = true;
  await pickFile('.wrap input[data-import]', path.join(work, 'lists.json')); await until('location.hash==="#/home"', 6000, 'back to the good file');
  await load('#/support'); await listsReady();
  { const gl = () => JSON.parse(TL), first = g => g.crew.lists.find(l => l.day === today);
    const badLists = [
      ['a list with a malformed ID', g => { first(g).listId = 'B'.repeat(11); }],
      ['a list that is not a record', g => { g.crew.lists[0] = 'list'; }],
      ['markup in a task', g => { first(g).tasks[0].text = '<img src=x onerror="window.__y=1">'; }],
      ['a 201-character task', g => { first(g).tasks[0].text = 'x'.repeat(201); }],
      ['a task with no words', g => { first(g).tasks[0].text = '   '; }],
      ['a task for someone not on the list', g => { first(g).tasks[0].worker = nodeId(); }],
      ['two tasks with one ID', g => { first(g).tasks[1].id = first(g).tasks[0].id; }],
      ['a task ID of the wrong shape', g => { first(g).tasks[0].id = '01'; }],
      ['a tombstone kind the boss\u2019s copy never holds', g => { first(g).tasks[0].gone = 'reassigned'; }],
      ['an unknown tombstone kind', g => { first(g).tasks[0].gone = 'deleted'; }],
      ['an edit time that is not a number', g => { first(g).tasks[0].editedAt = '1790000000'; }],
      ['an impossible day', g => { first(g).day = '2026-02-30'; }],
      ['markup in the list\u2019s job name', g => { first(g).job.name = 'Oak <script>window.__y=1</script>'; }],
      ['a malformed boss ID in a list', g => { first(g).boss.id = 'short'; }],
      ['a list with nobody on it', g => { first(g).workers = []; first(g).tasks = []; first(g).sent = {}; }],
      ['31 people on one list', g => { first(g).workers = Array.from({ length:31 }, (_, i) => ({ id:nodeId(), name:'W' + i })); first(g).tasks = []; first(g).sent = {}; }],
      ['301 tasks on one list', g => { const w = first(g).workers[0].id; first(g).tasks = Array.from({ length:301 }, (_, i) => ({ id:(i + 1).toString(36), worker:w, text:'t', order:i + 1, editedAt:NOW, gone:null })); first(g).sent = {}; }],
      ['a sent record for someone not on the list', g => { first(g).sent[nodeId()] = { at:NOW, ids:[] }; }],
      ['a sent record naming a task that is not on the list', g => { const k = Object.keys(first(g).sent)[0]; first(g).sent[k].ids.push('zz'); }],
      ['a sent record naming one task twice', g => { const k = Object.keys(first(g).sent)[0]; first(g).sent[k].ids.push(first(g).sent[k].ids[0]); }],
      ['a sent time that is negative', g => { const k = Object.keys(first(g).sent)[0]; first(g).sent[k].at = -5; }],
      ['a sent map that is a list', g => { first(g).sent = []; }],
      ['no sent map at all', g => { delete first(g).sent; }],
      ['a list time that is not a number', g => { first(g).updatedAt = 'now'; }],
      ['one list ID twice', g => { g.crew.lists[1].listId = g.crew.lists[0].listId; }],
      ['two lists for one job\u2019s day', g => { g.crew.lists[1].job = JSON.parse(JSON.stringify(g.crew.lists[0].job)); g.crew.lists[1].day = g.crew.lists[0].day; }],
      ['a report alongside good lists', g => { g.crew.reports = [{ listId:g.crew.lists[0].listId, workerId:g.crew.lists[0].workers[0].id }]; }]
    ];
    const lsBefore = await snap(), dbBefore = JSON.stringify(await dump());
    for(let i = 0; i < badLists.length; i++){
      const g = gl(); badLists[i][1](g); dialogs.seen.length = 0;
      await pickFile('.wrap input[data-import]', tmpFile('badlist' + i + '.json', JSON.stringify(g)));
      await until('/Not restored/.test(document.getElementById("sheet-root").textContent)', 6000, 'refusal sheet for ' + badLists[i][0]);
      ok((await snap()) === lsBefore && JSON.stringify(await dump()) === dbBefore && dialogs.seen.length === 0 && await ev('!window.__y'), 'refused whole, nothing changed: ' + badLists[i][0], await text('#sheet-root .sheet p'));
      await click('[data-action="sheet-close"]'); await until('!document.getElementById("sheet-root").innerHTML', 3000, 'refusal sheet closed');
    } }

  // ---- lists this phone cannot read ----------------------------------------------------------
  section('Damaged lists');
  { const good2 = JSON.stringify(await dump());
    ok((await ev('(function(){var l=lists.find(function(x){return x.tasks.length===3});return listPut(Object.assign({},l,{tasks:l.tasks.filter(function(t){return t.id!=="3"})}))})()')) === false && (await ev('(function(){var l=JSON.parse(JSON.stringify(lists.find(function(x){return Object.keys(x.sent).length})));l.sent={};return listPut(l)})()')) === false && JSON.stringify(await dump()) === good2, 'a list write that would drop a task, or forget what someone was sent, is refused');
    await ev(`new Promise(function(res){var r=indexedDB.open('notebuiltpro');r.onsuccess=function(){var d=r.result,tx=d.transaction('lists','readwrite');tx.objectStore('lists').put({listId:'not-a-list',job:{name:'<img src=x onerror="window.__q=1">'}});tx.oncomplete=function(){d.close();res(true)}}})`);
    const bad2 = JSON.stringify(await dump());
    await load('#/day'); await until('listsState==="damaged"', 6000, 'damaged lists');
    ok(/can\u2019t read the lists saved on this phone/.test(await text('#app')) && await ev('!window.__q && !document.querySelector("#app img") && !document.getElementById("day-past") && !document.getElementById("day-jobs")'), 'a stored list that fails the check is never drawn: Days says it cannot read the lists, and offers nothing to build on');
    ok(JSON.stringify(await dump()) === bad2, 'and leaves them all untouched');
    await load(DB1); await sleep(300);
    ok(await ev('!document.getElementById("task-new")') && /can\u2019t read the lists/.test(await text('#app')), 'a day cannot be opened or added to while they are unreadable');
    await load('#/support'); await sleep(300); await click('[data-action="export"]'); await sleep(700);
    ok(backups().length === 0 && /didn\u2019t make a backup/.test(await text('#toast')), 'export refuses rather than write a backup with the lists missing', await text('#toast'));
    await load('#/day'); await until('listsState==="damaged"', 6000, 'damaged lists');
    dialogs.seen.length = 0; dialogs.answer = false; await click('[data-action="lists-fresh"]'); await sleep(250);
    ok(dialogs.seen.length === 1 && /Start again with no lists\?/.test(dialogs.seen[0]) && JSON.stringify(await dump()) === bad2, 'Start again with no lists asks first, and declining removes nothing', dialogs.seen.join('|'));
    dialogs.answer = true; await click('[data-action="lists-fresh"]'); await until('listsState==="ready" && !!document.getElementById("day-jobs")', 5000, 'fresh lists');
    ok((await dump()).length === 0 && (await stored('roster')).length === 2 && (await stored('jobs')).length === 2, 'accepting removes the lists and keeps the crew and the jobs'); }

  // ---- back resolver -------------------------------------------------------------------
  section('Back and the hash');
  await load('#/home'); await sleep(200);
  const HERE = await raw('notebuiltpro.settings');
  await click('[data-go="settings"]'); ok((await ev('location.hash')) === '#/settings', 'Settings writes a history entry');
  await click('[data-go="privacy"]'); ok((await ev('location.hash')) === '#/privacy' && /What I collect/.test(await text('#app')), 'Privacy opens from Settings');
  await click('[data-go="support"]'); ok((await ev('location.hash')) === '#/support', 'Support opens from Privacy');
  await ev('history.back()'); await until('location.hash==="#/privacy" && /What I collect/.test(document.getElementById("app").textContent)', 4000, 'back to privacy');
  await click('[data-back]'); await until('location.hash==="#/settings" && !!document.querySelector("[data-action=\\"edit-name\\"]")', 4000, 'arrow back to settings');
  ok(true, 'system back and the header arrow walk the same stack');
  await ev('history.back()'); await until('location.hash==="#/home" && history.state.d===1', 4000, 'back to home');
  await ev('history.back()'); await until('history.state && history.state.g===1 && /Press back again/.test(document.getElementById("toast").textContent)', 4000, 'guard');
  ok(/Today/.test(await text('.topbar h1')), 'back on Home stays in the app and says how to leave');
  await sleep(2300);
  ok((await ev('history.state.d')) === 1 && !(await ev('history.state.g')), 'the guard re-arms after two seconds');
  await click('[data-go="settings"]'); await click('[data-help="look"]');
  await until('/Day, Night and Auto/.test(document.getElementById("sheet-root").textContent)', 3000, 'help sheet');
  ok((await ev('history.state.o')) === 'sheet', 'a sheet owns a history entry while it is open');
  await click('[data-action="sheet-close"]'); await until('!history.state.o && location.hash==="#/settings"', 4000, 'sheet entry consumed');
  ok(await ev('!document.getElementById("sheet-root").innerHTML'), 'closing it by its button consumes that entry');
  await reload(); await sleep(200);
  ok((await ev('location.hash')) === '#/settings' && await ev('!!document.querySelector("[data-action=\\"edit-name\\"]")'), 'a reload stays on the screen it was on');
  await ev('history.back()'); await until('location.hash==="#/home"', 4000, 'back after reload');
  ok(true, 'and back still works after that reload');
  for(const h of ['#/evil', '#/settings<img src=x>', '#/' + 'a'.repeat(200), '#settings', '#/home/../x']){
    await load(h); await sleep(150);
    if((await ev('location.hash')) !== '#/home'){ ok(false, 'hostile hash falls back to Home', h + ' → ' + await ev('location.hash')); }
  }
  ok(true, 'a hash that is not a known view lands on Home');
  await load('#/privacy'); await sleep(150);
  ok((await ev('location.hash')) === '#/privacy', 'a known view in the hash opens it');
  await ev('history.back()'); await until('location.hash==="#/settings"', 4000, 'seeded parent');
  ok(true, 'and its seeded stack leads back through Settings');
  await load('#report=1AAAAbbbbCCCC'); await sleep(250);
  ok((await ev('location.href')).indexOf('report=') < 0 && (await ev('location.hash')) === '#/home', 'a #report= payload is swapped out of the address at once');
  ok(/can’t read reports yet/.test(await text('#sheet-root')), 'and the app says plainly that it cannot read reports yet');
  ok((await raw('notebuiltpro.settings')) === HERE, 'without touching anything');
  await click('[data-action="sheet-close"]'); await sleep(200);
  await ev('location.hash="#report=1ZZZZ"'); await until('location.href.indexOf("report=")<0', 4000, 'in-app report link stripped');
  ok(/A crew report/.test(await text('#sheet-root')), 'a report link tapped while the app is open gets the same treatment');
  await click('[data-action="sheet-close"]'); await sleep(200);

  // ---- share ------------------------------------------------------------------------------
  section('Share');
  await load('#/home'); await ev('navigator.share=function(d){window.__shared=d;return Promise.resolve()},true');
  await click('.topbar [data-share-app]'); await sleep(200);
  { const sh = await ev('JSON.stringify(window.__shared)'), o = JSON.parse(sh);
    ok(o.url === URL0 && Object.keys(o).sort().join() === 'text,title,url', 'the header share icon sends the app link', sh);
    ok(sh.indexOf(JSON.parse(HERE).boss.id) < 0 && sh.indexOf('Mike') < 0, 'and nothing of the user’s'); }
  await click('[data-go="settings"]'); await click('[data-go="support"]'); await ev('window.__shared=null,true');
  await click('.wrap [data-share-app]'); await sleep(200);
  ok((await ev('window.__shared && window.__shared.url')) === URL0, 'the Support page share block uses the same handler');

  // ---- banners -------------------------------------------------------------------------------
  section('Banners');
  await setup('Mike'); await sleep(300);
  ok((await ev('document.querySelectorAll("#banners .banner").length')) === 1 && /Install Notebuilt Pro/.test(await text('#banners')), 'one banner, and install has the slot first');
  await click('[data-action="install-dismiss"]');
  ok((await raw('notebuiltpro.installPromptDismissed')) === '1', 'its dismissal is stored under the app’s own prefix');
  ok((await ev('document.querySelectorAll("#banners .banner").length')) === 0, 'then nothing: a name and an ID alone are not data worth a backup nudge', await text('#banners'));
  await reload(); await sleep(400);
  ok((await ev('document.querySelectorAll("#banners .banner").length')) === 0 && (await raw('notebuiltpro.lastBackupAt')) === null, 'and still nothing after a reload, with no backup ever made');
  // Real data, and then one of two reasons. The browser's answer about keeping
  // storage is forced each way, so the result does not depend on headless Chrome's.
  { const keep = await raw('notebuiltpro.settings'), ids = await newIds(2), DAY = 86400;
    const banner = async persisted => { await sleep(350); await ev('persistedOk=' + persisted + ',renderBanners(),true'); return (await text('#banners')) || ''; };
    const put = async (extra) => { await seed([['notebuiltpro.settings', keep], ['notebuiltpro.installPromptDismissed', '1']].concat(extra)); await load('#/home'); };
    const worker = age => ['notebuiltpro.roster', JSON.stringify([rec(ids[0], 'Joe', 'note', '', NOW - age * DAY)])];
    const job = age => ['notebuiltpro.jobs', JSON.stringify([rec(ids[1], 'Oak St', 'address', '', NOW - age * DAY)])];
    const backup = age => ['notebuiltpro.lastBackupAt', new Date(Date.now() - age * DAY * 1000).toISOString()];
    await put([worker(0)]);
    ok((await banner(true)) === '', 'a worker added today, storage kept: no nudge. New data is not overdue');
    ok(/This browser may clear the app/.test(await banner(false)), 'the same worker, storage not kept: the nudge appears and says why');
    await put([worker(20)]);
    ok((await banner(true)) === '', 'no backup ever, oldest data 20 days old: not yet');
    await put([job(22)]);
    ok(/No backup yet/.test(await banner(true)), 'no backup ever, oldest data 22 days old: overdue, for a job as much as a worker');
    await put([worker(400), backup(20)]);
    ok((await banner(true)) === '', 'a backup 20 days ago: not yet, however old the data');
    await put([worker(400), backup(22)]);
    ok(/Time for a fresh backup/.test(await banner(true)), 'a backup 22 days ago: overdue');
    await put([backup(400)]);
    ok((await banner(false)) === '', 'no crew and no jobs: never, whatever else is true');
    await put([worker(22)]); await banner(true); }
  ok((await ev('document.querySelectorAll("#banners .banner").length')) === 1 && !(await overflow()), 'one banner, and no horizontal scroll at 320px', await overflow());
  await shot('05-home-nudge-320');
  await click('[data-action="nudge-snooze"]');
  { const until7 = +(await raw('notebuiltpro.backupNudgeSnoozeUntil')) - Date.now();
    ok(until7 > 6.9 * 86400000 && until7 <= 7 * 86400000 && (await ev('document.querySelectorAll("#banners .banner").length')) === 0, 'Later snoozes it seven days');
    ok((await ev('persistedOk=false,backupNudgeWanted()')) === false, 'and the snooze holds even when storage is not kept'); }
  // The banner's own button makes the backup, and that clears it.
  { await ev('localStorage.removeItem("notebuiltpro.backupNudgeSnoozeUntil"),persistedOk=true,renderBanners(),true');
    const had1 = fs.readdirSync(work); await click('#banners [data-action="export"]'); const f = await download(had1);
    await sleep(200); await ev('persistedOk=true,renderBanners(),true');
    ok((await text('#banners')) === '' && JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')).roster.length === 1, 'Back up now saves the file, and the nudge goes');
    fs.renameSync(path.join(work, f), path.join(work, 'nudge.json')); }
  ok(JSON.parse(await snap()).every(p => p[0].indexOf('notebuiltpro.') === 0), 'every key on the phone is notebuiltpro.*', await snap());

  // ---- IndexedDB layout ------------------------------------------------------------------------------
  section('IndexedDB');
  const layout = () => ev(`new Promise(function(res){var r=indexedDB.open('notebuiltpro');r.onsuccess=function(){var d=r.result,o={v:d.version,stores:Array.prototype.slice.call(d.objectStoreNames)};
    var tx=d.transaction(o.stores,'readonly');o.lists=tx.objectStore('lists').keyPath;o.reports=tx.objectStore('reports').keyPath;var c=tx.objectStore('reports').count();c.onsuccess=function(){o.n=c.result;d.close();res(JSON.stringify(o))}}})`);
  ok((await layout()) === '{"v":3,"stores":["lists","reports"],"lists":"listId","reports":["listId","workerId"],"n":0}', 'lists are keyed by listId; reports by listId and workerId together, one record per worker per list', await layout());
  const oldDb = withRecord => ev(`new Promise(function(res,rej){var r=indexedDB.open('notebuiltpro',1);r.onupgradeneeded=function(){r.result.createObjectStore('lists',{keyPath:'listId'});var s=r.result.createObjectStore('reports',{keyPath:'listId'});${withRecord ? "s.put({listId:'L1',kept:true});" : ''}};r.onsuccess=function(){r.result.close();res(true)};r.onerror=function(){rej(r.error)}})`);
  const KEEPS = await raw('notebuiltpro.settings');
  const oldPhone = async withRecord => { await wipe(); await seed([['notebuiltpro.settings', KEEPS], ['notebuiltpro.installPromptDismissed', '1']]); await oldDb(withRecord); await load('#/support'); };
  await oldPhone(false); await listsReady();
  ok(/"reports":\["listId","workerId"\],"n":0/.test(await layout()) && /"v":3/.test(await layout()), 'a stage 1 database, with its empty reports store, is re-keyed the first time the lists are read', await layout());
  { const had2 = fs.readdirSync(work); await click('[data-action="export"]'); const f = await download(had2); fs.renameSync(path.join(work, f), path.join(work, 'upgraded.json'));
    ok(true, 'and a backup can be made from it'); }
  await oldPhone(true); await until('listsState==="failed"', 8000, 'lists not opened');
  { await click('[data-action="export"]'); await sleep(900);
    const kept = await ev(`new Promise(function(res){var r=indexedDB.open('notebuiltpro');r.onsuccess=function(){var d=r.result,g=d.transaction('reports').objectStore('reports').get('L1');g.onsuccess=function(){var o={v:d.version,rec:g.result};d.close();res(JSON.stringify(o))}}})`);
    ok(backups().length === 0 && kept === '{"v":1,"rec":{"listId":"L1","kept":true}}', 'if that old store somehow holds a record, the upgrade stops: nothing is dropped and no backup is written without it', kept + ' ' + await text('#toast'));
    await load('#/day'); await until('listsState==="failed"', 8000, 'lists not opened');
    ok(/couldn\u2019t open the storage this phone keeps lists in/.test(await text('#app')) && await ev('!document.getElementById("day-jobs")'), 'and Days says it could not open the lists, and offers nothing to build on', await text('#app')); }

  // ---- a phone holding 128-bit IDs (schema 3 -> 4, IndexedDB 2 -> 3) ------------------------------
  section('Shorter IDs: a phone that holds 128-bit ones');
  { const crypto = require('crypto');
    const longId = () => crypto.randomBytes(16).toString('base64url');
    // The short form, worked out here from the bytes and not with the app's own function.
    const short = id => Buffer.from(id, 'base64url').subarray(0, 8).toString('base64url');
    const LONG_RUN = /[A-Za-z0-9_-]{22}/;
    const O = { boss:longId(), joe:longId(), maria:longId(), sam:longId(), oak:longId(), elm:longId(), list:longId() };
    const rec = (id, name, extra, archived) => Object.assign({ id, name }, extra, { archived:!!archived, createdAt:NOW - 5000, updatedAt:NOW - 5000 });
    const SET3 = JSON.stringify({ schemaVersion:3, boss:{ id:O.boss, name:'Mike' } });
    const ROS3 = JSON.stringify([rec(O.joe, 'Joe', { note:'Framing' }), rec(O.maria, 'Maria', { note:'' }), rec(O.sam, 'Sam', { note:'' }, true)]);
    const JOB3 = JSON.stringify([rec(O.oak, 'Oak St reno', { address:'12 Oak St' }), rec(O.elm, 'Elm Ave', { address:'' })]);
    const LIST3 = { listId:O.list, createdAt:NOW - 4000, updatedAt:NOW - 3000, boss:{ id:O.boss, name:'Mike' }, job:{ id:O.oak, name:'Oak St reno' }, day:today,
      workers:[{ id:O.joe, name:'Joe' }, { id:O.maria, name:'Maria' }].sort((a, b) => a.id < b.id ? -1 : 1),
      tasks:[{ id:'1', worker:O.joe, text:'Hang 6 doors, unit 204', order:1, editedAt:NOW - 4000, gone:null },
             { id:'2', worker:O.maria, text:'Base trim, hallway', order:2, editedAt:NOW - 4000, gone:null },
             { id:'3', worker:O.joe, text:'Haul drywall scrap', order:3, editedAt:NOW - 3500, gone:'cancelled' }],
      sent:{ [O.joe]:{ at:NOW - 3900, ids:['1', '3'] } },
      queue:{ [O.maria]:{ sendId:'N4xvgQX-', at:NOW - 3000, parts:[{ link:'https://notebuilt.ca/#crew=1AAAA', ids:['2'], done:false }] } } };
    ok(Object.values(O).every(x => /^[A-Za-z0-9_-]{21}[AQgw]$/.test(x)) && Object.values(O).every(x => ID_RE.test(short(x)) && x.indexOf(short(x).slice(0, 10)) === 0), 'fixtures: seven 128-bit IDs, and the 64-bit form of each');
    // The database as the stage 3 build left it: version 2, lists under their long listIds.
    const stage3Db = arr => ev(`new Promise(function(res,rej){var r=indexedDB.open('notebuiltpro',2);
      r.onupgradeneeded=function(){var d=r.result;d.createObjectStore('lists',{keyPath:'listId'});d.createObjectStore('reports',{keyPath:['listId','workerId']})};
      r.onsuccess=function(){var d=r.result,tx=d.transaction('lists','readwrite');${JSON.stringify(arr)}.forEach(function(x){tx.objectStore('lists').put(x)});tx.oncomplete=function(){d.close();res(true)};tx.onerror=function(){rej(tx.error)}};
      r.onerror=function(){rej(r.error)}})`);
    const rawDb = () => ev(`new Promise(function(res){var r=indexedDB.open('notebuiltpro');r.onsuccess=function(){var d=r.result,g=d.transaction('lists').objectStore('lists').getAllKeys();g.onsuccess=function(){var o={v:d.version,keys:g.result};d.close();res(JSON.stringify(o))}}})`).then(JSON.parse);
    const PAIRS = [['notebuiltpro.settings', SET3], ['notebuiltpro.roster', ROS3], ['notebuiltpro.jobs', JOB3], ['notebuiltpro.installPromptDismissed', '1']];
    const stage3 = async (lists, pairs) => { await wipe(); await seed(pairs || PAIRS); await stage3Db(lists); };
    const mem = () => ev('JSON.stringify({b:[settings.boss.id,settings.boss.name],r:roster.map(function(w){return [w.id,w.name,w.note,w.archived,w.createdAt]}),j:jobs.map(function(x){return [x.id,x.name,x.address,x.archived,x.createdAt]}),u:unreadable.size})').then(JSON.parse);
    const WANT = { b:[short(O.boss), 'Mike'], r:[[short(O.joe), 'Joe', 'Framing', false, NOW - 5000], [short(O.maria), 'Maria', '', false, NOW - 5000], [short(O.sam), 'Sam', '', true, NOW - 5000]],
                   j:[[short(O.oak), 'Oak St reno', '12 Oak St', false, NOW - 5000], [short(O.elm), 'Elm Ave', '', false, NOW - 5000]], u:0 };
    const DAY4 = '#/day/' + short(O.oak) + '/' + today, SEND4 = '#/send/' + short(O.oak) + '/' + today;

    await stage3([LIST3]); const SEEDED = await snap(); await load('#/home');
    ok(await ev('!!document.querySelector(".topbar")') && /Mike/.test(await text('#app')) && !/can’t read/.test(await text('#app')), 'a stage 3 phone opens on Home under its name: no damaged gate, no first run');
    ok(JSON.stringify(await mem()) === JSON.stringify(WANT), 'the boss, three workers (one archived) and two jobs are all there, each under the first 64 bits of its old ID', JSON.stringify(await mem()));
    ok((await snap()) === SEEDED, 'startup wrote nothing: the phone’s storage is byte-identical until something is saved');
    await load('#/crew'); await sleep(200);
    ok(/Joe/.test(await text('#app')) && /Maria/.test(await text('#app')) && await ev('!!document.querySelector("[data-action=rec-add]")'), 'Crew draws them and offers to add another');
    await load('#/day/' + O.oak + '/' + today); await sleep(200);
    ok((await ev('location.hash')) === '#/home', 'a route still spelled with the long job ID is not a route: Home');
    await load(DAY4); await listsReady(); await until('document.querySelectorAll("#day-body .task").length>=2', 5000, 'the migrated day');
    { const D = await dump(), L = D[0] || {}, db = await rawDb();
      ok(db.v === 3 && db.keys.length === 1 && db.keys[0] === short(O.list), 'the database is at version 3 and the list sits under its short listId alone', JSON.stringify(db));
      ok(D.length === 1 && L.boss.id === short(O.boss) && L.job.id === short(O.oak) && L.day === today && L.createdAt === NOW - 4000 && L.workers.map(w => w.id + w.name).sort().join() === [short(O.joe) + 'Joe', short(O.maria) + 'Maria'].sort().join(),
        'the list kept its boss, job, day and both workers', JSON.stringify(L));
      ok(JSON.stringify(L.tasks.map(t => [t.id, t.worker, t.text, t.order, t.editedAt, t.gone])) === JSON.stringify(LIST3.tasks.map(t => [t.id, short(t.worker), t.text, t.order, t.editedAt, t.gone])),
        'every task is intact and still belongs to the same person, the cancelled one included');
      ok(JSON.stringify(L.sent) === JSON.stringify({ [short(O.joe)]:{ at:NOW - 3900, ids:['1', '3'] } }), 'what Joe had been given is still on record under his short ID', JSON.stringify(L.sent));
      ok(JSON.stringify(L.queue) === '{}', 'the half-finished send is gone: its links were made in the old format');
      ok(!LONG_RUN.test(JSON.stringify(D)), 'no 128-bit ID is left anywhere in the stored list'); }
    ok(/Hang 6 doors/.test(await text('#day-body')) && /Base trim/.test(await text('#day-body')), 'the day draws its tasks');
    ok((await snap()) === SEEDED, 'reading the lists moved the database up and still wrote nothing to localStorage');

    // Usable: the first change writes everything down in the new shape, data before the number.
    await addTask('Maria', 'Shim frames, unit 205');
    await until('JSON.parse(localStorage.getItem("notebuiltpro.settings")).schemaVersion===4', 5000, 'schema 4 stamped');
    { const st = await stored('settings'), ro = await stored('roster'), jo = await stored('jobs');
      ok(st.boss.id === short(O.boss) && st.boss.name === 'Mike' && JSON.stringify(ro) === ROS3.split(O.joe).join(short(O.joe)).split(O.maria).join(short(O.maria)).split(O.sam).join(short(O.sam))
         && JSON.stringify(jo) === JOB3.split(O.oak).join(short(O.oak)).split(O.elm).join(short(O.elm)),
        'the first task added stamps schema 4, and the crew and the jobs went down with short IDs and nothing else changed', JSON.stringify([st, ro, jo]));
      ok((await raw('notebuiltpro.settings__bak')) === SET3 && (await raw('notebuiltpro.roster__bak')) === ROS3 && (await raw('notebuiltpro.jobs__bak')) === JOB3, 'what was there before is kept, byte for byte, as each key’s backup copy');
      ok((await dump())[0].tasks.length === 4 && (await dump())[0].tasks[3].worker === short(O.maria), 'and the new task joined the migrated list'); }
    await load(SEND4); await listsReady(); await hookShare(); await measured(); await ev('window.__shares=[],true');
    await sendAll();
    { const got = []; for(const sh of await shares()) got.push(await decode(linkOf(sh)));
      const by = n => (got.find(r => r.ok && r.value.workers[0].name === n) || {}).value;
      const joe = by('Joe'), maria = by('Maria');
      ok(got.length === 2 && got.every(r => r.ok && r.value.v === 3 && r.value.listId === short(O.list) && r.value.boss.id === short(O.boss) && r.value.job.id === short(O.oak)) && !LONG_RUN.test(JSON.stringify(got.map(r => [r.value.listId, r.value.boss.id, r.value.job.id, r.value.workers]))),
        'the migrated list sends: both links decode as version 3 and carry only short IDs', JSON.stringify(got).slice(0, 400));
      ok(!!joe && !!maria && joe.workers[0].id === short(O.joe) && maria.workers[0].id === short(O.maria) && maria.tasks.map(t => t.text).join('|') === 'Base trim, hallway|Shim frames, unit 205',
        'each person’s link is theirs, under their short ID');
      ok(!!joe && joe.tasks.some(t => t.id === '3' && t.gone === 'cancelled'), 'Joe’s link still carries the tombstone for the task cancelled before the change, because what he was given survived'); }
    await load('#/crew'); await sleep(200);
    { const m = await mem(); ok(JSON.stringify(m) === JSON.stringify(WANT) && /Joe/.test(await text('#app')), 'a cold open after the change reads the short IDs straight from storage', JSON.stringify(m)); }
    { await load('#/support'); await listsReady(); const hadM = fs.readdirSync(work); await click('[data-action="export"]'); const f = await download(hadM);
      const b = JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')); fs.renameSync(path.join(work, f), path.join(work, 'migrated.json'));
      ok(b.settings.schemaVersion === 4 && b.settings.boss.id === short(O.boss) && b.roster.length === 3 && b.jobs.length === 2 && b.crew.lists.length === 1 && b.crew.lists[0].listId === short(O.list)
         && !LONG_RUN.test(JSON.stringify([b.settings.boss.id, b.roster.map(r => r.id), b.jobs.map(j => j.id), b.crew.lists.map(l => [l.listId, l.boss.id, l.job.id, l.workers, Object.keys(l.sent), l.tasks.map(t => t.worker)])])),
        'a backup made now says schema 4 and holds only short IDs'); }

    // A stage 3 phone whose first save is to the crew: the jobs still go down before the number.
    await stage3([LIST3]); await load('#/crew'); await sleep(200); await addRec('Dev', 'Trim');
    await until('JSON.parse(localStorage.getItem("notebuiltpro.settings")).schemaVersion===4', 5000, 'schema 4 stamped by a crew save');
    { const ro = await stored('roster'), jo = await stored('jobs');
      ok(ro.length === 4 && ro.slice(0, 3).map(r => r.id).join() === [O.joe, O.maria, O.sam].map(short).join() && ID_RE.test(ro[3].id) && jo.map(j => j.id).join() === [O.oak, O.elm].map(short).join(),
        'adding a worker first: the crew and the jobs are both written short before schema 4 is stamped', JSON.stringify([ro, jo]));
      ok((await raw('notebuiltpro.roster__bak')) === ROS3 && (await raw('notebuiltpro.jobs__bak')) === JOB3, 'each written once: the backup copies are still the long-ID originals'); }

    // A backup made by the stage 3 build restores the same way, onto a clean phone.
    const B3 = { app:'notebuilt-pro', kind:'backup', version:1, exportedAt:new Date().toISOString(), appVersion:'2026.10.12-1648',
                 settings:JSON.parse(SET3), roster:JSON.parse(ROS3), jobs:JSON.parse(JOB3), crew:{ lists:[Object.assign({}, LIST3, { queue:{} })], reports:[] } };
    fs.writeFileSync(path.join(work, 'long-ids.json'), JSON.stringify(B3));
    await wipe(); await load(); dialogs.answer = true;
    await pickFile('.setup input[data-import]', path.join(work, 'long-ids.json')); await until('!!document.querySelector(".topbar")', 8000, 'old backup restored'); await listsReady();
    { const m = await mem(), D = await dump(), st = await stored('settings');
      ok(JSON.stringify(m) === JSON.stringify(WANT) && st.schemaVersion === 4 && st.boss.id === short(O.boss), 'a backup holding 128-bit IDs restores: same people and jobs, short IDs, schema 4', JSON.stringify(m));
      ok(D.length === 1 && D[0].listId === short(O.list) && D[0].tasks.length === 3 && Object.keys(D[0].sent).join() === short(O.joe) && !LONG_RUN.test(JSON.stringify(D)) && !LONG_RUN.test((await raw('notebuiltpro.roster')) + (await raw('notebuiltpro.jobs'))),
        'and its list, with what was sent, lands under the same short IDs the phone itself would have reached'); }
    // One shape. Where the number says the IDs are short, a long one is a bad ID and nothing more.
    fs.writeFileSync(path.join(work, 'long-ids-v4.json'), JSON.stringify(Object.assign({}, B3, { settings:{ schemaVersion:4, boss:B3.settings.boss } })));
    await wipe(); await load();
    await pickFile('.setup input[data-import]', path.join(work, 'long-ids-v4.json'));
    await until('/Not restored/.test(document.getElementById("sheet-root").textContent)', 6000, 'refusal of long IDs under schema 4');
    ok((await snap()) === '[]' && await ev('!!document.getElementById("boss-name")'), 'the same file claiming schema 4 is refused whole: a long ID gets no second reading there');
    const SET4 = JSON.stringify({ schemaVersion:4, boss:{ id:short(O.boss), name:'Mike' } });
    const noLongIn = async keys => { for(const k of keys){ if(LONG_RUN.test(String(await raw('notebuiltpro.' + k)))) return false; } return true; };
    const nothingRefused = async () => (await ev('gate()===null && unreadable.size===0')) && !/can’t read/.test(await text('#app'));

    // Interrupted mid-migration: the first save writes the number, then the crew, and then the jobs will not go down
    // (storage full). The app is then closed. Next open: nothing refused, and one save finishes it.
    await stage3([LIST3]); await load('#/crew'); await sleep(200);
    await ev('(function(){var s=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==="notebuiltpro.jobs")throw new Error("QuotaExceededError");return s.apply(this,arguments)};return true})()');
    await addRec('Dev', 'Trim'); await sleep(200);
    { const st = await stored('settings'), ro = await stored('roster');
      ok(st.schemaVersion === 4 && (await raw('notebuiltpro.jobs')) === JOB3 && ro.length === 4 && await noLongIn(['settings', 'roster']),
        'interrupted: the number went down, then the crew, and the jobs would not', JSON.stringify([st, ro.length])); }
    const HALF = await snap();
    await load('#/jobs'); await sleep(300);
    { const m = await mem();
      ok(await nothingRefused() && JSON.stringify(m.r.slice(0, 3)) === JSON.stringify(WANT.r) && m.r[3][1] === 'Dev' && JSON.stringify(m.j) === JSON.stringify(WANT.j),
        'the next open refuses nothing: crew (Dev included) and jobs all there under short IDs', JSON.stringify(m));
      ok((await snap()) === HALF, 'and that open wrote nothing'); }
    await addRec('Pine Rd', ''); await sleep(200);
    { const st = await stored('settings'), ro = await stored('roster'), jo = await stored('jobs');
      ok(st.schemaVersion === 4 && ro.length === 4 && jo.length === 3 && jo.slice(0, 2).map(j => j.id).join() === [O.oak, O.elm].map(short).join() && await noLongIn(['settings', 'roster', 'jobs']),
        'one ordinary save finishes it: the jobs go down short too', JSON.stringify([st, jo])); }
    await load('#/crew'); await sleep(300);
    ok(await nothingRefused() && (await mem()).r.length === 4 && /Dev/.test(await text('#app')), 'and a cold open after that reads it all straight back');

    // Interrupted after the number: schema 4 is on the phone, but a stage 3 build still open in another tab saved the crew
    // twice since (it never writes settings for a crew save), and the jobs are still long. Nothing may be refused.
    const ROS3X = JSON.stringify(JSON.parse(ROS3).concat([rec(O.list, 'Kim', { note:'added in the old tab' })]));
    await wipe(); await seed([['notebuiltpro.settings', SET4], ['notebuiltpro.roster', ROS3X], ['notebuiltpro.roster__bak', ROS3], ['notebuiltpro.jobs', JOB3], ['notebuiltpro.installPromptDismissed', '1']]);
    const AFTER = await snap();
    await load('#/crew'); await sleep(300);
    { const m = await mem();
      ok(await nothingRefused() && JSON.stringify(m.r.slice(0, 3)) === JSON.stringify(WANT.r) && JSON.stringify(m.r[3].slice(0, 2)) === JSON.stringify([short(O.list), 'Kim']) && JSON.stringify(m.j) === JSON.stringify(WANT.j),
        'a schema 4 phone whose crew and jobs still hold long IDs opens with nothing refused, the old tab’s new worker included', JSON.stringify(m));
      ok((await snap()) === AFTER, 'and that open wrote nothing'); }
    await addRec('Lee', ''); await sleep(200);
    { const ro = await stored('roster'), jo = await stored('jobs');
      ok(ro.length === 5 && jo.length === 2 && (await stored('settings')).schemaVersion === 4 && await noLongIn(['settings', 'roster', 'jobs']),
        'the next save writes the crew and the jobs short, though the number already said 4', JSON.stringify([ro.map(r => r.id), jo.map(j => j.id)])); }

    await wipe(); await seed([['notebuiltpro.settings', JSON.stringify({ schemaVersion:4, boss:{ id:O.boss, name:'Mike' } })], ['notebuiltpro.installPromptDismissed', '1']]); await load(); await sleep(300);
    ok(await ev('gate()==="damaged"') && await ev('!document.getElementById("boss-name")'), 'schema 4 settings holding a long boss ID are damaged, not quietly shortened: the number and that ID are one write, so they cannot have come apart', await ev('String(gate())'));
    await wipe(); await seed([['notebuiltpro.settings', SET4], ['notebuiltpro.roster', '{'], ['notebuiltpro.roster__bak', ROS3], ['notebuiltpro.installPromptDismissed', '1']]); await load('#/crew'); await sleep(300);
    { const m = await mem(); ok(JSON.stringify(m.r) === JSON.stringify(WANT.r) && m.u === 0, 'the backup copy left by the change still heals a damaged crew: it is read as the older copy it is', JSON.stringify(m)); }

    // The stage 3 build reads the crew and jobs with no gate but the schema number, and refuses a 64-bit ID.
    // So no state this build leaves on a phone may hold a short crew or job ID under a number below 4.
    // Each case opens the real stage 3 build on what this one left, and it must stop at its newer-version
    // screen and write nothing, or find nothing short to read.
    if(!STAGE3) console.log('  SKIP stage 3 build not in git: the old-tab checks not run');
    else {
      const old3 = async () => { await blank(); await send('Page.navigate', { url:URL0 + 'stage3/' }); await sleep(80); await ready(); };
      const refuseWrite = key => ev('(function(){var s=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===' + q(key) + ')throw new Error("QuotaExceededError");return s.apply(this,arguments)};return true})()');
      const opensAsFuture = async label => { const before = await snap(); await old3();
        const g = await ev('typeof gate==="function" ? String(gate()) : "none"');
        ok(g === 'future' && /saved by a newer version/.test(await text('#app')) && (await snap()) === before, label, g + ' ' + (await text('#app')).slice(0, 80)); };

      // Interrupted after the number: the jobs will not go down.
      await stage3([LIST3]); await load('#/crew'); await sleep(200); await refuseWrite('notebuiltpro.jobs');
      await addRec('Dev', 'Trim'); await sleep(200);
      ok((await stored('settings')).schemaVersion === 4 && (await stored('roster')).length === 4 && (await raw('notebuiltpro.jobs')) === JOB3,
        'storage refuses the jobs: the number went down first, then the crew, and the jobs are still long');
      await opensAsFuture('the stage 3 build opened on that phone stops at its newer-version screen and writes nothing');
      // Interrupted before anything: the number will not go down, so neither does the crew.
      await stage3([LIST3]); await load('#/crew'); await sleep(200); await refuseWrite('notebuiltpro.settings');
      await click('[data-action="rec-add"]'); await type('#rec-name', 'Dev'); await click('[data-action="rec-save"]'); await sleep(300);
      ok((await raw('notebuiltpro.settings')) === SET3 && (await raw('notebuiltpro.roster')) === ROS3 && (await raw('notebuiltpro.roster__bak')) === null && (await raw('notebuiltpro.jobs')) === JOB3,
        'storage refuses settings: the crew save is refused before anything is written, and the phone is still a whole stage 3 phone');
      ok(!!(await ev('document.getElementById("rec-name")')) && /couldn’t save/i.test((await text('#sheet-root')) || ''), 'and the sheet stays open saying it could not save', (await text('#sheet-root') || '').slice(0, 120));
      { const before = await snap(); await old3();
        ok(await ev('gate()===null && unreadable.size===0 && roster.length===3 && jobs.length===2') && (await snap()) === before, 'so the stage 3 build opens it as its own, all of it readable'); }
      // The same through the other door: the first change is a task, whose save stamps the number and then writes the
      // crew and the jobs. Settings refused: the crew and the jobs must not have gone down short either.
      await stage3([LIST3]); await load(DAY4); await listsReady(); await until('document.querySelectorAll("#day-body .task").length>=2', 5000, 'the migrated day');
      await refuseWrite('notebuiltpro.settings'); await addTask('Maria', 'Shim frames, unit 205'); await sleep(300);
      ok((await raw('notebuiltpro.settings')) === SET3 && (await raw('notebuiltpro.roster')) === ROS3 && (await raw('notebuiltpro.jobs')) === JOB3,
        'a task saved while settings are refused leaves the crew and the jobs in the old shape under the old number');
      { const before = await snap(); await old3();
        ok(await ev('gate()===null && unreadable.size===0 && roster.length===3 && jobs.length===2') && (await snap()) === before, 'and the stage 3 build reads its crew and jobs, writing nothing'); }
      // Done: an ordinary migration, finished.
      await stage3([LIST3]); await load('#/crew'); await sleep(200); await addRec('Dev', 'Trim');
      await opensAsFuture('after a whole migration the stage 3 build stops at its newer-version screen and writes nothing');
    }

    // Fail closed: two lists whose long listIds share their first 64 bits cannot both keep their name.
    const TWIN = Object.assign({}, LIST3, { listId:Buffer.concat([Buffer.from(O.list, 'base64url').subarray(0, 8), crypto.randomBytes(8)]).toString('base64url'), job:{ id:O.elm, name:'Elm Ave' }, queue:{} });
    await stage3([LIST3, TWIN]); await load('#/day'); await until('listsState==="failed"', 8000, 'upgrade refused');
    { const db = await rawDb();
      ok(db.v === 2 && db.keys.slice().sort().join() === [O.list, TWIN.listId].sort().join(), 'if two lists would land on one short listId the upgrade stops: the database stays at version 2 with both lists as they were', JSON.stringify(db));
      ok(/couldn’t open the storage this phone keeps lists in/.test(await text('#app')), 'and Days says it could not open the lists, rather than showing one of them'); }
  }

  // ---- 320px, both themes, every screen ----------------------------------------------------------
  section('320px, dark and light');
  const wide = await newIds(4);
  const WIDE = [['notebuiltpro.settings', JSON.stringify({ schemaVersion:2, boss:{ id:a.boss.id, name:'W'.repeat(40) } })],
    ['notebuiltpro.roster', JSON.stringify([rec(wide[0], 'W'.repeat(40), 'note', 'M'.repeat(120), NOW), rec(wide[1], 'Wolfeschlegelsteinhausenbergerdorff Sr', 'note', '+1 (555) 010-0100 · finishing carpenter', NOW, true)])],
    ['notebuiltpro.jobs', JSON.stringify([rec(wide[2], 'W'.repeat(40), 'address', 'M'.repeat(160), NOW), rec(wide[3], 'Oak St', 'address', '', NOW, true)])]];
  const WLIST = { listId:nodeId(), createdAt:NOW, updatedAt:NOW, boss:{ id:a.boss.id, name:'W'.repeat(40) }, job:{ id:wide[2], name:'W'.repeat(40) }, day:today,
    workers:[{ id:wide[0], name:'W'.repeat(40) }],
    tasks:['W'.repeat(200), cyr(200), cyr(200), 'Wolfeschlegelsteinhausenbergerdorff said to sweep up'].map((t, i) => ({ id:String(i + 1), worker:wide[0], text:t, order:i + 1, editedAt:NOW, gone:i === 3 ? 'cancelled' : null })), sent:{}, queue:{} };
  const seedWide = async () => { await wipe(); await seed(WIDE); await seedLists([WLIST]); };
  await seedWide();
  const WDAY = '#/day/' + wide[2] + '/' + today;
  const screens = [['home', '#/home'], ['crew', '#/crew'], ['jobs', '#/jobs'], ['days', '#/day'], ['day', WDAY], ['send', '#/send/' + wide[2] + '/' + today], ['settings', '#/settings'], ['support', '#/support'], ['privacy', '#/privacy']];
  const settle = async name => { await listsReady();
    if(name === 'days') await until('!!document.getElementById("day-past")', 5000, 'days drawn');
    if(name === 'day' || name === 'task sheet') await until('document.querySelectorAll("#day-body .task").length===3', 5000, 'day drawn');
    if(name === 'send'){ await measured(); await until('document.querySelectorAll(".part").length>=2', 5000, 'parts drawn'); } };
  for(const mode of ['dark', 'light']){
    await scheme(mode);
    for(const [name, hash] of screens){
      await load(hash); await sleep(250); await settle(name);
      const o = await overflow(), sv = await svgs();
      ok(!o, name + ', ' + mode + ': no horizontal scroll at 320px', o);
      if(sv) ok(false, name + ': every icon is sized', sv);
      if(name === 'support'){
        for(const tab of ['btc', 'card', 'paypal', 'wise', 'interac']){ await click('[data-pay-tab="' + tab + '"]'); const o2 = await overflow(); if(o2) ok(false, 'support tab ' + tab + ', ' + mode + ': no horizontal scroll', o2); }
        ok(await ev('document.querySelector("[data-pay-tab=interac]").classList.contains("primary") && /egspay/.test(document.getElementById("pay-detail").textContent)'), 'payment tabs switch in place, ' + mode);
      }
      if(name === 'crew' || name === 'jobs'){
        ok((await ev('document.querySelectorAll("#rec-list button").length')) === 1 && (await ev('document.querySelectorAll("#rec-archived button").length')) === 1, name + ', ' + mode + ': one in use, one archived');
        await click('#rec-list [data-action="rec-edit"]'); await sleep(250); const o5 = await overflow(); ok(!o5, name + ' edit sheet, ' + mode + ': no horizontal scroll', o5);
        await shot('10-' + name + '-sheet-' + mode + '-320'); await ev('history.back()'); await closed();
        await click('#rec-archived [data-action="rec-edit"]'); await sleep(150); const o6 = await overflow(); ok(!o6 && await ev('!!document.querySelector("[data-action=rec-unarchive]")'), name + ' archived sheet, ' + mode + ': no horizontal scroll', o6);
        await ev('history.back()'); await closed(); }
      if(name === 'day'){
        await click('#day-body .task-text'); await sleep(200); const o7 = await overflow(); ok(!o7 && await ev('document.querySelectorAll("#task-who-chips .chip").length===1'), 'task sheet, ' + mode + ': no horizontal scroll', o7);
        await shot('10-task-sheet-' + mode + '-320'); await ev('history.back()'); await closed();
        await click('#day-gone button'); await sleep(150); const o8 = await overflow(); ok(!o8 && await ev('!!document.querySelector("[data-action=task-restore]")'), 'cancelled-task sheet, ' + mode + ': no horizontal scroll', o8);
        await ev('history.back()'); await closed(); }
      if(name === 'send') ok((await cards())[0].parts.every(p => p.chars <= 700), 'send, ' + mode + ': a 40-character name and three long tasks split into parts that fit');
      if(name === 'settings'){ await click('[data-action="edit-name"]'); await sleep(200); const o3 = await overflow(); ok(!o3, 'name sheet, ' + mode + ': no horizontal scroll', o3); await click('[data-help="name"]'); await sleep(100); const o4 = await overflow(); ok(!o4, 'help sheet, ' + mode + ': no horizontal scroll', o4); }
      await shot('10-' + name + '-' + mode + '-320');
    }
    const bg = await ev('getComputedStyle(document.body).backgroundColor');
    ok(bg === (mode === 'light' ? 'rgb(246, 243, 236)' : 'rgb(21, 24, 29)'), mode + ' ground is ' + (mode === 'light' ? '#F6F3EC' : '#15181D'), bg);
    const c = await contrast('.ver-stamp'); ok(c >= 4.5, 'stamp contrast on the ' + mode + ' ground is ' + c.toFixed(2), c.toFixed(2));
  }
  await wipe(); await load(); ok(!(await overflow()), 'first run, light: no horizontal scroll at 320px', await overflow());
  ok((await ev('getComputedStyle(document.body).backgroundColor')) === 'rgb(246, 243, 236)', 'first run follows the phone into daylight');
  await shot('11-first-run-light-320');
  await scheme('dark');
  await setup('Mike'); await click('[data-go="settings"]'); await click('[data-action="theme"][data-mode="light"]'); await sleep(150);
  ok((await ev('getComputedStyle(document.body).backgroundColor')) === 'rgb(246, 243, 236)' && (await raw('notebuiltpro.theme')) === 'light', 'Day overrides a dark phone, and is kept on this phone only');
  await reload(); ok((await ev('getComputedStyle(document.body).backgroundColor')) === 'rgb(246, 243, 236)', 'and the choice survives a reload');
  await click('[data-action="theme"][data-mode="system"]');

  // ---- info mode: nothing moves --------------------------------------------------------------------
  section('Beginner mode');
  ok((await ev('document.querySelectorAll(".help-i").length')) >= 3 && await ev('getComputedStyle(document.querySelector(".help-i")).display!=="none"'), 'markers show by default');
  await click('[data-action="guide"]');
  ok(await ev('getComputedStyle(document.querySelector(".help-i")).display==="none"') && (await raw('notebuiltpro.beginner')) === 'off', 'the switch hides every marker, with its own key on this phone');
  await click('[data-action="guide"]');
  let moved = [];
  await seedWide();
  for(const w of [320, 360, 414, 680]){
    await size(w, 740);
    for(const [name, hash] of screens.concat([['name sheet', '#/settings'], ['worker sheet', '#/crew'], ['job sheet', '#/jobs'], ['task sheet', WDAY]])){
      await load(hash); await sleep(200); await settle(name);
      if(name === 'task sheet'){ await click('#day-body .task-text'); await sleep(200); }
      if(name === 'name sheet'){ await click('[data-action="edit-name"]'); await sleep(150); }
      if(name === 'worker sheet' || name === 'job sheet'){ await click('#rec-list [data-action="rec-edit"]'); await sleep(200); }
      await ev('guideSet(true),true'); const on = await boxes();
      await ev('guideSet(false),true'); const off = await boxes();
      await ev('guideSet(true),true');
      if(on !== off){ const x = JSON.parse(on), y = JSON.parse(off); moved.push(name + '@' + w + ': ' + x.filter((b, i) => b !== y[i]).length + ' boxes'); }
    }
  }
  await wipe(); await load();
  for(const w of [320, 360, 414, 680]){ await size(w, 740); await ev('guideSet(true),true'); const on = await boxes(); await ev('guideSet(false),true'); const off = await boxes(); await ev('document.documentElement.setAttribute("data-guide","on"),localStorage.clear(),true'); if(on !== off) moved.push('first run@' + w); }
  ok(moved.length === 0, 'nothing but the absorbing hairline moves between beginner and expert, on fourteen screens at four widths', moved.join(' | '));
  await size(320, 568);

  // ---- service worker ----------------------------------------------------------------------------------
  section('Service worker');
  await wipe(); await load();
  await type('#boss-name', 'Mi'); await ev('window.__alive=1,true');
  await until('navigator.serviceWorker.ready.then(function(){return !!navigator.serviceWorker.controller})', 15000, 'service worker in control');
  await sleep(400);
  ok((await ev('performance.getEntriesByType("navigation")[0].type')) === 'navigate' && (await ev('window.__alive')) === 1 && (await ev('document.getElementById("boss-name").value')) === 'Mi', 'the first install takes control without reloading the page mid-typing', await ev('performance.getEntriesByType("navigation")[0].type'));
  ok(await ev('caches.keys().then(function(k){return k.length===1 && /^egs-notebuilt-pro-\\d{4}\\.\\d{2}\\.\\d{2}-\\d{4}$/.test(k[0])})'), 'its cache is egs-notebuilt-pro-<version>');
  await type('#boss-name', 'Mike'); await click('[data-action="setup-save"]'); await until('!!document.querySelector(".topbar")', 8000, 'home');
  const SW1 = await raw('notebuiltpro.settings');
  await reload(); await sleep(300);
  ok(await ev('!!navigator.serviceWorker.controller') && (await text('.ver-stamp')) === VERSION, 'a navigation through the worker loads the app (the timer-receiver lesson holds in a real browser)');
  srv.closeAllConnections(); await new Promise(r => srv.close(r));
  await send('Page.reload'); await sleep(400); await ready();
  ok((await text('.ver-stamp')) === VERSION && (await raw('notebuiltpro.settings')) === SW1 && /Mike/.test(await text('#app')), 'with the server gone the app still opens from its cache, name and ID intact');
  ok(await ev('(function(){var r=document.querySelector(".mark-sm svg").getBoundingClientRect();return Math.round(r.width)===34})()'), 'and draws its mark offline');

  // ---- the whole run -------------------------------------------------------------------------------------
  section('Whole run');
  const foreign = requests.filter(u => u.indexOf(ORIGIN) !== 0 && !/^(data|blob|about|chrome):/.test(u));
  ok(foreign.length === 0, 'no request left this origin, start to finish (' + requests.length + ' requests)', foreign.slice(0, 3).join(' '));
  const real = errors.filter(e => !/Failed to fetch|ERR_|net::/.test(e));
  ok(real.length === 0, 'no uncaught exception and no console error', real.slice(0, 2).join(' || '));

  console.log('\nRESULT: ' + (fails ? fails + ' FAILED, ' + passes + ' passed' : 'all ' + passes + ' passed'));
  finish(fails ? 1 : 0);
}
