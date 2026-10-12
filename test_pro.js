#!/usr/bin/env node
// Notebuilt Pro — the gate for stages 1 and 2, in a real browser.
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
const WEB = 8708;
const ORIGIN = 'http://127.0.0.1:' + WEB;
const URL0 = ORIGIN + '/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.argv.indexOf('--shots') > 0 ? path.resolve(process.argv[process.argv.indexOf('--shots') + 1]) : null;
const ID_RE = /^[A-Za-z0-9_-]{21}[AQgw]$/;
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
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if(p === '/') p = '/index.html';
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
  const until = async (expr, ms, what) => { const t = Date.now(); for(;;){ const v = await ev(expr); if(v) return v; if(Date.now() - t > (ms || 8000)) throw new Error('timeout: ' + (what || expr)); await sleep(50); } };
  const q = s => JSON.stringify(s);
  const size = (w, h) => send('Emulation.setDeviceMetricsOverride', { width:w, height:h, deviceScaleFactor:1, mobile:true });
  const scheme = v => send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-color-scheme', value:v }] });
  const ready = () => until('document.readyState==="complete" && typeof render==="function" && !!document.querySelector("#app > *")', 10000, 'app painted');
  const load = async hash => { await send('Page.navigate', { url:'about:blank' }); await send('Page.navigate', { url:URL0 + (hash || '') }); await sleep(80); await ready(); };
  const reload = async () => { await send('Page.reload'); await sleep(120); await ready(); };
  const wipe = async () => { await send('Page.navigate', { url:'about:blank' }); await send('Storage.clearDataForOrigin', { origin:ORIGIN, storageTypes:'all' }); };
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
    await send('DOM.setFileInputFiles', { files:[file], nodeId:n.nodeId }); };
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
  // Reported, not asserted: 40 Cyrillic characters sit within a few characters of the line.
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
  ok(s1.schemaVersion === 2 && Object.keys(s1).join() === 'schemaVersion,boss' && Object.keys(s1.boss).join() === 'id,name', 'the save stamped schema 2, in a fixed key order', S1);
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
  ok(S2.schemaVersion === 2, 'the first ordinary save stamps it');
  ok(S2.boss.id === s1.boss.id && S2.boss.name === 'Mike S', 'renaming keeps the ID', JSON.stringify(S2));
  ok((await raw('notebuiltpro.settings__bak')) === UNSTAMPED, 'the save backed up what was there first');
  ok((await raw('notebuiltpro.selfcheck.marker')) === null, 'the harness key is dropped by that save');
  ok(await ev('!document.getElementById("sheet-root").innerHTML') && (await text('#set-name')) === 'Mike S', 'the sheet closed and Settings shows the new name');

  // A phone still on the stage 1 shape: schema 1, no crew, no jobs.
  const V1 = JSON.stringify({ schemaVersion:1, boss:s1.boss });
  await seed([['notebuiltpro.settings', V1]]);
  await load('#/home'); await sleep(500);
  ok((await snap()) === JSON.stringify([['notebuiltpro.settings', V1]]) && /Mike/.test(await text('#app')), 'a phone on schema 1 opens as it was, and startup does not move it to schema 2');
  await click('[data-go="crew"]'); await addRec('Joe');
  { const st = JSON.parse(await raw('notebuiltpro.settings')), ro = await stored('roster');
    ok(ro.length === 1 && st.schemaVersion === 2 && st.boss.id === s1.boss.id, 'adding the first worker writes the crew and, with it, stamps schema 2', JSON.stringify(st));
    ok((await raw('notebuiltpro.settings__bak')) === V1, 'and the schema 1 settings are kept as the backup copy'); }
  await seed([['notebuiltpro.settings', JSON.stringify(S2)]]); await load('#/settings'); await sleep(200);

  // ---- rename with a long name ---------------------------------------------------
  section('Settings: your name');
  await click('[data-action="edit-name"]'); await type('#edit-name', CYR);
  await until('document.getElementById("edit-name-msg").className.indexOf("warn")>=0', 5000, 'rename warning');
  ok(true, 'the Settings row runs the same check, while typing');
  ok(!(await overflow()), 'name sheet: no horizontal scroll at 320px', await overflow());
  await shot('04-rename-sheet-320');
  await click('[data-action="name-save"]');
  await until('localStorage.getItem("notebuiltpro.settings").indexOf("Рождественский")>0', 5000, 'long name saved');
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
  { const b4 = await snap();
    for(const [bad, why] of [['', /Type a name/], ['x'.repeat(41), /40 characters/], ['Joe <b>', /markup/]]){
      await click('[data-action="rec-add"]'); await type('#rec-name', bad); await click('[data-action="rec-save"]');
      await until(why.toString() + '.test(document.getElementById("rec-name-msg").textContent)', 4000, 'refusal ' + why);
      await click('.scrim .help-corner'); await sleep(50); await ev('history.back()'); await closed(); }
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
  ok(JSON.parse(await raw('notebuiltpro.settings')).schemaVersion === 2 && JSON.parse(await snap()).every(p => p[0].indexOf('notebuiltpro.') === 0), 'every key is still notebuiltpro.*');

  // A boss rename is now weighed against the real crew and jobs.
  await click('[data-go="settings"]'); await click('[data-action="edit-name"]'); await type('#edit-name', CYR);
  await until('/Beside the longest names you already have/.test(document.getElementById("edit-name-msg").textContent)', 5000, 'boss rename weighed against real names');
  ok(true, 'the boss\u2019s own name is weighed against the real crew and jobs once they exist');
  await ev('history.back()'); await closed();

  // ---- stores this phone cannot read -----------------------------------------------------
  section('Damaged crew or jobs');
  const GOODSET = await raw('notebuiltpro.settings'), GOODJOBS = await raw('notebuiltpro.jobs');
  const BADROSTER = JSON.stringify([{ id:JSON.parse(GOODSET).boss.id, name:'<img src=x onerror="window.__z=1">', note:'', archived:false, createdAt:1, updatedAt:1 }]);
  await seed([['notebuiltpro.settings', GOODSET], ['notebuiltpro.jobs', GOODJOBS], ['notebuiltpro.roster', BADROSTER], ['notebuiltpro.installPromptDismissed', '1']]);
  await load('#/crew'); await sleep(300);
  ok(/can\u2019t read the crew/.test(await text('#app')) && await ev('!window.__z && !document.querySelector("#app img") && !document.querySelector("[data-action=rec-add]")'), 'a stored worker that fails the check is never drawn: Crew says it cannot read the crew');
  ok((await raw('notebuiltpro.roster')) === BADROSTER, 'and leaves it untouched');
  { const had0 = fs.readdirSync(work); await click('[data-go="support"]'); await click('[data-action="export"]'); await sleep(700);
    ok(fs.readdirSync(work).length === had0.length && /didn\u2019t make a backup/.test(await text('#toast')), 'export refuses rather than write a backup with the crew missing', await text('#toast')); }
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
    ok(/Mike, 0 on the crew, 0 jobs/.test(dialogs.seen[0]) && JSON.parse(await raw('notebuiltpro.settings')).schemaVersion === 2 && (await raw('notebuiltpro.roster__bak')) === AR, 'a stage 1 backup restores, says it holds no crew, comes up to schema 2, and the replaced crew is kept as the backup copy');
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
    ['a job with a malformed ID', (() => { const g = good(); g.jobs[0].id = 'B'.repeat(22);   /* right length, but not a canonical ID: the last character can only be A, Q, g or w */ return JSON.stringify(g); })()],
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

  // ---- back resolver -------------------------------------------------------------------
  section('Back and the hash');
  await load('#/home'); await sleep(200);
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
  ok((await raw('notebuiltpro.settings')) === A, 'without touching anything');
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
    ok(sh.indexOf(a.boss.id) < 0 && sh.indexOf('Mike') < 0, 'and nothing of the user’s'); }
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
  ok((await layout()) === '{"v":2,"stores":["lists","reports"],"lists":"listId","reports":["listId","workerId"],"n":0}', 'lists are keyed by listId; reports by listId and workerId together, one record per worker per list', await layout());
  const oldDb = withRecord => ev(`new Promise(function(res,rej){var r=indexedDB.open('notebuiltpro',1);r.onupgradeneeded=function(){r.result.createObjectStore('lists',{keyPath:'listId'});var s=r.result.createObjectStore('reports',{keyPath:'listId'});${withRecord ? "s.put({listId:'L1',kept:true});" : ''}};r.onsuccess=function(){r.result.close();res(true)};r.onerror=function(){rej(r.error)}})`);
  await setup('Mike'); await click('[data-go="settings"]'); await click('[data-go="support"]');
  await oldDb(false);
  { const had2 = fs.readdirSync(work); await click('[data-action="export"]'); const f = await download(had2); fs.renameSync(path.join(work, f), path.join(work, 'upgraded.json'));
    ok(/"reports":\["listId","workerId"\],"n":0/.test(await layout()) && /"v":2/.test(await layout()), 'a stage 1 database, with its empty reports store, is re-keyed on first use', await layout()); }
  await setup('Mike'); await click('[data-go="settings"]'); await click('[data-go="support"]');
  await oldDb(true);
  { const had3 = fs.readdirSync(work); await click('[data-action="export"]'); await sleep(900);
    const kept = await ev(`new Promise(function(res){var r=indexedDB.open('notebuiltpro');r.onsuccess=function(){var d=r.result,g=d.transaction('reports').objectStore('reports').get('L1');g.onsuccess=function(){var o={v:d.version,rec:g.result};d.close();res(JSON.stringify(o))}}})`);
    ok(fs.readdirSync(work).length === had3.length && kept === '{"v":1,"rec":{"listId":"L1","kept":true}}', 'if that old store somehow holds a record, the upgrade stops: nothing is dropped and no backup is written without it', kept + ' ' + await text('#toast')); }

  // ---- 320px, both themes, every screen ----------------------------------------------------------
  section('320px, dark and light');
  const wide = await newIds(4);
  const WIDE = [['notebuiltpro.settings', JSON.stringify({ schemaVersion:2, boss:{ id:a.boss.id, name:'W'.repeat(40) } })],
    ['notebuiltpro.roster', JSON.stringify([rec(wide[0], 'W'.repeat(40), 'note', 'M'.repeat(120), NOW), rec(wide[1], 'Wolfeschlegelsteinhausenbergerdorff Sr', 'note', '+1 (555) 010-0100 · finishing carpenter', NOW, true)])],
    ['notebuiltpro.jobs', JSON.stringify([rec(wide[2], 'W'.repeat(40), 'address', 'M'.repeat(160), NOW), rec(wide[3], 'Oak St', 'address', '', NOW, true)])]];
  await seed(WIDE);
  const screens = [['home', '#/home'], ['crew', '#/crew'], ['jobs', '#/jobs'], ['settings', '#/settings'], ['support', '#/support'], ['privacy', '#/privacy']];
  for(const mode of ['dark', 'light']){
    await scheme(mode);
    for(const [name, hash] of screens){
      await load(hash); await sleep(250);
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
  await seed(WIDE);
  for(const w of [320, 360, 414, 680]){
    await size(w, 740);
    for(const [name, hash] of screens.concat([['name sheet', '#/settings'], ['worker sheet', '#/crew'], ['job sheet', '#/jobs']])){
      await load(hash); await sleep(200);
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
  ok(moved.length === 0, 'nothing but the absorbing hairline moves between beginner and expert, on ten screens at four widths', moved.join(' | '));
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
