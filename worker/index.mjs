/**
 * ShareWithAgent — hosted "paste a URL" capture, as a Cloudflare Worker.
 *
 * Serverless equivalent of hosted/server.mjs: uses Cloudflare Browser Rendering to
 * freeze a page, stores the snapshot in KV (30-min TTL), and serves the annotator
 * (viewer.html) pointed at it. No VM to run.
 *
 *   POST /api/capture {url} → { id, viewer:"/r/<id>" }
 *   GET  /r/<id>            → 302 to /?snapshot=/s/<id>&url=<orig>
 *   GET  /s/<id>            → the frozen snapshot (from KV)
 *   GET  /                  → the annotator
 *   GET  /healthz           → ok
 *
 * Bindings (wrangler.toml): MYBROWSER (Browser Rendering), SNAPS (KV), RL (KV, rate limit).
 * SSRF: the browser runs in Cloudflare's sandbox — NOT on your network — so it can't
 * reach your internal services at all. We still reject localhost / literal private-IP
 * hosts app-side as hygiene (see blockedHost).
 */
import puppeteer from '@cloudflare/puppeteer';
import VIEWER from '../viewer.html';

const ALLOWED_ORIGIN = 'https://sharewithagent.com';
const SNAP_TTL = 1800;               // 30 min
const MAX_BYTES = 12 * 1024 * 1024;  // 12 MB

function cors(origin) {
  const h = new Headers();
  if (origin === ALLOWED_ORIGIN) { h.set('Access-Control-Allow-Origin', origin); h.set('Vary', 'Origin'); }
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'content-type');
  return h;
}
const json = (obj, status, origin) => {
  const h = cors(origin); h.set('content-type', 'application/json');
  return new Response(JSON.stringify(obj), { status, headers: h });
};

// literal-host hygiene (network isolation is Cloudflare's sandbox; this blocks obvious abuse)
function blockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  // literal IPv4
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;         // link-local + metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;
  }
  if (h === '[::1]' || h === '::1' || h.startsWith('[fe80') || h.startsWith('[fc') || h.startsWith('[fd')) return true;
  return false;
}
function validate(raw) {
  let u; try { u = new URL(raw); } catch { return { ok: false, msg: 'Not a valid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, msg: 'Only http/https URLs are supported.' };
  if (u.username || u.password) return { ok: false, msg: 'URLs with credentials are not allowed.' };
  if (blockedHost(u.hostname)) return { ok: false, msg: 'That host is not allowed.' };
  return { ok: true, url: u.toString() };
}

async function rateLimited(env, ip) {
  if (!env.RL) return false;
  const key = `rl:${ip}`;
  const n = Number(await env.RL.get(key)) || 0;
  if (n >= 10) return true;                                  // 10 captures / window
  await env.RL.put(key, String(n + 1), { expirationTtl: 60 }); // per rolling minute
  return false;
}

// Freeze the rendered page: full DOM + a <base> so relative assets resolve, scripts stripped.
async function freeze(env, url) {
  const browser = await puppeteer.launch(env.MYBROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 800 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
    const html = await page.evaluate((href) => {
      // strip scripts so the page's JS doesn't re-run inside the annotator
      document.querySelectorAll('script').forEach(s => s.remove());
      const base = document.createElement('base'); base.href = href;
      document.head?.insertBefore(base, document.head.firstChild);
      return '<!doctype html>' + document.documentElement.outerHTML;
    }, url);
    return html;
  } finally { await browser.close(); }
}

const rid = () => (crypto.randomUUID().replace(/-/g, '').slice(0, 12));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (url.pathname === '/healthz') return json({ ok: true }, 200, origin);

    if (request.method === 'POST' && url.pathname === '/api/capture') {
      if (await rateLimited(env, ip)) return json({ error: 'Rate limit — a few captures per minute. Try again shortly.' }, 429, origin);
      let body; try { body = await request.json(); } catch { return json({ error: 'Bad JSON body.' }, 400, origin); }
      const v = validate(String(body?.url || ''));
      if (!v.ok) return json({ error: v.msg }, 400, origin);
      let html;
      try { html = await freeze(env, v.url); }
      catch (e) { return json({ error: 'Could not capture that page (' + (e.message || 'render failed') + ').' }, 502, origin); }
      if (!html || html.length > MAX_BYTES) return json({ error: 'Captured page was empty or too large.' }, 502, origin);
      const id = rid();
      await env.SNAPS.put(id, JSON.stringify({ html, url: v.url }), { expirationTtl: SNAP_TTL });
      return json({ id, viewer: `/r/${id}` }, 200, origin);
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(VIEWER, { headers: { 'content-type': 'text/html' } });
    }

    const rMatch = url.pathname.match(/^\/r\/([a-z0-9]+)$/i);
    if (request.method === 'GET' && rMatch) {
      const raw = await env.SNAPS.get(rMatch[1]);
      if (!raw) return new Response('<h1>Review expired</h1><p>Capture the page again from sharewithagent.com.</p>', { status: 404, headers: { 'content-type': 'text/html' } });
      const { url: orig } = JSON.parse(raw);
      return new Response(null, { status: 302, headers: { location: `/?snapshot=/s/${rMatch[1]}&url=${encodeURIComponent(orig)}` } });
    }

    const sMatch = url.pathname.match(/^\/s\/([a-z0-9]+)$/i);
    if (request.method === 'GET' && sMatch) {
      const raw = await env.SNAPS.get(sMatch[1]);
      if (!raw) return new Response(null, { status: 404 });
      const { html } = JSON.parse(raw);
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }

    return new Response(null, { status: 404 });
  },
};
