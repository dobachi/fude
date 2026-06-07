// verify-plantuml-engine.mjs — OPTIONAL integration check (NOT part of `make check`).
//
// Renders a sequence diagram and a dot-based (Graphviz) diagram with the real
// downloaded PlantUML engine, using the exact loading strategy of
// src/js/features/plantuml/adapter.js (sandboxed srcdoc iframe + blob-loaded
// engine + <base href> + `render(lines, "out")`). It guards against the two
// regressions we hit during development:
//   1. using `renderToString` (returns undefined) instead of `render`
//   2. missing <base href>, which makes viz/Graphviz produce empty SVG for
//      dot-based diagrams in a srcdoc iframe (document.baseURI = about:srcdoc).
//
// Requirements (install ad hoc; intentionally not project deps):
//   - puppeteer available to Node (e.g. `NODE_PATH=$(npm root -g) node ...`
//     or `npm i -D puppeteer`)
//   - network access to the fude-extensions release
// Usage: node scripts/verify-plantuml-engine.mjs
// Exits non-zero if either diagram fails to render to SVG.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const MANIFEST_URL =
  'https://raw.githubusercontent.com/dobachi/fude-extensions/main/manifest.json';

const SEQ = '@startuml\nAlice -> Bob: hello\n@enduml';
const DOT = [
  '@startuml',
  'left to right direction',
  'rectangle A as a',
  'rectangle B as b',
  'rectangle C as c',
  'a --> b',
  'b ..> c : uses',
  '@enduml',
].join('\n');

const RUNNER = `<!doctype html><html><head><meta charset="utf-8"><base href="https://tauri.localhost/"></head><body><div id="out"></div><script>
  var renderFn=null;
  function loadClassic(code){return new Promise(function(res,rej){
    var u=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    var s=document.createElement('script');s.src=u;s.onload=function(){res();};s.onerror=function(){rej(new Error('viz load fail'));};
    document.head.appendChild(s);
  });}
  async function loadModule(code){return await import(URL.createObjectURL(new Blob([code],{type:'text/javascript'})));}
  window.addEventListener('message',function(e){
    var m=e.data||{};
    if(m.type==='init'){(async function(){try{
      if(m.viz) await loadClassic(m.viz);
      var mod=await loadModule(m.plantuml);
      renderFn=mod.render||(mod.default&&mod.default.render);
      if(typeof renderFn!=='function') throw new Error('render export missing');
      parent.postMessage({type:'ready'},'*');
    }catch(err){parent.postMessage({type:'init-error',error:String(err&&err.message||err)},'*');}})();}
    else if(m.type==='render'){(async function(){try{
      var el=document.getElementById('out');el.innerHTML='';
      var ret=renderFn(m.text.split(/\\r\\n|\\r|\\n/),'out');
      if(ret&&typeof ret.then==='function') await ret;
      var svg='';
      for(var i=0;i<200;i++){ svg=el.innerHTML; if(svg&&svg.indexOf('<svg')!==-1) break; await new Promise(function(r){setTimeout(r,50);}); }
      parent.postMessage({type:'result',svg:svg},'*');
    }catch(err){parent.postMessage({type:'result',error:String(err&&err.message||err)},'*');}})();}
  });
</script></body></html>`;

async function main() {
  const manifest = await (await fetch(MANIFEST_URL)).json();
  const ext = manifest.extensions.find((e) => e.id === 'plantuml');
  if (!ext) throw new Error('plantuml not in manifest');
  const byRel = Object.fromEntries(ext.files.map((f) => [f.rel, f.url]));
  const [viz, puml] = await Promise.all([
    fetch(byRel['viz-global.js']).then((r) => r.text()),
    fetch(byRel['plantuml.js']).then((r) => r.text()),
  ]);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');

  const render = (text) =>
    page.evaluate(
      (runnerHtml, vizText, pumlText, diagram) =>
        new Promise((resolve) => {
          const iframe = document.createElement('iframe');
          iframe.setAttribute('sandbox', 'allow-scripts');
          iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
          iframe.srcdoc = runnerHtml;
          const onMsg = (e) => {
            if (e.source !== iframe.contentWindow) return;
            const m = e.data || {};
            if (m.type === 'ready') {
              iframe.contentWindow.postMessage({ type: 'render', text: diagram }, '*');
            } else if (m.type === 'init-error') {
              window.removeEventListener('message', onMsg);
              resolve('INIT-ERROR: ' + m.error);
            } else if (m.type === 'result') {
              window.removeEventListener('message', onMsg);
              resolve(m.error ? 'RENDER-ERROR: ' + m.error : m.svg);
            }
          };
          window.addEventListener('message', onMsg);
          iframe.addEventListener('load', () =>
            iframe.contentWindow.postMessage({ type: 'init', viz: vizText, plantuml: pumlText }, '*'),
          );
          document.body.appendChild(iframe);
          setTimeout(() => resolve('TIMEOUT'), 25000);
        }),
      RUNNER,
      viz,
      puml,
      text,
    );

  let failed = false;
  for (const [label, text] of [
    ['sequence', SEQ],
    ['dot/graphviz', DOT],
  ]) {
    const svg = String(await render(text));
    const ok = /<svg[\s>]/i.test(svg) && svg.length > 100;
    console.log(`${ok ? 'PASS' : 'FAIL'} [${label}] len=${svg.length} ${ok ? '' : '-> ' + svg.slice(0, 200)}`);
    if (!ok) failed = true;
  }

  await browser.close();
  if (failed) process.exit(1);
  console.log('OK: PlantUML engine renders sequence and dot diagrams.');
}

main().catch((e) => {
  console.error('verify-plantuml-engine failed:', e);
  process.exit(1);
});
