# ShareWithAgent

**Visual feedback your coding agent can act on.** Point at anything on a web page — ShareWithAgent
hands your agent an *element-anchored* comment (CSS selector + bounding box + element HTML +
computed styles), not "something near (840, 312)."

🌐 **[sharewithagent.com](https://sharewithagent.com)** · open-source · agent-native

---

## Four ways to use it — pick the one that fits

### 1. Terminal (for developers + coding agents)
```bash
npx sharewithagent annotate https://your.app
```
Captures the page, opens the annotator in your browser, and — when you click **Share → Send to
Agent CLI** — writes `feedback.json` + `feedback.md` and returns them straight to your session.
Use `--json` to print the payload to stdout for an agent/hook. Alias: `swa`.

### 2. Bookmarklet (no install)
Drag the **Share with Agent** button from [sharewithagent.com](https://sharewithagent.com) to your
bookmarks bar. Click it on any page → mark it up → **Share** to copy a link or download the review.
Zero install; works on the live page you're looking at. (Some sites with a strict Content-Security-
Policy block injected scripts — use the extension there.)

### 3. Browser extension (one click, any page)
Install the extension, click its toolbar icon on any page → it freezes the page exactly as you see
it (logged-in, JS-rendered) → annotate → Share. Download it from
[sharewithagent.com](https://sharewithagent.com).

### 4. Hosted (paste a URL)
On [sharewithagent.com](https://sharewithagent.com), paste a public URL → it captures the page for
you → annotate in the browser. No install, nothing to run. (Public pages only.)

---

## What you get back

Every comment is anchored to a real DOM element:

```jsonc
{
  "comment": "CTA contrast too low — fails WCAG AA",
  "author": "Nick",
  "anchor": {
    "selector": "main > section.hero > a.hero__cta",
    "boundingBox": { "x": 24, "y": 612, "w": 180, "h": 44 },
    "elementHtml": "<a class=\"hero__cta\">Start free</a>",
    "text": "Start free",
    "computedStyles": { "padding": "8px 16px", "background-color": "…", "color": "…" }
  }
}
```

Plus a compact, prompt-ready `feedback.md` an agent can consume directly.

## How to annotate

- **Select text** or **Pin an element** — a comment box opens right where you click.
- Type, press **⌘↵** to save (or click **Comment**). Add your name once; teammates can **reply**.
- Posted comments collapse into the side panel like Google Docs; click to expand.
- **Share:** send to your agent's CLI, download the review as one self-contained `.html` for a
  teammate, or copy an agent-ready Markdown digest / structured JSON.

Keyboard: `⌘↵` save · `Esc` cancel · `⌘.` toggle panel · `v` / `p` tools · hold `⌥` peek · double-`⌥` toggle.

## Install the CLI globally (optional)
```bash
npm install -g sharewithagent
sharewithagent annotate https://your.app     # or: swa annotate …
```
Live capture needs a local Chrome/Chromium (auto-detected on macOS/Linux; override with
`SHAREWITHAGENT_CHROME=/path/to/chrome`). Annotating a saved `.html` needs no browser.

## Attribution
The in-page annotation bridge and its anchoring helpers are adapted from
[Plannotator](https://github.com/backnotprop/plannotator) by backnotprop, used under the MIT
License. See `viewer.html` for the specific functions.

## License
MIT — see [LICENSE](./LICENSE).
