// Notebuilt Pro — browser test for the crew link self-check page (index.html).
// Copyright (c) 2026 Enlightened Global Solutions. All rights reserved.
// Serves index.html on 127.0.0.1 and drives it in real headless Chrome over
// CDP on REAL time — --virtual-time-budget fires watchdogs before genuine
// async work (same reason as platform/run_crew_browser.js). 320px wide.
// Goes when the page does: the real Pro build overwrites both.
// Usage: node test_selfcheck.js [--shots <dir>]   (exit 0 = all passed)
//        --shots writes 320-dark.png, 320-light.png, 320-arrival.png into <dir>
const { spawn } = require('child_process');
const http = require('http'), path = require('path'), os = require('os'), fs = require('fs');
const FILE = path.join(__dirname, 'index.html');
const SHOTS = process.argv.indexOf('--shots') > 0 ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9341, WEB = 8941;
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' }); r.end(fs.readFileSync(FILE)); }).listen(WEB, '127.0.0.1');
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-chrome-'));
const URL0 = 'http://127.0.0.1:' + WEB + '/';
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, 'about:blank'], { stdio:'ignore' });
let fails = 0;
const ok = (c, label, extra) => { if(!c) fails++; console.log((c ? '  PASS ' : '  FAIL ') + label + (extra ? '  → ' + extra : '')); };
const finish = code => { srv.close(); chrome.once('exit', () => { try { fs.rmSync(prof, { recursive:true, force:true, maxRetries:5 }); } catch(e){} process.exit(code); }); chrome.kill(); };
setTimeout(() => { console.log('FAIL timed out'); finish(1); }, 120000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let target;
  for(let i = 0; i < 50 && !target; i++){ await sleep(200);
    try { target = (await (await fetch('http://127.0.0.1:' + PORT + '/json')).json()).find(t => t.type === 'page'); } catch(e){} }
  if(!target){ console.log('FAIL no chrome'); return finish(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = {};
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if(pending[m.id]){ pending[m.id](m); delete pending[m.id]; } };
  const send = (method, params) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params:params || {} })); });
  const ev = async expr => { const m = await send('Runtime.evaluate', { expression:expr, returnByValue:true, awaitPromise:true });
    if(m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)); return m.result.result.value; };
  const until = async (expr, ms) => { const t = Date.now(); for(;;){ const v = await ev(expr); if(v) return v; if(Date.now() - t > (ms || 8000)) throw new Error('timeout: ' + expr); await sleep(60); } };
  const go = async url => { await send('Page.navigate', { url }); await sleep(150); await until('document.readyState==="complete" && !!window.EGSCrew && !!document.getElementById("ua").textContent'); };
  const verdict = async hash => { await go(URL0 + hash); return until('(function(){var t=document.getElementById("verdict").textContent;return t!=="Checking…"&&!document.getElementById("arrival").hidden?t:""})()'); };
  const T = id => ev('document.getElementById(' + JSON.stringify(id) + ').textContent');
  const shot = async name => { if(!SHOTS) return; const m = await send('Page.captureScreenshot', { format:'png', captureBeyondViewport:true }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(m.result.data, 'base64')); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width:320, height:640, deviceScaleFactor:2, mobile:true });

  try {
    console.log(await ev('navigator.userAgent'));
    // --- cold open, empty storage
    await go(URL0);
    const stamp = await ev('window.EGS_VERSION');
    ok(!!stamp && (await T('ver')).indexOf(stamp) >= 0, 'cold open shows the version stamp', await T('ver'));
    ok(await ev('document.getElementById("arrival").hidden'), 'no hash → no verdict box');
    ok(/^New storage — first visit/.test(await T('store-status')), 'first visit reads as new storage', await T('store-status'));
    const marker = await ev('localStorage.getItem("notebuiltpro.selfcheck.marker")');
    ok(!!marker, 'marker written under notebuiltpro.selfcheck.marker', marker);
    await send('Page.reload'); await sleep(300); await until('!!document.getElementById("ua").textContent');
    ok(await T('store-status') === 'Same storage as before.', 'second visit: same storage as before');
    ok(await ev('localStorage.getItem("notebuiltpro.selfcheck.marker")') === marker, 'marker unchanged by a revisit');

    // --- generate
    const links = {};
    for(const worstCase of [false, true]){
      await ev('document.getElementById("' + (worstCase ? 'text-worst' : 'text-real') + '").click()');
      for(const g of ['slice', 'crew', 'report']){
        await ev('document.getElementById("link-' + g + '").value=""; document.getElementById("gen-' + g + '").click()');
        const link = await until('document.getElementById("link-' + g + '").value');
        const txt = await ev('document.getElementById("out-' + g + '").textContent');
        ok(txt.indexOf(link.length + ' characters') >= 0 && /^https:\/\/pro\.notebuilt\.ca\/#(crew|report)=\d{6}[0-9a-f]{8}1[A-Za-z0-9_-]+$/.test(link),
           (worstCase ? 'worst ' : 'real  ') + g + ': link shown with its count', link.length + ' chars; ' + txt.replace(link, '').slice(0, 120));
        ok(+link.slice(link.indexOf('=') + 1, link.indexOf('=') + 7) === link.length, '      declared length equals the link length');
        links[(worstCase ? 'w_' : 'r_') + g] = link;
      }
    }
    // --- fixed-size links: a real payload padded to an exact length
    const fixed = {};
    for(const n of [800, 1200, 1600, 2000, 2400]){
      await ev('document.getElementById("gen-fix' + n + '").click()');
      const link = await until('document.getElementById("link-fix' + n + '").value');
      const txt = await ev('document.getElementById("out-fix' + n + '").textContent');
      const title = await ev('document.getElementById("gen-fix' + n + '").previousSibling.textContent');
      ok(link.length === n && title === n + ' characters' && txt.indexOf(n + ' characters exactly') >= 0 && /^https:\/\/pro\.notebuilt\.ca\/#crew=\d{6}[0-9a-f]{8}p\d{6}1[A-Za-z0-9_-]+$/.test(link),
         'fixed ' + n + ': link is exactly ' + n + ' characters and labelled so', link.length + ' chars; ' + txt.replace(link, '').slice(0, 110));
      fixed[n] = link;
    }
    ok(await ev('!!document.getElementById("copy-crew") && document.getElementById("copy-crew").textContent==="Copy"'), 'each link has a Copy button');
    ok(await ev('document.documentElement.scrollWidth') <= 320, '320px: no sideways scroll with all three links shown (dark)', String(await ev('document.documentElement.scrollWidth')));
    await shot('320-dark.png');
    await send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-color-scheme', value:'light' }] });
    ok(await ev('getComputedStyle(document.body).backgroundColor') === 'rgb(246, 243, 236)', 'light scheme uses the #F6F3EC ground');
    ok(await ev('document.documentElement.scrollWidth') <= 320, '320px: no sideways scroll (light)');
    await shot('320-light.png');
    await send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-color-scheme', value:'dark' }] });

    // --- "Open here": a same-page tap must put the verdict in front of the person
    await ev('window.scrollTo(0, document.body.scrollHeight); document.getElementById("verdict").textContent = "stale"; document.getElementById("open-slice").click()');
    await sleep(800);
    const oh = JSON.parse(await ev('(function(){var a=document.getElementById("arrival"),r=a.getBoundingClientRect();return JSON.stringify({hidden:a.hidden,verdict:document.getElementById("verdict").textContent,top:Math.round(r.top),vh:innerHeight,scrollY:Math.round(scrollY),hash:location.hash.length})})()'));
    ok(/^WHOLE/.test(oh.verdict), 'Open here: the page checks the link it was sent to', JSON.stringify(oh));
    ok(!oh.hidden && oh.top >= 0 && oh.top < oh.vh, 'Open here: the verdict is on screen afterwards', 'verdict box top ' + oh.top + 'px in a ' + oh.vh + 'px viewport, scrollY ' + oh.scrollY);
    ok(await T('store-status') === 'Same storage as before.', 'Open here: the storage line is re-read', await T('store-status'));

    // --- arrival verdicts
    for(const k of Object.keys(links)){
      const L = links[k], h = L.slice(L.indexOf('#')), n = L.length;
      ok(await verdict(h) === 'WHOLE (' + n + ' of ' + n + ')', k + ' arrives WHOLE', await T('verdict') + ' · ' + await T('verdict-detail'));
    }
    for(const k of Object.keys(fixed)){
      const F = fixed[k], fh = F.slice(F.indexOf('#')), fn = F.length;
      ok(await verdict(fh) === 'WHOLE (' + fn + ' of ' + fn + ')' && /plus \d+ characters of padding/.test(await T('verdict-detail')), 'fixed ' + k + ' arrives WHOLE', await T('verdict') + ' · ' + await T('verdict-detail'));
      ok(await verdict(fh.slice(0, -1)) === 'TRUNCATED (got ' + (fn - 1) + ' of ' + fn + ')', '      1 character of padding cut → TRUNCATED, not WHOLE', await T('verdict'));
      ok(await verdict(fh.slice(0, -120)) === 'TRUNCATED (got ' + (fn - 120) + ' of ' + fn + ')', '      120 characters of padding cut → TRUNCATED', await T('verdict'));
      ok(await verdict(fh.slice(0, 300)) === 'TRUNCATED (got 325 of ' + fn + ')', '      cut back into the payload → TRUNCATED', await T('verdict'));
      const last = fh[fh.length - 1] === 'A' ? 'B' : 'A';
      ok(await verdict(fh.slice(0, -1) + last) === 'MANGLED (checksum mismatch)', '      last padding character changed → MANGLED', await T('verdict'));
    }
    const L = links.r_crew, h = L.slice(L.indexOf('#')), n = L.length;
    ok(await T('store-status') === 'Same storage as before.', 'arrival in the same browser: same storage as before');
    ok(await verdict(h.slice(0, -582)) === 'TRUNCATED (got ' + (n - 582) + ' of ' + n + ')', 'cut 582 off the end → TRUNCATED', await T('verdict'));
    ok(await verdict(h.slice(0, -1)) === 'TRUNCATED (got ' + (n - 1) + ' of ' + n + ')', 'cut 1 off the end → TRUNCATED', await T('verdict'));
    ok(/^TRUNCATED \(got 35, cut off/.test(await verdict(h.slice(0, 10))), 'cut inside the header → TRUNCATED', await T('verdict'));
    ok(/^TRUNCATED/.test(await verdict('#cre')), 'cut inside "#crew=" → TRUNCATED', await T('verdict'));
    const mid = 400, sw = h[mid] === 'A' ? 'B' : 'A';
    ok(await verdict(h.slice(0, mid) + sw + h.slice(mid + 1)) === 'MANGLED (checksum mismatch)', 'one character changed → MANGLED', await T('verdict'));
    ok(/^MANGLED \(got \d+ of \d+ — something was added\)$/.test(await verdict(h + 'xyz')), 'characters appended → MANGLED', await T('verdict'));
    // right length + checksum, but the component refuses it: a report payload under #crew=
    await go(URL0);
    const rp = links.r_report.slice(links.r_report.indexOf('=') + 15);
    const wrong = await ev('testLink("crew", ' + JSON.stringify(rp) + ')');
    const reason = await ev('EGSCrew.REASONS.wrong_kind');
    ok(await verdict(wrong.slice(wrong.indexOf('#'))) === reason, 'checksum fine but wrong kind → the component’s own reason', await T('verdict') + ' · ' + await T('verdict-detail'));
    ok(/^NO SELF-CHECK HEADER/.test(await verdict('#report=' + rp)), 'a real (headerless) link is called out, not passed as WHOLE', await T('verdict'));
    ok(await verdict('#hello') === reason, 'unrelated hash → the component’s own reason', await T('verdict'));
    ok(await verdict('#crew=000100deadbeef1<img src=x onerror=window.__x=1>') !== '' && await ev('window.__x') === undefined && await ev('document.images.length') === 0, 'markup in the hash is never rendered', await T('verdict'));

    // --- clear marker, behind a confirm
    await go(URL0);
    await ev('document.getElementById("clear-btn").click()');
    ok(await ev('!document.getElementById("clear-confirm").hidden && localStorage.getItem("notebuiltpro.selfcheck.marker")') === marker, 'Clear marker asks first; nothing cleared yet');
    await ev('document.getElementById("clear-no").click()');
    ok(await ev('document.getElementById("clear-confirm").hidden && localStorage.getItem("notebuiltpro.selfcheck.marker")') === marker, '"Keep it" leaves the marker alone');
    await ev('document.getElementById("clear-btn").click(); document.getElementById("clear-yes").click()');
    ok(await ev('localStorage.getItem("notebuiltpro.selfcheck.marker")') === null, '"Yes, clear it" removes the marker', await T('store-status'));
    await send('Page.navigate', { url:'about:blank' }); await sleep(200);
    await verdict(h);
    ok(await T('store-status') === 'New storage — this browser is separate from where you generated the link.', 'arrival with no marker: new storage', await T('store-status'));
    await shot('320-arrival.png');
    const res = await ev("JSON.stringify(performance.getEntriesByType(\"resource\").map(e=>e.name))"); ok(res === "[]", "the page requests nothing but itself", res);
    ok(await ev('!("serviceWorker" in navigator) || navigator.serviceWorker.getRegistrations().then(r=>r.length===0)'), 'no service worker registered');
  } catch(e){ fails++; console.log('  FAIL threw: ' + e.message); }
  console.log(fails ? 'RESULT: ' + fails + ' FAILED' : 'RESULT: all passed');
  finish(fails ? 1 : 0);
})();
