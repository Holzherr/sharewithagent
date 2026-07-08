import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dir, 'fixtures', 'tall.html');
const PORT = 7399;

// Start the real CLI server against the fixture so the iframe srcdoc shares a
// real http origin (matches production; file:// would give srcdoc a null origin).
let server;
let serverErr = '';
test.beforeAll(async () => {
  server = spawn('node', ['cli.mjs', 'annotate', FIXTURE, '--no-open', '--port', String(PORT)],
    { cwd: path.join(__dir, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', d => { serverErr += d; });
  // wait for the port to answer
  let alive = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) { alive = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  if (!alive) throw new Error(`CLI server failed to start on port ${PORT}\n--- server stderr ---\n${serverErr}`);
});
test.afterAll(() => { if (server) server.kill(); });

async function openViewer(page) {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
}

test('harness boots and serves the viewer', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/`);
  await expect(page).toHaveTitle(/ShareWithAgent/);
});

test('bridge announces ready', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  expect(await page.evaluate(() => window.__swaReady)).toBe(true);
});

test('pinpoint creates an in-page mark that stays glued on scroll', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('pin'));
  const frame = page.frameLocator('#frame');
  await frame.locator('#target').click();
  const mark = frame.locator('mark.swa-hl[data-swa-id]');
  await expect(mark).toHaveCount(1);
  const before = await mark.boundingBox();
  await page.evaluate(() => document.querySelector('#frame').contentWindow.scrollBy(0, 400));
  await page.waitForTimeout(100);
  const after = await mark.boundingBox();
  const stillInside = await frame.locator('#target mark.swa-hl').count();
  expect(stillInside).toBe(1);
  expect(Math.abs(after.y - (before.y - 400))).toBeLessThan(8);
});

test('the open composer re-anchors when the window resizes', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await expect(page.locator('#composer')).toBeVisible();
  const before = await page.locator('#composer').boundingBox();
  await page.setViewportSize({ width: 760, height: 900 });
  await page.waitForTimeout(200);
  const after = await page.locator('#composer').boundingBox();
  // it moved to track the reflowed anchor (did not stay pinned to the old x)
  expect(Math.abs(after.x - before.x)).toBeGreaterThan(1);
  // and stayed on-screen
  expect(after.x).toBeGreaterThanOrEqual(0);
  expect(after.x + after.width).toBeLessThanOrEqual(760 + 1);
});

test('CSP meta in the snapshot does not block the bridge', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  const ready = await page.evaluate(async () => {
    const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`;
    const html = `<!doctype html><html><head>${csp}</head><body><p id="t">CSP page</p></body></html>`;
    window.__swaReady = false;
    window.__swa.loadSnapshot(html);
    await new Promise(r => setTimeout(r, 800));
    return window.__swaReady;
  });
  expect(ready).toBe(true);
});

test('text selection creates a highlighted comment annotation', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  const frame = page.frameLocator('#frame');
  await frame.locator('#selectme').click({ clickCount: 3 });
  await expect(page.locator('#composer')).toBeVisible();
  await page.locator('#composer textarea').fill('x');
  await page.locator('#composer textarea').press('Meta+Enter');
  await expect(frame.locator('#selectme mark.swa-hl')).toHaveCount(1);
  await expect(page.locator('.card')).toHaveCount(1);
});

test('text selection opens an inline composer (no #seltools bubble)', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#composer textarea')).toBeFocused();
  expect(await page.locator('#seltools').count()).toBe(0); // bubble removed
  await page.locator('#composer textarea').fill('tighten this copy');
  await page.locator('#composer textarea').press('Meta+Enter');
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations[0]?.status)).toBe('saved');
  expect(await page.evaluate(() => window.__swa.state.annotations[0].comment)).toBe('tighten this copy');
});

