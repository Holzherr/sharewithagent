/* ShareWithAgent extension — MV3 service worker.
 *
 * Owns the "freeze current tab -> open bundled viewer.html -> hand off snapshot"
 * flow so the popup can stay a thin trigger (popup.js just sends one message here).
 *
 * Flow:
 *   1. capturePage(): scripting.executeScript runs freezePage() in the active tab,
 *      returns a self-contained HTML string (best-effort frozen snapshot).
 *   2. Stash the (possibly large) HTML in chrome.storage.local — never in a URL.
 *   3. Open the bundled viewer.html in a new tab.
 *   4. Once that tab finishes loading, inject a tiny loader script into it (it's an
 *      extension page, so scripting is allowed) that polls for window.__swa, calls
 *      loadSnapshot(html), then clears the storage key.
 */

const SNAPSHOT_KEY = 'swaSnapshot';

/* ---------- in-page capture function (executed via scripting.executeScript) ---------- */
// NOTE: this function is serialized and injected into the target page's context.
// It cannot close over anything outside itself.
async function freezePage() {
  const abs = (u) => {
    try { return new URL(u, location.href).href; } catch { return u; }
  };

  // Work on a detached clone so we never mutate the live page the user is looking at.
  const docClone = document.documentElement.cloneNode(true);

  // Inline same-origin stylesheets (best-effort). Cross-origin <link> fetches will
  // throw (CORS) and are left as-is — the annotator will still show layout, just
  // without those particular styles resolved.
  const links = [...docClone.querySelectorAll('link[rel="stylesheet"]')];
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      const res = await fetch(abs(href));
      if (!res.ok) throw new Error('bad response');
      const css = await res.text();
      const style = document.createElement('style');
      style.setAttribute('data-swa-inlined-from', abs(href));
      style.textContent = css;
      link.replaceWith(style);
    } catch {
      // cross-origin or blocked — leave the <link> in place, browser-relative via <base>.
    }
  }

  // Strip <script> tags — the annotator's snapshot should be static; we don't want
  // the captured page's JS re-executing inside the viewer's iframe.
  docClone.querySelectorAll('script').forEach((s) => s.remove());

  // Inject a <base> so relative URLs (images, remaining stylesheets, fonts) still
  // resolve against the original page's origin + path.
  let head = docClone.querySelector('head');
  if (!head) {
    head = document.createElement('head');
    docClone.insertBefore(head, docClone.firstChild);
  }
  const base = document.createElement('base');
  base.setAttribute('href', location.origin + location.pathname);
  head.insertBefore(base, head.firstChild);

  return '<!doctype html>\n' + docClone.outerHTML;
}

/* ---------- loader injected into the bundled viewer.html tab ---------- */
// Also serialized/injected — no outside closures. Reads the snapshot back out of
// chrome.storage.local, waits for the viewer's public API, hands it off, then
// clears the stashed snapshot so it doesn't linger in storage.
async function injectSnapshotLoader() {
  const KEY = 'swaSnapshot';

  function waitForSwa(timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        if (window.__swa && typeof window.__swa.loadSnapshot === 'function') {
          resolve(window.__swa);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Timed out waiting for viewer to be ready (window.__swa not found)'));
          return;
        }
        setTimeout(poll, 50);
      })();
    });
  }

  try {
    const swa = await waitForSwa(10000);
    const stored = await chrome.storage.local.get(KEY);
    const html = stored[KEY];
    if (!html) {
      console.warn('[ShareWithAgent] no stashed snapshot found in storage');
      return;
    }
    swa.loadSnapshot(html);
    await chrome.storage.local.remove(KEY);
  } catch (err) {
    console.error('[ShareWithAgent] failed to hand off snapshot to viewer:', err);
  }
}

/* ---------- orchestration ---------- */
async function freezeAndAnnotate(tabId) {
  const [{ result: html }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: freezePage,
  });

  if (!html) throw new Error('Capture returned no content');

  await chrome.storage.local.set({ [SNAPSHOT_KEY]: html });

  const viewerUrl = chrome.runtime.getURL('viewer.html');
  const viewerTab = await chrome.tabs.create({ url: viewerUrl });

  // Wait for the new tab to finish loading before injecting the loader (bounded — don't
  // hang forever if the tab never reports 'complete').
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    function onUpdated(tabId2, info) {
      if (tabId2 === viewerTab.id && info.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(finish, 10000);
  });

  await chrome.scripting.executeScript({
    target: { tabId: viewerTab.id },
    func: injectSnapshotLoader,
  });

  return viewerTab.id;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'swa:freeze-and-annotate') return false;

  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab found');
      await freezeAndAnnotate(tab.id);
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});
