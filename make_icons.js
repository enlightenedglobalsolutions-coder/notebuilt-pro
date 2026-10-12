#!/usr/bin/env node
// make_icons.js — build the Notebuilt Pro icon set from the recipe locked Oct 12.
//
// Renders through real headless Chrome over CDP, on real time. The brushed
// grain is feTurbulence, which needs browser-grade rendering (the Aug 6
// birthstone lesson), and --virtual-time-budget is never used.
//
//   node make_icons.js                 write icons/ beside this file
//   node make_icons.js --out <dir>     write somewhere else
//   node make_icons.js --check         also write check-live-text-512.png, the
//                                      same icon with PRO as live Georgia text
//   node make_icons.js --mark          rewrite the PRO_MARK const in index.html
//   node make_icons.js --check-mark    exit 1 if that const has drifted
//
// The in-app mark comes from here too: appMark() below builds it from the same
// posts, diagonal and seal as the icons, and --mark writes it into index.html
// between the PRO-MARK markers. Never edit that const by hand.
//
// The maskable has no band. Android shows only the inner two thirds, which
// would crop a full-bleed band away, so the mark sits centred at 0.72 and the
// seal reaches 151px of the 171px that survive (decided Oct 12).
//
// PRO is drawn as outlines, so the PNGs do not depend on Georgia being
// installed. The outlines below are Georgia Bold (Version 5.00x-4) glyphs for
// P, R and O in font units, 2048 to the em. Georgia Bold has no kerning table,
// so each letter sits at the previous advance plus the letter-spacing.