test('switching selection replaces an empty draft instead of orphaning it', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  const frame = page.frameLocator('#frame');
  await frame.locator('#selectme').click({ clickCount: 3 });
  await expect(page.locator('#composer')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(1);
  // No typing — the draft stays empty. Now select a different element entirely.
  await frame.locator('#target').click({ clickCount: 3 });
  // Poll on the content (not just length, which is trivially 1 both before and after
  // the swap) so this actually waits for the new selection's async message to land.
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations[0]?.anchor.selectedText))
    .toContain('PINPOINT_TARGET');
  expect(await page.evaluate(() => window.__swa.state.annotations.length)).toBe(1);
  // Scoped per-element (matching the pattern used elsewhere in this file): the old
  // #selectme draft's mark must be gone (no orphan) and #target must have its new one.
  // (A bare frame-wide mark.swa-hl count is not used here — there's a pre-existing,
  // unrelated bridge quirk where whitespace text nodes between sibling <p> tags get
  // wrapped with the annotation id, sitting outside the element; it reproduces even
  // for a single isolated selection on the unmodified base branch and is out of scope.)
  await expect(frame.locator('#selectme mark.swa-hl')).toHaveCount(0);
  await expect(frame.locator('#target mark.swa-hl')).toHaveCount(1);
});

test('pinning while an empty text draft is open cancels the orphan', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  const frame = page.frameLocator('#frame');
  await frame.locator('#selectme').click({ clickCount: 3 });
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(1);
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await frame.locator('#target').click();
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations[0]?.type)).toBe('pin');
  await expect(frame.locator('#selectme mark.swa-hl')).toHaveCount(0);
});

test('exported .html reopens with marks re-anchored', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  const frame = page.frameLocator('#frame');
  await frame.locator('#selectme').click({ clickCount: 3 });
  await expect(page.locator('#composer')).toBeVisible();
  await page.locator('#composer textarea').fill('x');
  await page.locator('#composer textarea').press('Meta+Enter');
  await expect(frame.locator('#selectme mark.swa-hl')).toHaveCount(1);
  const exported = await page.evaluate(() => window.__swa.exportSelfContained());
  await page.setContent(exported);
  const frame2 = page.frameLocator('#frame');
  await expect(frame2.locator('#selectme mark.swa-hl')).toHaveCount(1, { timeout: 5000 });
});

test('pinpoint on an SVG node with text selects the whole node', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('pin'));
  const frame = page.frameLocator('#frame');
  await frame.locator('svg rect').click();
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(1);
  const ann = await page.evaluate(() => window.__swa.state.annotations[0]);
  expect(ann.anchor.text).toContain('SVG_NODE_LABEL');
});

test('bottom bar renders; panel is closed by default and toggles', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await expect(page.locator('#bottombar')).toBeVisible();
  await expect(page.locator('#panel')).not.toHaveClass(/open/);
  await page.locator('#panelToggle').click();
  await expect(page.locator('#panel')).toHaveClass(/open/);
  await page.keyboard.press('Meta+.');
  await expect(page.locator('#panel')).not.toHaveClass(/open/);
});

test('bottom bar tools + viewport still drive the bridge', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  expect(await page.evaluate(() => window.__swa.state.tool)).toBe('pin');
  await page.locator('#bottombar [data-vw="mobile"]').click();
  expect(await page.evaluate(() => window.__swa.state.viewport)).toBe('mobile');
});

test('pin creates a draft; ⌘Enter saves it', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Tester'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150); // let the bridge enter pinpoint mode (async set-input-method)
  await page.frameLocator('#frame').locator('#target').click();
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations[0]?.status)).toBe('draft');
  await page.locator('#composer textarea').fill('contrast too low');
  await page.locator('#composer textarea').press('Meta+Enter');
  expect(await page.evaluate(() => window.__swa.state.annotations[0].status)).toBe('saved');
  expect(await page.evaluate(() => window.__swa.state.annotations[0].comment)).toBe('contrast too low');
});

test('pin opens the inline composer at the element', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await expect(page.locator('#composer')).toBeVisible();
  await page.locator('#composer textarea').fill('pinned note');
  await page.locator('#composer textarea').press('Meta+Enter');
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations[0]?.status)).toBe('saved');
});

