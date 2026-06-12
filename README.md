# ShareWithAgent — visual feedback your coding agent can act on

> **Working name** (final name + domain TBD — see options below). Open-source, agent-native
> visual feedback on any web page. Click or speak; get **element-anchored** feedback a coding
> agent consumes directly (CSS selector + bounding box + element HTML + computed styles), not
> "something near (840, 312)."

Live: **https://holzherr.github.io/nick-prototypes/visual-feedback/**
Try the app: **/visual-feedback/app.html** · deep-link to demo: **/app.html?demo=1**

## What's here (this folder — the website surface)
- `index.html` — marketing homepage (plannotator-inspired).
- `app.html` — the actual annotator. Single-file, no build. Loads a frozen, self-contained
  page snapshot into a sandboxed same-origin iframe; you drop pins / draw boxes / comment;
  every annotation anchors to a real DOM element. Exports **JSON + markdown + self-contained
  `.html` + URL-fragment share link**, or POSTs back to a local agent (CLI mode).

## The three delivery surfaces (one engine)
| Surface | Where | Capture | Return to agent | Status |
|---|---|---|---|---|
| **Website** (this folder) | GitHub Pages, static | upload a SingleFile `.html`, demo, or extension | clipboard / JSON / md / `#fragment` | ✅ live |
| **CLI / skill** (plannotator-style) | `tools/visual-feedback/` in the assistant repo | `npx`/node + SingleFile + local Chrome | **synchronous, in-session** (POST → stdout) | ✅ works locally |
| **Browser extension** | `extension/` here | freezes the current tab (logged-in/SPA) | opens the website via `#fragment` | 🧪 MVP scaffold |

The CLI is the robust capture path today (no CORS/X-Frame issues, runs on your machine).
The website alone can't render arbitrary URLs (static host) — it takes snapshots via upload/extension.

## How the annotation anchors (the whole point)
On click inside the frozen page we compute, for the target element:
`selector` (stable CSS path) · `boundingBox` · `elementHtml` (truncated) · `text` · `computedStyles` (subset).
That's what an agent needs to open the right file and fix the right thing.

## Run the skill locally
```bash
cd ~/assistant/tools/visual-feedback && npm install
node cli.mjs annotate https://your.app        # capture → annotate in browser → feedback.json + .md
node cli.mjs annotate ./saved-page.html --json # annotate a SingleFile export; print JSON to stdout
```

## Open decisions
- **Name** — working name is "ShareWithAgent" but it collides (HubSpot ShareWithAgent, Pindrop). Top
  available candidates: **markrelay** (.com+.io free), **glancepin** (.com free), **sightback**
  (.com/.io/.dev/.app free). Rebrand = change `BRAND` in `app.html` + nav text in `index.html`.
- **Hosted $5/mo → 100% charity** — route as a *donation* (Every.org / Pledge.to) so it never
  becomes income and the "100%" claim is honest (fees disclosed). See spec.

## Roadmap (from the spec, `me/projects/visual-feedback-tool-spec.md`)
- v1: accounts, sharing, threaded comments, **MCP server** for the agent reply loop.
- v2: **voice user-test mode** — speak while browsing; LLM pass → discrete anchored issues.
- Later: element inspector, before/after diff, one-click self-host (Docker) + hosted instance.

Version in `<title>`: v0.1.