const { spawn } = require('child_process');
const http = require('http'), path = require('path'), os = require('os'), fs = require('fs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const OUT = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : path.join(__dirname, 'icons');
const CHECK = args.includes('--check');

const GOLD = '#D6A84B', GROUND = '#1A1E25', PLATE = '#0C1016', SEAM = '#39424B';
const UPM = 2048;
const GLYPHS = {
  P: { adv:1436, d:'M1399 1064Q1399 944 1349.5 857.5Q1300 771 1213 717Q1123 661 1007.5 636.0Q892 611 748 611H632V212Q632 176 645.5 149.5Q659 123 697 107Q717 99 762.0 90.0Q807 81 838 78V0H69V78Q98 81 146.0 86.5Q194 92 213 100Q252 116 264.5 139.0Q277 162 277 203V1204Q277 1239 265.0 1264.5Q253 1290 213 1307Q185 1319 138.5 1328.5Q92 1338 69 1341V1419H852Q1127 1419 1263.0 1331.5Q1399 1244 1399 1064ZM1009 1013Q1009 1173 944.5 1250.5Q880 1328 715 1328H632V705H674Q838 705 923.5 780.5Q1009 856 1009 1013Z' },
  R: { adv:1633, d:'M1698 0H1154Q1013 216 919.5 344.0Q826 472 687 640H632V209Q632 173 645.5 148.0Q659 123 697 106Q716 98 756.5 89.5Q797 81 826 78V0H69V78Q98 81 145.5 86.5Q193 92 213 100Q251 116 264.0 140.5Q277 165 277 203V1204Q277 1240 266.0 1264.0Q255 1288 213 1306Q181 1319 137.5 1328.0Q94 1337 69 1341V1419H865Q1132 1419 1270.5 1335.5Q1409 1252 1409 1083Q1409 934 1323.5 843.5Q1238 753 1063 702Q1131 614 1221.5 498.0Q1312 382 1410 261Q1441 222 1494.5 165.5Q1548 109 1589 96Q1612 89 1647.5 84.0Q1683 79 1698 78ZM1017 1055Q1017 1197 937.5 1262.5Q858 1328 711 1328H632V734H708Q855 734 936.0 811.0Q1017 888 1017 1055Z' },
  O: { adv:1679, d:'M1380 1261Q1485 1165 1546.5 1029.0Q1608 893 1608 719Q1608 564 1556.0 424.0Q1504 284 1406 183Q1303 78 1164.0 19.5Q1025 -39 833 -39Q678 -39 540.0 12.0Q402 63 297 160Q193 255 132.0 391.0Q71 527 71 694Q71 868 130.5 1009.5Q190 1151 294 1252Q397 1351 538.5 1404.5Q680 1458 840 1458Q999 1458 1138.5 1406.0Q1278 1354 1380 1261ZM1123 246Q1168 337 1188.0 452.0Q1208 567 1208 712Q1208 835 1190.5 951.5Q1173 1068 1131 1159Q1088 1250 1017.0 1305.0Q946 1360 840 1360Q659 1360 565.0 1188.5Q471 1017 471 704Q471 571 491.5 453.0Q512 335 556 247Q601 158 670.0 108.5Q739 59 840 59Q939 59 1010.0 109.0Q1081 159 1123 246Z' }
};

// ---- the recipe -------------------------------------------------------------

const POSTS = [[156,140,52,232],[150,140,64,18],[150,354,64,18],[304,140,52,232],[298,140,64,18],[298,354,64,18]];
const DIAGONAL = '178,140 236,140 340,372 282,372';
const rect = (r, extra) => `<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" ${extra}/>`;

function defs(){
  const rules = [];
  for(let y = 164; y < 372; y += 24) rules.push(y);
  return { rules, text: `
  <linearGradient id="post" x1="0" y1="0" x2="0.6" y2="1">
    <stop offset="0" stop-color="#AAB6C1"/><stop offset="0.5" stop-color="#8A96A1"/><stop offset="1" stop-color="#646E78"/>
  </linearGradient>
  <linearGradient id="diag" x1="0" y1="0" x2="0.6" y2="1">
    <stop offset="0" stop-color="#CBD6E0"/><stop offset="0.5" stop-color="#A6B2BD"/><stop offset="1" stop-color="#808C97"/>
  </linearGradient>
  <radialGradient id="vig" cx="0.5" cy="0.4" r="0.78">
    <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/>
  </radialGradient>
  <filter id="grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.04 1.6" numOctaves="3" seed="5"/>
    <feColorMatrix type="saturate" values="0"/>
  </filter>
  <clipPath id="letter">${POSTS.map(r => rect(r, '')).join('')}<polygon points="${DIAGONAL}"/></clipPath>
  <clipPath id="round"><rect width="512" height="512" rx="123"/></clipPath>` };
}

// The mark, in its own 512 space. The caller scales it.
// p prefixes the gradient and clip ids, so a mark inlined in a page cannot
// collide with anything else there. grain is the feTurbulence layer.
function mark(p, grain){
  p = p || '';
  if(grain === undefined) grain = true;
  const d = defs();
  return `
    <g fill="none" stroke="${GOLD}">
      <circle cx="256" cy="256" r="205" stroke-width="10"/>
      <rect x="111" y="111" width="290" height="290" stroke-width="6"/>
    </g>
    <g fill="${GOLD}">${[[111,111],[401,111],[111,401],[401,401]].map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="9"/>`).join('')}</g>
    <g fill="url(#${p}post)">${POSTS.map(r => rect(r, '')).join('')}</g>
    <g fill="none" stroke="${SEAM}" stroke-width="2.5" opacity="0.85">${POSTS.map(r => rect(r, '')).join('')}</g>
    <polygon points="${DIAGONAL}" fill="url(#${p}diag)" stroke="${SEAM}" stroke-width="2.5"/>
    <g clip-path="url(#${p}letter)">
      <g fill="#4A545E" opacity="0.3">${d.rules.map(y => `<rect x="140" y="${y}" width="232" height="3"/>`).join('')}</g>${grain ? `
      <rect x="140" y="130" width="232" height="252" filter="url(#grain)" opacity="0.26"/>` : ''}
    </g>`;
}

// The in-app mark: the maskable composition on the icon's rounded tile, with
// no vignette and no grain (neither survives at 34px, and a filter per paint
// is not free). One line, no single quotes, so it sits in a JS string.
function appMark(){
  const stops = (a, b, c) => `<stop offset="0" stop-color="${a}"/><stop offset="0.5" stop-color="${b}"/><stop offset="1" stop-color="${c}"/>`;
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Notebuilt Pro"><defs>
    <linearGradient id="nppost" x1="0" y1="0" x2="0.6" y2="1">${stops('#AAB6C1', '#8A96A1', '#646E78')}</linearGradient>
    <linearGradient id="npdiag" x1="0" y1="0" x2="0.6" y2="1">${stops('#CBD6E0', '#A6B2BD', '#808C97')}</linearGradient>
    <clipPath id="npletter">${POSTS.map(r => rect(r, '')).join('')}<polygon points="${DIAGONAL}"/></clipPath></defs>
    <rect width="512" height="512" rx="123" fill="${GROUND}"/>
    <g transform="translate(256,256) scale(0.8) translate(-256,-256)">${mark('np', false)}</g></svg>`;
  return out.replace(/\s*\n\s*/g, '');
}