test('Esc on an unsaved draft removes it', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150); // let the bridge enter pinpoint mode (async set-input-method)
  await page.frameLocator('#frame').locator('#target').click();
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(1);
  await page.locator('#composer textarea').press('Escape');
  expect(await page.evaluate(() => window.__swa.state.annotations.length)).toBe(0);
});

test('first save captures a commenter name and stamps author', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150); // let the bridge enter pinpoint mode (async set-input-method)
  await page.frameLocator('#frame').locator('#target').click();
  await page.locator('#composer textarea').fill('fix this');
  await page.locator('#composer textarea').press('Meta+Enter');
  expect(await page.evaluate(() => window.__swa.state.annotations[0].author)).toBe('Nick');
  expect(await page.evaluate(() => window.__swa.state.commenterName)).toBe('Nick');
});

test('identity component sets the name without any native prompt', async ({ page }) => {
  let prompted = false;
  await page.exposeFunction('__prompted', () => { prompted = true; });
  await page.addInitScript(() => { window.prompt = () => { window.__prompted(); return 'X'; }; });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await expect(page.locator('#identity')).toBeVisible();
  await page.locator('#identityName').fill('Nick');
  await page.locator('#identitySave').click();
  await expect(page.locator('#identityLabel')).toContainText('Nick');
  expect(await page.evaluate(() => window.__swa.state.commenterName)).toBe('Nick');
  expect(prompted).toBe(false);
});

test('posting with no name focuses the identity input instead of prompting', async ({ page }) => {
  await page.addInitScript(() => { localStorage.removeItem('swa.commenterName'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(1);
  // draft exists; try to save with no name
  await page.evaluate(() => window.__swa.saveAnnotation(window.__swa.state.annotations[0].id));
  await expect(page.locator('#identity')).toHaveClass(/flag/);
  expect(await page.evaluate(() => window.__swa.state.annotations[0].status)).toBe('draft'); // NOT saved yet
});

test('a reply is appended to a comment with author', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Sam'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150); // let the bridge enter pinpoint mode (async set-input-method)
  await page.frameLocator('#frame').locator('#target').click();
  await page.locator('#composer textarea').fill('top-level');
  await page.locator('#composer textarea').press('Meta+Enter');
  await page.locator('.card').first().locator('.col').click();     // expand the now-collapsed saved card
  await page.locator('.card [data-act="reply"]').click();
  await page.locator('.card .replybox textarea').fill('agreed');
  await page.locator('.card .replybox [data-act="postreply"]').click();
  const replies = await page.evaluate(() => window.__swa.state.annotations[0].replies);
  expect(replies.length).toBe(1);
  expect(replies[0]).toMatchObject({ author: 'Sam', text: 'agreed' });
});

test('a posted comment collapses; clicking expands it; one at a time', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  // two pinned + saved comments
  for (const sel of ['#target', '#selectme']) {
    await page.locator('#bottombar [data-tool="pin"]').click();
    await page.waitForTimeout(150);
    await page.frameLocator('#frame').locator(sel).click();
    await page.locator('#composer textarea').fill('note on '+sel);
    await page.locator('#composer textarea').press('Meta+Enter');
  }
  // both collapsed
  await expect(page.locator('.card.collapsed')).toHaveCount(2);
  // expand the first
  await page.locator('.card').first().locator('.col').click();
  await expect(page.locator('.card').first()).toHaveClass(/expanded/);
  // expand the second → first collapses
  await page.locator('.card').nth(1).locator('.col').click();
  await expect(page.locator('.card').nth(1)).toHaveClass(/expanded/);
  await expect(page.locator('.card').first()).toHaveClass(/collapsed/);
});

test('delete lives behind the ⋯ overflow', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await page.locator('#composer textarea').fill('x'); await page.locator('#composer textarea').press('Meta+Enter');
  await page.locator('.card').first().locator('.col').click();     // expand
  await page.locator('.card .dots').click();                        // open overflow
  await page.locator('.card .menu [data-act="del"]').click();
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(0);
});

