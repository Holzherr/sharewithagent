/* ShareWithAgent extension — popup trigger.
 *
 * Kept intentionally thin: all capture/hand-off logic lives in background.js
 * (a service worker), since that work needs to survive the popup closing and
 * needs scripting access to both the source tab and the new viewer tab.
 */
const $ = (s) => document.querySelector(s);

const btn = $('#cap');
const status = $('#status');

function setStatus(text, isError) {
  status.textContent = text;
  status.classList.toggle('error', !!isError);
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  setStatus('Freezing page…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'swa:freeze-and-annotate' });
    if (!response?.ok) {
      throw new Error(response?.error || 'Unknown error');
    }
    setStatus('Opened in ShareWithAgent ✓');
    // Close the popup shortly after success so the new tab takes focus cleanly.
    setTimeout(() => window.close(), 400);
  } catch (err) {
    setStatus('Capture failed: ' + (err?.message || err), true);
    btn.disabled = false;
  }
});
