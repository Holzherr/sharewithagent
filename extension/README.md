# ShareWithAgent browser extension (MVP scaffold)

Freezes the current tab and opens it in the ShareWithAgent annotator (the hosted website) via the
URL fragment — reusing the viewer's `#<lz>` hydrate path.

## Load it (Chrome/Edge, dev)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Click the ShareWithAgent toolbar icon on any page → **Capture & annotate this page**.

## Status
MVP serializer (inlines same-origin CSS + images, strips scripts). For pixel-perfect capture of
hard pages (shadow DOM, canvas/WebGL, cross-origin fonts), use the **SingleFile** add-on to save a
`.html` then "Upload a snapshot", or the **CLI** (`sharewithagent annotate <url>`). Roadmap: vendor
SingleFile here to match that fidelity.
