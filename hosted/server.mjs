#!/usr/bin/env node
/**
 * ShareWithAgent — hosted "paste a URL" capture service.
 *
 * POST /api/capture {url}  → validate + SSRF-guard + freeze the page → {id}
 * GET  /r/<id>             → the annotator (viewer.html), wired to load /s/<id>
 * GET  /s/<id>             → the frozen snapshot
 * GET  /healthz            → ok
 *
 * SECURITY: this fetches a user-supplied URL with a headless browser. We DNS-resolve
 * the host and reject any address in a private / loopback / link-local / CGNAT (incl.
 * Tailscale 100.64/10) / cloud-metadata range, so a caller can't pivot to internal
 * services on this host. DNS-rebinding by the browser is mitigated at the network layer
 * (systemd runs this as a dedicated uid whose egress to private ranges is REJECTed by
 * iptables — see hosted/deploy.md). App-level guards below are the first line.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { capture } from '../capture.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const VIEWER = path.join(__dir, '..', 'viewer.html');
const PORT = +(process.env.PORT || 5176);
const ALLOWED_ORIGIN = process.env.SWA_ORIGIN || 'https://sharewithagent.com';
const MAX_BYTES = 12 * 1024 * 1024;     // reject snapshots > 12MB
const CAPTURE_TIMEOUT_MS = 25_000;
const SNAP_TTL_MS = 30 * 60 * 1000;     // snapshots expire after 30 min
const MAX_SNAPSHOTS = 200;

// ---- in-memory snapshot store (id → {html, url, ts}) ----
const store = new Map();
function putSnapshot(html, url) {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  store.set(id, { html, url, ts: Date.now() });
  // evict oldest / expired
  for (const [k, v] of store) if (Date.now() - v.ts > SNAP_TTL_MS) store.delete(k);
  while (store.size > MAX_SNAPSHOTS) store.delete(store.keys().next().value);
  return id;
}

// ---- rate limit: token bucket per IP ----
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now(), b = buckets.get(ip) || { tokens: 5, ts: now };
  b.tokens = Math.min(5, b.tokens + (now - b.ts) / 12_000);   // +1 token / 12s, burst 5
  b.ts = now;
  if (b.tokens < 1) { buckets.set(ip, b); return true; }
  b.tokens -= 1; buckets.set(ip, b); return false;
}

// ---- SSRF: block private / reserved / metadata / CGNAT(tailscale) IPs ----
function ipBlocked(ip) {
  // IPv6
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true; // link-local, ULA
    if (v.startsWith('::ffff:')) return ipBlocked(v.split(':').pop());                 // v4-mapped
    return false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 127 || a === 10) return true;                 // this-net, loopback, private
  if (a === 172 && b >= 16 && b <= 31) return true;                  // private
  if (a === 192 && b === 168) return true;                          // private
  if (a === 169 && b === 254) return true;                          // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;                // CGNAT / Tailscale (100.64/10)
  if (a >= 224) return true;                                        // multicast / reserved
  if (a === 192 && b === 0) return true;                            // 192.0.0.0/24 special
  return false;
}

async function validateTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, msg: 'Not a valid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, msg: 'Only http/https URLs are supported.' };
  if (u.username || u.password) return { ok: false, msg: 'URLs with credentials are not allowed.' };
  if (/^\d+$/.test(u.hostname) || u.hostname === 'localhost') return { ok: false, msg: 'That host is not allowed.' };
  let addrs;
  try { addrs = await lookup(u.hostname, { all: true }); }
  catch { return { ok: false, msg: 'Could not resolve that host.' }; }
  if (!addrs.length || addrs.some(a => ipBlocked(a.address)))
    return { ok: false, msg: 'That host resolves to a private or reserved address and cannot be captured.' };
  return { ok: true, url: u.toString() };
}

// ---- helpers ----
function cors(res, origin) {
  if (origin === ALLOWED_ORIGIN || origin === 'http://localhost:8000') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : req.socket.remoteAddress || 'unknown');
}
async function readBody(req, cap = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0, chunks = [];
    req.on('data', c => { n += c.length; if (n > cap) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let viewerHtml = '';
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, `http://x`);
  cors(res, origin);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, snapshots: store.size });

  // POST /api/capture {url}
  if (req.method === 'POST' && url.pathname === '/api/capture') {
    const ip = clientIp(req);
    if (rateLimited(ip)) return json(res, 429, { error: 'Rate limit — a few captures per minute. Try again shortly.' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Bad JSON body.' }); }
    const check = await validateTarget(String(body?.url || ''));
    if (!check.ok) return json(res, 400, { error: check.msg });
    try {
      const html = await Promise.race([
        capture(check.url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CAPTURE_TIMEOUT_MS)),
      ]);
      if (!html || html.length > MAX_BYTES) return json(res, 502, { error: 'Captured page was empty or too large.' });
      const id = putSnapshot(html, check.url);
      return json(res, 200, { id, viewer: `/r/${id}` });   // caller opens /r/<id>
    } catch (e) {
      return json(res, 502, { error: e.message === 'timeout' ? 'Capture timed out.' : 'Could not capture that page.' });
    }
  }

  // GET / (and /?…) → the annotator, unmodified (reads ?snapshot= to fetch the page)
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(viewerHtml);
  }

  // GET /r/<id> → open the annotator pointed at this snapshot (no ?return ⇒ no CLI item)
  const rMatch = url.pathname.match(/^\/r\/([a-z0-9]+)$/i);
  if (req.method === 'GET' && rMatch) {
    const snap = store.get(rMatch[1]);
    if (!snap) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Review expired</h1><p>Capture the page again from sharewithagent.com.</p>'); }
    res.writeHead(302, { location: `/?snapshot=/s/${rMatch[1]}&url=${encodeURIComponent(snap.url)}` });
    return res.end();
  }

  // GET /s/<id> → the frozen snapshot the annotator fetches
  const sMatch = url.pathname.match(/^\/s\/([a-z0-9]+)$/i);
  if (req.method === 'GET' && sMatch) {
    const snap = store.get(sMatch[1]);
    if (!snap) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(snap.html);
  }

  res.writeHead(404); res.end();
});

const boot = async () => {
  viewerHtml = await readFile(VIEWER, 'utf8');
  server.listen(PORT, '127.0.0.1', () => console.log(`swa-capture on http://127.0.0.1:${PORT} (origin ${ALLOWED_ORIGIN})`));
};
boot();
