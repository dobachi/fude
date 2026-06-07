// adapter.js - PlantUML rendering via a sandboxed iframe running the downloaded
// engine (plantuml.js TeaVM build + viz-global.js). The engine is untrusted
// downloaded code, so it runs in an `allow-scripts`-only iframe (opaque origin,
// no access to the app); we exchange text/SVG over postMessage and sanitize the
// SVG before it ever touches the app DOM.
import { convertFileSrc } from '@tauri-apps/api/core';
import { extensionFilePath } from '../../backend.js';

const EXT_ID = 'plantuml';
const RENDER_TIMEOUT_MS = 20000;

let iframe = null;
let enginePromise = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject }
const cache = new Map(); // diagram text -> sanitized svg

// Minimal runner page. Loaded via srcdoc so nothing extra has to be bundled to
// dist. It loads the engine scripts (passed as asset:// URLs), then answers
// render requests. The PlantUML TeaVM build exposes its entry as a global; we
// probe the known names so this survives small build differences.
const RUNNER_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
  var ready = false;
  function loadScript(src){return new Promise(function(res,rej){
    var s=document.createElement('script');s.src=src;s.onload=res;
    s.onerror=function(){rej(new Error('failed to load '+src));};
    document.head.appendChild(s);
  });}
  function renderUml(text){
    if (typeof umlToSvg==='function') return umlToSvg(text);
    if (typeof window.umlToSvg==='function') return window.umlToSvg(text);
    if (window.plantuml){
      if (typeof window.plantuml.renderSvg==='function') return window.plantuml.renderSvg(text);
      if (typeof window.plantuml.umlToSvg==='function') return window.plantuml.umlToSvg(text);
    }
    throw new Error('PlantUML engine entry point not found');
  }
  window.addEventListener('message', function(e){
    var msg=e.data||{};
    if(msg.type==='init'){
      (async function(){
        try{ for(var i=0;i<msg.scripts.length;i++){ await loadScript(msg.scripts[i]); }
          ready=true; parent.postMessage({type:'ready'},'*');
        }catch(err){ parent.postMessage({type:'init-error',error:String(err&&err.message||err)},'*'); }
      })();
    } else if(msg.type==='render'){
      try{
        if(!ready) throw new Error('engine not ready');
        var svg=renderUml(msg.text);
        parent.postMessage({type:'result',id:msg.id,svg:svg},'*');
      }catch(err){ parent.postMessage({type:'result',id:msg.id,error:String(err&&err.message||err)},'*'); }
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
    const plantumlUrl = convertFileSrc(await extensionFilePath(EXT_ID, 'plantuml.js'));
    let vizUrl = null;
    try {
      vizUrl = convertFileSrc(await extensionFilePath(EXT_ID, 'viz-global.js'));
    } catch {
      /* viz-global.js optional; only needed for dot-based diagrams */
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

    // viz must load before plantuml so the dot engine is available.
    const scripts = vizUrl ? [vizUrl, plantumlUrl] : [plantumlUrl];
    iframe.contentWindow.postMessage({ type: 'init', scripts }, '*');
    await ready;
  })().catch((err) => {
    // Allow a later retry (e.g. after reinstall).
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

/**
 * Render PlantUML text to sanitized SVG markup. Results are cached by source so
 * repeated previews (every keystroke) don't re-run the engine.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function renderPlantUML(text) {
  if (cache.has(text)) return cache.get(text);
  await ensureEngine();
  const id = ++seq;
  const svg = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    iframe.contentWindow.postMessage({ type: 'render', id, text }, '*');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('PlantUML render timed out'));
      }
    }, RENDER_TIMEOUT_MS);
  });
  const clean = sanitizeSvg(svg);
  cache.set(text, clean);
  return clean;
}

/** Drop the engine + cache (e.g. after the extension is re-installed). */
export function resetEngine() {
  if (iframe) iframe.remove();
  iframe = null;
  enginePromise = null;
  cache.clear();
  pending.clear();
}
