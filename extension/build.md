# Build / load instructions

## Load unpacked (dev)
1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select this folder: `/tmp/swa-repo/extension/`.
5. The ShareWithAgent icon appears in the toolbar (pin it via the puzzle-piece menu if hidden).
6. Navigate to any page, click the icon, click **Freeze & annotate this page**. A new tab opens
   with the bundled annotator (`viewer.html`) pre-loaded with the frozen snapshot.

Re-load after editing files: go back to `chrome://extensions` and click the refresh icon on the
ShareWithAgent card (or toggle it off/on).

## Files
```
extension/
├── manifest.json       MV3 manifest
├── background.js       service worker — orchestrates capture + hand-off
├── popup.html/js       toolbar popup — one button, thin trigger
├── viewer.html          bundled annotator (copied from repo root, one CDN→local script swap)
├── lib/lz-string.min.js   vendored dependency used by viewer.html
├── icons/icon{16,48,128}.png   toolbar/store icons
└── README.md
```

## Freeze limitations (best-effort capture)
The capture step (`freezePage` in `background.js`) is a DOM snapshot, not a pixel-perfect render.
Known gaps:

- **Cross-origin stylesheets are not inlined.** Same-origin `<link rel=stylesheet>` tags are
  fetched and inlined as `<style>`; cross-origin ones (CDNs, web fonts, etc.) throw on `fetch`
  under CORS and are left as external `<link>` tags. They may or may not resolve later depending
  on the target's CORS headers when the annotator's iframe re-requests them.
- **Canvas and WebGL content is not captured.** Cloning the DOM does not capture rendered pixels
  drawn to a `<canvas>` — the element ships empty/blank in the snapshot.
- **Video/audio elements** carry over as tags but won't have live playback state, and cross-origin
  `<source>`s are subject to the same CORS caveat as stylesheets.
- **Images are not inlined to data URIs** in this build — they rely on the injected `<base
  href>` to keep resolving against the original page's origin. If the source page requires auth
  (cookies/session) to load images and the snapshot is viewed in a context without that session,
  images may 404.
- **Shadow DOM** content is captured as part of `outerHTML` only when it's *not* using true
  `attachShadow` (closed or open shadow roots aren't serialized by `outerHTML`), so custom-element
  heavy pages may lose internal structure.
- **Scripts are deliberately stripped** — any page behavior driven by JS (dynamic content,
  client-side routing, lazy-loaded sections) reflects only whatever had already rendered into the
  DOM at capture time.
- **iframes on the page** are captured as empty `<iframe>` shells (their contents live in a
  separate document that isn't traversed).

For higher-fidelity capture of pages hitting these limits, use the SingleFile browser add-on to
save a `.html` and load it via "Upload a snapshot" in the hosted annotator, or the CLI
(`sharewithagent annotate <url>`).

## Chrome Web Store submission
Not covered by this build — packaging/submitting to the Web Store is a separate manual step
(create a Developer account, zip the `extension/` folder, fill out the store listing, pass
review). This repo only produces the unpacked, loadable extension.