test('Share menu: CLI send enabled with ?return; download round-trips author', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#shareToggle').click();
  await expect(page.locator('#shareMenu [data-share="cli"]')).toBeVisible();
  await expect(page.locator('#shareMenu [data-share="html"]')).toBeVisible();
  await expect(page.locator('#shareMenu [data-share="link"]')).toBeVisible();
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150); // let the bridge enter pinpoint mode (async set-input-method)
  await page.frameLocator('#frame').locator('#target').click();
  await page.locator('#composer textarea').fill('hi'); await page.locator('#composer textarea').press('Meta+Enter');
  const html = await page.evaluate(() => window.__swa.exportSelfContained());
  expect(html).toContain('"author":"Nick"');
});

test('Share menu hides CLI send when launched without ?return', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#shareToggle').click();
  await expect(page.locator('#shareMenu [data-share="cli"]')).toHaveCount(0);
});

test('hold Alt peeks the other tool, release reverts', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  expect(await page.evaluate(() => window.__swa.state.tool)).toBe('select');
  await page.keyboard.down('Alt');
  await expect.poll(() => page.evaluate(() => window.__swa.effectiveTool())).toBe('pin');
  await page.keyboard.up('Alt');
  await expect.poll(() => page.evaluate(() => window.__swa.effectiveTool())).toBe('select');
});

test('mobile viewport makes the panel a full-width bottom sheet', async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-vw="mobile"]').click();
  await page.locator('#panelToggle').click();
  await expect(page.locator('#panel')).toHaveClass(/sheet/);
});

test('header count reflects the number of annotations', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Tester'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(1);
  await expect(page.locator('#ptCount')).toHaveText('1');
  // draft cards are always expanded, so the ⋯ overflow is already available
  await page.locator('.card .dots').click();
  await page.locator('.card .menu [data-act="del"]').click();
  await expect(page.locator('#ptCount')).toHaveText('0');
});

test('emitted annotation JSON keeps the frozen shape', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await page.locator('#composer textarea').fill('shape check');
  await page.locator('#composer textarea').press('Meta+Enter');
  const ann = await page.evaluate(() => window.__swa.buildPayload().annotations[0]);
  expect(Object.keys(ann).sort()).toEqual(
    ['anchor','author','comment','id','n','replies','status','type','viewport'].sort());
  expect(Object.keys(ann.anchor).sort()).toEqual(
    ['boundingBox','computedStyles','elementHtml','selector','text'].sort());
  expect(['draft','saved']).toContain(ann.status);
});

test('contract guard: text-selection and SVG-pin anchor variants keep their frozen shapes', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  // text selection → anchor gains selectedText, nothing else
  await page.evaluate(() => window.__swa.setTool('select'));
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await expect(page.locator('#composer')).toBeVisible();
  await page.locator('#composer textarea').fill('text variant');
  await page.locator('#composer textarea').press('Meta+Enter');
  // SVG element-only pin → anchor gains element:true, nothing else
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('svg rect').click();
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(2);
  await expect(page.locator('#composer')).toBeVisible();
  await page.locator('#composer textarea').fill('svg variant');
  await page.locator('#composer textarea').press('Meta+Enter');
  const anns = await page.evaluate(() => window.__swa.buildPayload().annotations);
  const text = anns.find(a => a.type === 'text'), svg = anns.find(a => a.anchor.element);
  expect(Object.keys(text.anchor).sort()).toEqual(
    ['boundingBox','computedStyles','elementHtml','selectedText','selector','text'].sort());
  expect(Object.keys(svg.anchor).sort()).toEqual(
    ['boundingBox','computedStyles','element','elementHtml','selector','text'].sort());
  expect(svg.anchor.element).toBe(true);
});

