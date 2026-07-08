# ShareWithAgent browser extension

Freezes the current tab to a self-contained HTML snapshot and opens it in the **bundled**
ShareWithAgent annotator (`viewer.html`, copied straight from the repo root) for element-anchored
annotation.

## Load it (Chrome/Edge, dev)
See `build.md` for full load-unpacked instructions.

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Click the ShareWithAgent toolbar icon on any page → **Freeze & annotate this page**.

## How it works
1. Popup click sends a message to the background service worker (`background.js`).
2. The worker runs an in-page capture function (`chrome.scripting.executeScript`) in the active
   tab: clones the DOM, inlines same-origin `<link rel=stylesheet>` tags as `<style>`, injects a
   `<base href>` so relative image/asset URLs keep resolving, strips all `<script>` tags, and
   returns the resulting HTML string.
3. The worker stashes that HTML in `chrome.storage.local` (never in a URL — snapshots can be
   megabytes) and opens the bundled `viewer.html` in a new tab.
4. Once that tab finishes loading, the worker injects a tiny loader script into it (it's an
   extension page, so `scripting.executeScript` is allowed there too). The loader polls for
   `window.__swa.loadSnapshot`, calls it with the stashed HTML, then clears the storage key.

## Status
MVP serializer (inlines same-origin CSS, strips scripts, does not inline images to data URIs).
This is a best-effort freeze — see `build.md` for known limitations. For pixel-perfect capture of
hard pages (shadow DOM, canvas/WebGL, cross-origin fonts), use the **SingleFile** add-on to save a
`.html` then "Upload a snapshot" in the hosted app, or the **CLI** (`sharewithagent annotate
<url>`). Roadmap: vendor SingleFile here to match that fidelity.

## Note on `viewer.html`
The copy in this folder has one intentional diff from the repo-root original: the remote
`<script src="https://cdn.jsdelivr.net/.../lz-string.min.js">` tag was swapped for the locally
bundled `lib/lz-string.min.js`. Extension pages can't load remote script under MV3's CSP /
Chrome Web Store policy (no remote code), and the local bundle is byte-for-byte the same library
already vendored in `lib/`. Everything else in `viewer.html` is untouched.
