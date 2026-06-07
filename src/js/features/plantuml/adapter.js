// adapter.js - PlantUML rendering via a sandboxed iframe running the downloaded
// engine. The engine is the official PlantUML JS build (TeaVM): `plantuml.js`
// is an ES module exporting `renderToString(lines)` (returns SVG), and
// `viz-global.js` is a classic script providing the Graphviz (dot) engine used
// by class/component diagrams.
//
// The engine is untrusted downloaded code, so it runs in an `allow-scripts`
// iframe (opaque origin, no app access). We pass the file *contents* (read via a
// Rust command) and load them from blob: URLs inside the iframe — this avoids
// cross-origin module-import (CORS) problems with the asset:// protocol. The
// returned SVG is sanitized before it ever touches the app DOM.
import { readExtensionFile } from '../../backend.js';
import { resolveIncludes } from './includes.js';

const EXT_ID = 'plantuml';
const RENDER_TIMEOUT_MS = 20000;

let iframe = null;
let enginePromise = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject }
const cache = new Map(); // diagram text -> sanitized svg

// NOTE on the design (verified in a real Chromium via puppeteer):
//  - The engine entry is `render(lines, elementId)` which WRITES the SVG into a
//    DOM element (the `renderToString` export returns undefined — do not use it).
//  - viz-global.js (Graphviz) locates resources via `new URL(x, document.baseURI)`.
//    In a srcdoc iframe document.baseURI is "about:srcdoc", which breaks that and
//    makes dot-based diagrams (class/component/rectangle graphs) render empty.
//    Setting a valid <base href> fixes it; sequence diagrams work either way.
const RUNNER_HTML = `<!doctype html><html><head><meta charset="utf-8"><base href="https://tauri.localhost/"></head><body><div id="out"></div><script>
  var renderFn = null;
  function loadClassic(code){return new Promise(function(res,rej){
    var url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    var s=document.createElement('script');
    s.src=url;
    s.onload=function(){URL.revokeObjectURL(url);res();};
    s.onerror=function(){URL.revokeObjectURL(url);rej(new Error('failed to load classic script'));};
    document.head.appendChild(s);
  });}
  async function loadModule(code){
    var url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    try{ return await import(url); } finally { URL.revokeObjectURL(url); }
  }
  function readOut(){ var el=document.getElementById('out'); return el ? el.innerHTML : ''; }
  window.addEventListener('message', function(e){
    var msg=e.data||{};
    if(msg.type==='init'){
      (async function(){
        try{
          if(msg.viz) await loadClassic(msg.viz);
          var mod=await loadModule(msg.plantuml);
          renderFn = mod.render || (mod.default && mod.default.render);
          if(typeof renderFn!=='function') throw new Error('render export not found');
          parent.postMessage({type:'ready'},'*');
        }catch(err){ parent.postMessage({type:'init-error',error:String(err&&err.message||err)},'*'); }
      })();
    } else if(msg.type==='render'){
      (async function(){
        try{
          if(!renderFn) throw new Error('engine not ready');
          var el=document.getElementById('out'); el.innerHTML='';
          var ret=renderFn(msg.text.split(/\\r\\n|\\r|\\n/),'out');
          if(ret && typeof ret.then==='function') await ret;
          // Graphviz/viz writes the SVG asynchronously, so poll until it lands
          // (a single rAF is not enough for dot-based diagrams).
          var svg='';
          for(var i=0;i<200;i++){
            svg=readOut();
            if(svg && svg.indexOf('<svg')!==-1) break;
            await new Promise(function(r){setTimeout(r,50);});
          }
          parent.postMessage({type:'result',id:msg.id,svg:svg},'*');
        }catch(err){ parent.postMessage({type:'result',id:msg.id,error:String(err&&err.message||err)},'*'); }
      })();
    }
  });
</script></body></html>`;