test('a keystroke racing the composer focus is routed into the composer (type-to-comment)', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await expect(page.locator('#composer')).toBeVisible();
  // simulate the bridge's keytype forward (a key pressed in the iframe pre-focus)
  const swaFrame = page.frames().find(f => f !== page.mainFrame());
  await swaFrame.evaluate(() => parent.postMessage({ type: 'swa-bridge-keytype', key: 'H' }, '*'));
  await expect(page.locator('#composer textarea')).toHaveValue('H');
  await expect(page.locator('#composer textarea')).toBeFocused();
  // and the draft comment tracked it
  expect(await page.evaluate(() => window.__swa.state.annotations[0].comment)).toBe('H');
});

test('the open composer tracks parent-side stage scrolling', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.setViewportSize({ width: 800, height: 500 });  // smaller than the 1024px preset → .stage scrolls
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await expect(page.locator('#composer')).toBeVisible();
  const before = await page.locator('#composer').boundingBox();
  await page.evaluate(() => { document.querySelector('.stage').scrollBy(0, 120); });
  await page.waitForTimeout(150);
  const after = await page.locator('#composer').boundingBox();
  expect(Math.abs((before.y - after.y) - 120)).toBeLessThan(10);  // moved up with the stage scroll
});

test('first-use coach shows on load, retires after first composer, dismissal persists', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); localStorage.removeItem('swa.coachDone'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await expect(page.locator('#coach')).toBeVisible();
  await page.evaluate(() => window.__swa.setTool('select'));
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await expect(page.locator('#coach')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('swa.coachDone'))).toBe('1');
});

test('while composing, the rail card is a live mirror with no duplicate editor', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await expect(page.locator('#composer')).toBeVisible();
  // card shows the mirror, not a second textarea / second Comment button
  await expect(page.locator('.card .draftlive')).toBeVisible();
  expect(await page.locator('.card .exp > textarea').count()).toBe(0);
  expect(await page.locator('.card [data-act="save"]').count()).toBe(0);
  // typing in the composer live-updates the mirror
  await page.locator('#composer textarea').fill('mirrored');
  await expect(page.locator('.card .draftlive')).toHaveText('mirrored');
  // click-outside with text keeps the draft and switches the card to the full editor
  await page.locator('#identity').click();
  await expect(page.locator('#composer')).toBeHidden();
  await expect(page.locator('.card .exp > textarea')).toHaveValue('mirrored');
  await expect(page.locator('.card [data-act="save"]')).toBeVisible();
});

test('text-selection marks no longer produce whitespace-only stub highlights', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await expect(page.locator('#composer')).toBeVisible();
  const stubs = await page.frameLocator('#frame').locator('mark.swa-hl').evaluateAll(
    ms => ms.filter(m => !m.textContent.trim()).length);
  expect(stubs).toBe(0);
});

test('the open composer tracks in-iframe scrolling (composerMarkId survives open)', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await expect(page.locator('#composer')).toBeVisible();
  const before = await page.locator('#composer').boundingBox();
  await page.evaluate(() => document.querySelector('#frame').contentWindow.scrollBy(0, 200));
  await page.waitForTimeout(200);
  const after = await page.locator('#composer').boundingBox();
  expect(Math.abs((before.y - after.y) - 200)).toBeLessThan(12);  // glued to the mark through iframe scroll
});

test('the card editor works after click-outside keeps a draft (save and Esc paths)', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await page.locator('#composer textarea').fill('kept draft');
  await page.locator('#identity').click();                       // click-outside with text → keep draft
  await expect(page.locator('#composer')).toBeHidden();
  const ta = page.locator('.card .exp > textarea');
  await expect(ta).toHaveValue('kept draft');
  await ta.fill('kept draft, edited in card');
  await ta.press('Meta+Enter');                                  // card-side ⌘↵ save
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations[0].status)).toBe('saved');
  expect(await page.evaluate(() => window.__swa.state.annotations[0].comment)).toBe('kept draft, edited in card');
  // Esc path: new draft, keep via click-outside, Esc in the card editor cancels it
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await page.locator('#composer textarea').fill('to be cancelled');
  await page.locator('#identity').click();
  await page.locator('.card.draft .exp > textarea').press('Escape');
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(1);
});

