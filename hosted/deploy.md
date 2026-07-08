# Hosted "paste a URL" capture service — deploy runbook

`hosted/server.mjs` is a small Node service that powers the **paste-a-URL** entry point:
`POST /api/capture {url}` → freeze the page → `GET /r/<id>` opens the annotator on it.

**Status: built + SSRF-hardened + tested, NOT yet deployed public.** It needs a headless Chrome
and public HTTPS. See "Where to run it" before putting it on shared infra.

## What it does / safety
- Validates the URL, **DNS-resolves the host and rejects private / loopback / link-local /
  CGNAT (incl. Tailscale 100.64/10) / cloud-metadata (169.254.169.254) addresses** — so a caller
  can't pivot to internal services (verified: `localhost`, `127.0.0.1`, metadata, `100.x` all 400).
- Per-IP token-bucket rate limit (burst 5, +1/12s). Capture timeout 25s. Snapshot cap 12MB.
  In-memory snapshot store, 30-min TTL, max 200. CORS locked to `SWA_ORIGIN` (default
  `https://sharewithagent.com`).
- **Residual risk:** capture runs a real headless browser, which does its own DNS — so DNS-rebinding
  after the app-level check is a theoretical gap. Close it at the network layer (below).

## Where to run it — recommendation
Do **not** co-host on the personal Hetzner box (`hetzner-assistant`): it has ~2.4GB free and already
runs the Telegram bridge, dashboard, Hermes and crons — concurrent Chromium captures can OOM it and
take those down. Prefer:
- a **separate small VM / VPS** (2GB+ dedicated), or
- a **container** with a memory limit and a locked-down egress network, or
- a serverless headless-browser (Browserless, ScrapingBee, a Cloudflare Browser Rendering worker).

## Deploy (any Linux host with Node 18+)
```bash
# 1. code + deps
git clone https://github.com/Holzherr/sharewithagent && cd sharewithagent
npm install                        # single-file-cli (the capture engine)
sudo apt-get install -y chromium   # or google-chrome; set SHAREWITHAGENT_CHROME if non-standard

# 2. dedicated low-priv user so we can firewall its egress (the real SSRF fix)
sudo useradd -r -s /usr/sbin/nologin swacapture

# 3. block that user's egress to private ranges (neutralises DNS-rebinding regardless of DNS)
for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8 100.64.0.0/10; do
  sudo iptables -A OUTPUT -m owner --uid-owner swacapture -d $cidr -j REJECT
done
sudo netfilter-persistent save     # persist across reboots (install iptables-persistent)

# 4. systemd unit
sudo tee /etc/systemd/system/swa-capture.service >/dev/null <<'UNIT'
[Unit]
Description=ShareWithAgent capture service
After=network.target
[Service]
User=swacapture
WorkingDirectory=/opt/sharewithagent
Environment=PORT=5176 SWA_ORIGIN=https://sharewithagent.com
ExecStart=/usr/bin/node hosted/server.mjs
Restart=on-failure
MemoryMax=1500M
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now swa-capture

# 5. public HTTPS. On a Tailscale host:
sudo tailscale funnel --bg 5176        # → https://<host>.<tailnet>.ts.net (auto-TLS)
#   (needs Funnel enabled for the tailnet in the admin console: Access Controls → nodeAttrs funnel)
# Or terminate TLS with Caddy/nginx on capture.sharewithagent.com → 127.0.0.1:5176.
```

## Wire the site
Set the capture endpoint the site's paste-a-URL form posts to. In `index.html` the form reads
`window.SWA_CAPTURE_ENDPOINT` — set it to the public base URL from step 5. Until then the site shows
the paste-a-URL card as "self-host it" with a link here.

## Verify
```bash
curl -s -XPOST $ENDPOINT/api/capture -H 'content-type: application/json' -d '{"url":"http://127.0.0.1"}'   # → 400 blocked
curl -s -XPOST $ENDPOINT/api/capture -H 'content-type: application/json' -d '{"url":"https://example.com"}' # → {"id","viewer"}
```
