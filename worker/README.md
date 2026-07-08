# Hosted capture — Cloudflare Worker (Browser Rendering)

Serverless version of the paste-a-URL capture service. Runs on Cloudflare (the platform already
fronting sharewithagent.com) — no VM. Uses **Browser Rendering** to freeze pages and **KV** to
store snapshots for 30 minutes.

## Why this over a VM
The browser runs in **Cloudflare's sandbox, not your network** — so it structurally can't reach
your internal services (the SSRF risk that made the Hetzner box a bad host disappears). No OOM risk
to your other services. Scales to zero when idle.

## Prerequisites
- A Cloudflare account (same one that fronts `sharewithagent.com`).
- **Browser Rendering** enabled. It's included on the **Workers Paid plan ($5/mo)**; there is also a
  limited free allocation — check the Browser Rendering dashboard for current limits.
- `npx wrangler login`.

## Deploy (≈2 min)
```bash
cd worker
npm install

# create the two KV namespaces, then paste their ids into wrangler.toml
npx wrangler kv namespace create SNAPS
npx wrangler kv namespace create RL

npx wrangler deploy
```
This prints a URL like `https://sharewithagent-capture.<account>.workers.dev`. That's your capture
endpoint. (Or bind it to `capture.sharewithagent.com` — uncomment `routes` in `wrangler.toml`.)

## Wire the site
On sharewithagent.com the paste-a-URL form is hidden until an endpoint is set. Add one line to
`index.html` (before the closing `</body>` or in a small inline script):
```html
<script>window.SWA_CAPTURE_ENDPOINT = "https://sharewithagent-capture.<account>.workers.dev";</script>
```
Push → the paste-a-URL card's form appears and posts to the Worker. Done.

## Verify
```bash
E=https://sharewithagent-capture.<account>.workers.dev
curl -s -XPOST $E/api/capture -H 'content-type: application/json' -d '{"url":"http://127.0.0.1"}'   # → 400 blocked
curl -s -XPOST $E/api/capture -H 'content-type: application/json' -d '{"url":"https://example.com"}' # → {"id","viewer"}
open "$E/r/<id>"   # the annotator, loaded on the frozen page
```

## Notes / limits
- Freeze = fully-rendered DOM + injected `<base href>` (assets load from origin) + scripts stripped.
  Public pages work well; auth-gated/private pages won't (Cloudflare can't see your session — use the
  **extension** for those).
- SSRF: app-level blocks localhost / literal private-IP hosts; network isolation is Cloudflare's
  sandbox. No DNS-resolve step (Workers have no `dns` module) — not needed, since the browser can't
  reach your infra regardless.
- Snapshots live in KV for 30 min then expire. Rate limit: 10 captures/min per IP.