const MARK_BEGIN = '/* PRO-MARK BEGIN — generated by make_icons.js --mark from the icon geometry. Do not edit by hand. */';
const MARK_END = '/* PRO-MARK END */';
function markBlock(){ return MARK_BEGIN + "\nconst PRO_MARK = '" + appMark() + "';\n" + MARK_END; }
function markInPage(write){
  const file = path.join(__dirname, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const a = html.indexOf(MARK_BEGIN), b = html.indexOf(MARK_END);
  if(a < 0 || b < a || html.indexOf(MARK_BEGIN, a + 1) >= 0){ console.log('FAIL index.html needs exactly one PRO-MARK block'); return 1; }
  const now = html.slice(a, b + MARK_END.length);
  if(now === markBlock()){ console.log('OK   PRO_MARK in index.html matches the icon geometry'); return 0; }
  if(!write){ console.log('FAIL PRO_MARK in index.html differs from make_icons.js; run node make_icons.js --mark'); return 1; }
  fs.writeFileSync(file, html.slice(0, a) + markBlock() + html.slice(b + MARK_END.length));
  console.log('wrote PRO_MARK into index.html');
  return 0;
}

// PRO: anchor middle at x, baseline y, Georgia bold at `size`, letter-spacing `ls`.
// Chrome counts the trailing letter-spacing in the anchored width, so this does too.
function pro(x, y, size, ls, live){
  if(live) return `<text x="${x}" y="${y}" text-anchor="middle" font-family="Georgia" font-weight="bold" font-size="${size}" letter-spacing="${ls}" fill="${GOLD}">PRO</text>`;
  const s = size / UPM, order = ['P','R','O'];
  const width = order.reduce((w, c) => w + GLYPHS[c].adv * s + ls, 0);
  let pen = x - width / 2, out = '';
  order.forEach(c => {
    out += `<path transform="translate(${pen.toFixed(3)},${y}) scale(${s},${-s})" d="${GLYPHS[c].d}"/>`;
    pen += GLYPHS[c].adv * s + ls;
  });
  return `<g fill="${GOLD}">${out}</g>`;
}

// kind: 'any' (rounded, transparent corners) | 'square' (full bleed, opaque)
//     | 'maskable' (full bleed, opaque, no band)
function svg(kind, live){
  const d = defs();
  let body;
  if(kind === 'any' || kind === 'square'){
    const clip = kind === 'any' ? ' clip-path="url(#round)"' : '';
    body = `<g${clip}>
  <rect width="512" height="512" fill="${GROUND}"/>
  <g transform="translate(256,200) scale(0.85) translate(-256,-256)">${mark()}</g>
  <rect width="512" height="512" fill="url(#vig)"/>
  <rect y="392" width="512" height="120" fill="${PLATE}"/>
  <rect y="392" width="512" height="5" fill="${GOLD}"/>
  ${pro(262, 474, 62, 12, live)}
</g>`;
  } else {
    body = `<rect width="512" height="512" fill="${GROUND}"/>
  <g transform="translate(256,256) scale(0.72) translate(-256,-256)">${mark()}</g>
  <rect width="512" height="512" fill="url(#vig)"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs>${d.text}
</defs>
${body}
</svg>
`;
}

// ---- render -----------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main(){
  fs.mkdirSync(OUT, { recursive:true });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'icons-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio:'ignore' });
  const done = code => { chrome.once('exit', () => { try { fs.rmSync(prof, { recursive:true, force:true, maxRetries:5 }); } catch(e){} process.exit(code); }); chrome.kill(); };
  const watchdog = setTimeout(() => { console.log('FAIL timed out'); done(1); }, 60000);

  let port = null;
  for(let i = 0; i < 100 && !port; i++){
    await sleep(100);
    try { port = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch(e){}
  }
  if(!port){ console.log('FAIL no chrome'); return done(1); }
  const list = await new Promise((res, rej) => http.get('http://127.0.0.1:' + port + '/json/list', r => {
    let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
  const target = list.find(t => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0; const waiting = {};
  ws.addEventListener('message', m => { const j = JSON.parse(m.data); if(j.id && waiting[j.id]){ waiting[j.id](j); delete waiting[j.id]; } });
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq;
    waiting[id] = j => j.error ? rej(new Error(method + ': ' + j.error.message)) : res(j.result);
    ws.send(JSON.stringify({ id, method, params: params || {} })); });

  await send('Page.enable');
  await send('Emulation.setDefaultBackgroundColorOverride', { color:{ r:0, g:0, b:0, a:0 } });
  const frame = (await send('Page.getFrameTree')).frameTree.frame.id;

  async function shot(markup, px, file){
    await send('Emulation.setDeviceMetricsOverride', { width:px, height:px, deviceScaleFactor:1, mobile:false });
    const html = '<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:' + px + 'px;height:' + px + 'px}</style></head><body>' + markup + '</body></html>';
    await send('Page.setDocumentContent', { frameId:frame, html });
    await send('Runtime.evaluate', { awaitPromise:true, expression:
      'document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))))' });
    const png = await send('Page.captureScreenshot', { format:'png', clip:{ x:0, y:0, width:px, height:px, scale:1 } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(png.data, 'base64'));
    console.log('wrote ' + file + '  ' + px + 'px  ' + fs.statSync(path.join(OUT, file)).size + ' bytes');
  }

  fs.writeFileSync(path.join(OUT, 'icon.svg'), svg('any'));
  console.log('wrote icon.svg');
  await shot(svg('any'), 512, 'icon-512.png');
  await shot(svg('any'), 192, 'icon-192.png');
  await shot(svg('square'), 180, 'icon-180.png');
  await shot(svg('maskable'), 512, 'icon-maskable-512.png');
  if(CHECK) await shot(svg('any', true), 512, 'check-live-text-512.png');
  clearTimeout(watchdog);
  ws.close();
  done(0);
}

if(args.includes('--mark') || args.includes('--check-mark')) process.exit(markInPage(args.includes('--mark')));
else main().catch(e => { console.log('FAIL ' + e.message); process.exit(1); });