test('Esc in a saved card does not strand another draft\u2019s live mirror', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  // saved comment on #target
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await page.locator('#composer textarea').fill('saved one');
  await page.locator('#composer textarea').press('Meta+Enter');
  // draft composer on #selectme
  await page.locator('#bottombar [data-tool="select"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await page.locator('#composer textarea').fill('live draft');
  // expand the saved card (panel click keeps the composer), press Esc in ITS textarea
  await page.locator('.card.collapsed .col').click();
  await page.locator('.card.expanded:not(.draft) .exp > textarea').press('Escape');
  // composer must still be alive and the draft intact
  await expect(page.locator('#composer')).toBeVisible();
  expect(await page.evaluate(() => window.__swa.state.annotations.length)).toBe(2);
});

test('deleting the annotation being composed closes its composer', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await page.locator('#composer textarea').fill('doomed');
  await page.locator('.card .dots').click();
  await page.locator('.card .menu [data-act="del"]').click();
  await expect(page.locator('#composer')).toBeHidden();
  expect(await page.evaluate(() => window.__swa.state.annotations.length)).toBe(0);
});

test('cancelling one draft from its card does not close another draft\u2019s composer', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  // draft A: kept via click-outside (non-empty)
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await page.locator('#composer textarea').fill('draft A');
  await page.locator('#identity').click();
  await expect(page.locator('#composer')).toBeHidden();
  // draft B: composer open
  await page.locator('#bottombar [data-tool="pin"]').click();
  await page.waitForTimeout(150);
  await page.frameLocator('#frame').locator('#target').click();
  await expect(page.locator('#composer')).toBeVisible();
  await page.locator('#composer textarea').fill('draft B');
  // Esc in draft A's card editor cancels only A; B's composer stays open
  await page.locator('.card.draft .exp > textarea').press('Escape');
  await expect.poll(() => page.evaluate(() => window.__swa.state.annotations.length)).toBe(1);
  await expect(page.locator('#composer')).toBeVisible();
  expect(await page.evaluate(() => window.__swa.state.annotations[0].comment)).toBe('draft B');
});

test('elementHtml never contains injected swa-hl instrumentation', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  // full-element text selection: the mark wraps ALL of #selectme's text, so the
  // anchor host's outerHTML would contain the mark without the clean-serialize fix
  await page.evaluate(() => window.__swa.setTool('select'));
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await page.locator('#composer textarea').fill('clean html check');
  await page.locator('#composer textarea').press('Meta+Enter');
  const html = await page.evaluate(() => window.__swa.buildPayload().annotations[0].anchor.elementHtml);
  expect(html).not.toContain('swa-hl');
  expect(html).not.toContain('data-swa-id');
  expect(html).toContain('SELECT_THIS_PHRASE');   // the real content survives the unwrap
});

test('Markdown export is compact: locator line per item, no box/styles/HTML dumps', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('swa.commenterName', 'Nick'); });
  await page.goto(`http://localhost:${PORT}/?return=/api/done&snapshot=/__snapshot.html&url=`);
  await page.waitForFunction(() => window.__swaReady === true, { timeout: 10000 });
  await page.evaluate(() => window.__swa.setTool('select'));
  await page.frameLocator('#frame').locator('#selectme').click({ clickCount: 3 });
  await page.locator('#composer textarea').fill('tighten this');
  await page.locator('#composer textarea').press('Meta+Enter');
  const md = await page.evaluate(() => window.__swa.toMarkdown());
  expect(md).toContain('**Nick:** "tighten this"');
  expect(md).toMatch(/→ selected ".*" in `/);
  expect(md).not.toContain('**Box:**');
  expect(md).not.toContain('**Styles:**');
  expect(md).not.toContain('**HTML:**');
  expect(md).toContain('structured JSON');   // pointer to the full detail
});

export { openViewer, PORT };

