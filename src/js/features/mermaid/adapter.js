// adapter.js - Mermaid rendering via a sandboxed iframe running the downloaded
// engine. The engine is the official Mermaid UMD build (`mermaid.min.js`),
// installed as a downloadable extension (id "mermaid") under
// `<config>/extensions/mermaid/`.
//
// Like the PlantUML adapter, the engine is untrusted downloaded code, so it runs
// in an `allow-scripts` iframe (opaque origin, no app access). We pass the file
// *contents* (read via a Rust command) and load them from a blob: URL inside the
// iframe, avoiding cross-origin script-load (CORS) problems with asset://. The
// returned SVG is sanitized before it ever touches the app DOM.
import { readExtensionFile } from '../../backend.js';

const EXT_ID = 'mermaid';
const RENDER_TIMEOUT_MS = 20000;

let iframe = null;
let enginePromise = null;
let engineTheme = null; // theme the current engine was initialized with
let seq = 0;
const pending = new Map(); // id -> { resolve, reject }
const cache = new Map(); // `${theme}\n${text}` -> sanitized svg

// The runner loads the Mermaid UMD bundle (which sets a `mermaid` global) from a
// blob URL, initializes it with startOnLoad off and securityLevel 'strict', then
// renders each diagram to an SVG string via `mermaid.render(id, text)`.
const RUNNER_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
  function loadClassic(code){return new Promise(function(res,rej){
    var url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    var s=document.createElement('script');
    s.src=url;
    s.onload=function(){URL.revokeObjectURL(url);res();};
    s.onerror=function(){URL.revokeObjectURL(url);rej(new Error('failed to load mermaid script'));};
    document.head.appendChild(s);
  });}
  function initMermaid(theme){
    window.mermaid.initialize({startOnLoad:false, securityLevel:'strict', theme:theme||'default'});
  }
  window.addEventListener('message', function(e){
    var msg=e.data||{};
    if(msg.type==='init'){
      (async function(){
        try{
          await loadClassic(msg.mermaid);
          if(!window.mermaid || typeof window.mermaid.render!=='function')
            throw new Error('mermaid global not found');
          initMermaid(msg.theme);
          parent.postMessage({type:'ready'},'*');
        }catch(err){ parent.postMessage({type:'init-error',error:String(err&&err.message||err)},'*'); }
      })();
    } else if(msg.type==='render'){
      (async function(){
        var domId='fude-mmd-'+(msg.id);
        try{
          var res=await window.mermaid.render(domId, msg.text);
          var svg=(res && res.svg) || '';
          parent.postMessage({type:'result',id:msg.id,svg:svg},'*');
        }catch(err){
          parent.postMessage({type:'result',id:msg.id,error:String(err&&err.message||err)},'*');
        }finally{
          // Mermaid leaves an orphan element behind on error; clean it up.
          var leftover=document.getElementById('d'+domId)||document.getElementById(domId);
          if(leftover && leftover.parentNode) leftover.parentNode.removeChild(leftover);
        }
      })();
    }
  });
</script></body></html>`;

/**
 * Remove executable bits from engine-produced SVG before it enters the app DOM
 * (defense in depth on top of the iframe sandbox and Mermaid's own 'strict'
 * sanitizer). Unlike the PlantUML sanitizer this keeps <foreignObject>, which
 * Mermaid uses for flowchart/label HTML — dropping it would erase labels.
 * Exported for unit testing.
 * @param {string} svg
 * @returns {string} sanitized SVG markup
 */
export function sanitizeMermaidSvg(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.getElementsByTagName('parsererror').length || root.nodeName === 'parsererror') {
    throw new Error('Invalid SVG output');
  }
  root.querySelectorAll('script').forEach((el) => el.remove());
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

/** Map the app's data-theme to a Mermaid built-in theme name. */
export function currentMermaidTheme() {
  const attr =
    (typeof document !== 'undefined' &&
      document.documentElement &&
      document.documentElement.getAttribute('data-theme')) ||
    '';
  return attr === 'dark' ? 'dark' : 'default';
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

async function ensureEngine(theme) {
  // A theme switch needs a fresh engine (Mermaid's theme is fixed at init).
  if (enginePromise && engineTheme !== theme) resetEngine();
  if (enginePromise) return enginePromise;
  engineTheme = theme;
  enginePromise = (async () => {
    const mermaidText = await readExtensionFile(EXT_ID, 'mermaid.min.js');

    ensureResultListener();

    iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    // Mermaid measures text via getBBox, which needs a laid-out document — so
    // the runner iframe is given a real size and merely parked offscreen rather
    // than collapsed to 0×0 or hidden (which can yield empty/mis-sized SVG).
    iframe.style.cssText =
      'position:absolute;left:-99999px;top:0;width:1200px;height:1200px;border:0;pointer-events:none;';
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

    iframe.contentWindow.postMessage({ type: 'init', mermaid: mermaidText, theme }, '*');
    await ready;
  })().catch((err) => {
    enginePromise = null; // allow retry after reinstall
    engineTheme = null;
    throw err;
  });
  return enginePromise;
}

async function doRenderMermaid(text, theme, cacheKey) {
  await ensureEngine(theme);
  const id = ++seq;
  const svg = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    iframe.contentWindow.postMessage({ type: 'render', id, text }, '*');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('Mermaid render timed out'));
      }
    }, RENDER_TIMEOUT_MS);
  });
  const clean = sanitizeMermaidSvg(svg);
  cache.set(cacheKey, clean);
  return clean;
}

// Renders share one iframe, so serialize them to avoid cross-render races.
let renderChain = Promise.resolve();

/**
 * Render Mermaid diagram text to sanitized SVG markup. Results are cached by
 * (theme, source) so repeated previews don't re-run the engine. Calls are
 * serialized to avoid races in the shared engine iframe.
 * @param {string} text
 * @param {string} [theme] Mermaid theme name; defaults to the app theme.
 * @returns {Promise<string>}
 */
export function renderMermaid(text, theme = currentMermaidTheme()) {
  const cacheKey = `${theme}\n${text}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const run = renderChain.then(() => doRenderMermaid(text, theme, cacheKey));
  renderChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Drop the engine + cache (e.g. after re-install or a theme switch). */
export function resetEngine() {
  if (iframe) iframe.remove();
  iframe = null;
  enginePromise = null;
  engineTheme = null;
  cache.clear();
  pending.clear();
}