/**
 * Remove anything potentially executable from engine-produced SVG before it is
 * inserted into the app DOM (defense in depth on top of the iframe sandbox).
 * Exported for unit testing.
 * @param {string} svg
 * @returns {string} sanitized SVG markup
 */
export function sanitizeSvg(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.getElementsByTagName('parsererror').length || root.nodeName === 'parsererror') {
    throw new Error('Invalid SVG output');
  }
  root.querySelectorAll('script, foreignObject').forEach((el) => el.remove());
  root.querySelectorAll('*').forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = (attr.value || '').trim().toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'xlink:href') && value.startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return new XMLSerializer().serializeToString(root);
}

function ensureResultListener() {
  if (ensureResultListener._done) return;
  ensureResultListener._done = true;
  window.addEventListener('message', (e) => {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const msg = e.data || {};
    if (msg.type !== 'result') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.svg);
  });
}

async function ensureEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const plantumlText = await readExtensionFile(EXT_ID, 'plantuml.js');
    let vizText = null;
    try {
      vizText = await readExtensionFile(EXT_ID, 'viz-global.js');
    } catch {
      /* viz optional; only needed for dot-based diagrams */
    }

    ensureResultListener();

    iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.cssText =
      'position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none;';
    iframe.srcdoc = RUNNER_HTML;

    const ready = new Promise((resolve, reject) => {
      const onMsg = (e) => {
        if (e.source !== iframe.contentWindow) return;
        const t = e.data?.type;
        if (t === 'ready') {
          window.removeEventListener('message', onMsg);
          resolve();
        } else if (t === 'init-error') {
          window.removeEventListener('message', onMsg);
          reject(new Error(e.data.error || 'engine init failed'));
        }
      };
      window.addEventListener('message', onMsg);
    });

    await new Promise((res) => {
      iframe.addEventListener('load', res, { once: true });
      document.body.appendChild(iframe);
    });

    iframe.contentWindow.postMessage({ type: 'init', viz: vizText, plantuml: plantumlText }, '*');
    await ready;
  })().catch((err) => {
    enginePromise = null; // allow retry after reinstall
    throw err;
  });
  return enginePromise;
}

async function doRenderPlantUML(text, baseDir, cacheKey) {
  // Resolve !include locally (stdlib packs + local files) before rendering,
  // since the engine has no filesystem/network.
  let source = text;
  if (/^\s*!include/m.test(text)) {
    const r = await resolveIncludes(text, baseDir);
    source = r.text;
    if (r.missingNamespaces.length) {
      throw new Error(
        `未導入の stdlib: ${r.missingNamespaces.join(', ')}（設定の拡張機能で有効化してください）`,
      );
    }
  }

  await ensureEngine();
  const id = ++seq;
  const svg = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    iframe.contentWindow.postMessage({ type: 'render', id, text: source }, '*');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('PlantUML render timed out'));
      }
    }, RENDER_TIMEOUT_MS);
  });
  const clean = sanitizeSvg(svg);
  cache.set(cacheKey, clean);
  return clean;
}

// Renders share one iframe with a single output element, so they must run one
// at a time — otherwise concurrent renders (e.g. switching files quickly) race
// on that element and a diagram can show the previous file's output.
let renderChain = Promise.resolve();

/**
 * Render PlantUML text to sanitized SVG markup. Results are cached by source so
 * repeated previews (every keystroke) don't re-run the engine. Calls are
 * serialized to avoid cross-render races in the shared engine iframe.
 * @param {string} text
 * @returns {Promise<string>}
 */
export function renderPlantUML(text, baseDir = '') {
  const cacheKey = `${baseDir} ${text}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const run = renderChain.then(() => doRenderPlantUML(text, baseDir, cacheKey));
  // Keep the chain alive regardless of individual success/failure.
  renderChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Drop the engine + cache (e.g. after the extension is re-installed). */
export function resetEngine() {
  if (iframe) iframe.remove();
  iframe = null;
  enginePromise = null;
  cache.clear();
  pending.clear();
}
