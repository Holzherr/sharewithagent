/* ShareWithAgent extension — MVP capture.
 * Best-effort freeze of the current tab (inline same-origin CSS + images), then open the
 * annotator with the snapshot in the URL fragment (#<lz>) — reusing the viewer's hydrate path.
 *
 * NOTE: this is an MVP serializer. For pixel-perfect capture of hard pages (shadow DOM,
 * canvas/WebGL, cross-origin fonts), use the "SingleFile" browser add-on to save a .html and
 * "Upload a snapshot" in the app, or the CLI (`sharewithagent annotate <url>`). The roadmap is to
 * vendor SingleFile here so the extension matches that fidelity.
 */
const $ = s => document.querySelector(s);

// This function is injected into the page and runs in its context.
async function freezePage() {
  const abs = u => { try { return new URL(u, location.href).href; } catch { return u; } };
  // inline same-origin stylesheets
  for (const link of [...document.querySelectorAll('link[rel="stylesheet"]')]) {
    try {
      const css = await (await fetch(abs(link.href))).text();
      const style = document.createElement('style');
      style.textContent = css; link.replaceWith(style);
    } catch { /* cross-origin / blocked — leave it */ }
  }
  // inline images to data URIs (best effort)
  for (const img of [...document.images]) {
    try {
      const blob = await (await fetch(abs(img.src))).blob();
      img.src = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    } catch { /* leave it */ }
  }
  // strip scripts (snapshot should be static)
  document.querySelectorAll('script').forEach(s => s.remove());
  return '<!doctype html>' + document.documentElement.outerHTML;
}

$('#cap').onclick = async () => {
  const status = $('#status'); status.textContent = 'Freezing page…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result: html }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: freezePage });
    const data = { snapshot: html, url: tab.url, viewport: 'desktop', annotations: [] };
    const frag = LZString.compressToEncodedURIComponent(JSON.stringify(data));
    const base = $('#viewer').value.trim();
    await chrome.tabs.create({ url: base + '#' + frag });
    status.textContent = 'Opened in ShareWithAgent ✓';
  } catch (e) {
    status.textContent = 'Capture failed: ' + e.message;
  }
};
