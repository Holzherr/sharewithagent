/**
 * capture(target) -> self-contained HTML string.
 *
 * - Local .html file (or file:// URL): read as-is (assumed already self-contained,
 *   e.g. exported by the SingleFile browser add-on or the ShareWithAgent extension).
 * - http(s) URL: freeze it with SingleFile (single-file-cli) using a local Chrome.
 *
 * We deliberately do NOT hand-roll DOM serialization — SingleFile handles lazy
 * images, shadow DOM, fonts, cross-origin assets, etc.
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

function findChrome() {
  if (process.env.SHAREWITHAGENT_CHROME && existsSync(process.env.SHAREWITHAGENT_CHROME)) return process.env.SHAREWITHAGENT_CHROME;
  return CHROME_CANDIDATES.find(p => existsSync(p)) || null;
}

export async function capture(target) {
  // local file or file:// → assume already self-contained
  if (target.startsWith('file://')) target = fileURLToPath(target);
  if (!/^https?:\/\//i.test(target)) {
    if (!existsSync(target)) throw new Error(`file not found: ${target}`);
    return await readFile(target, 'utf8');
  }

  const chrome = findChrome();
  if (!chrome) {
    throw new Error(
      'No Chrome/Chromium found for live capture.\n' +
      '  Fix: set SHAREWITHAGENT_CHROME=/path/to/chrome, or install Chrome,\n' +
      '  or capture with the SingleFile browser add-on and pass the saved .html file instead.'
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'sharewithagent-'));
  const out = path.join(dir, 'snapshot.html');
  const bin = path.join(__dir, 'node_modules', '.bin', process.platform === 'win32' ? 'single-file.cmd' : 'single-file');

  await new Promise((resolve, reject) => {
    const ps = spawn(bin, [
      target, out,
      `--browser-executable-path=${chrome}`,
      '--browser-wait-until=networkIdle',
      '--load-deferred-images-max-idle-time=2000',
    ], { stdio: 'inherit' });
    ps.on('error', reject);
    ps.on('exit', code => code === 0 ? resolve() : reject(new Error(`single-file exited ${code}`)));
  });

  const html = await readFile(out, 'utf8');
  await rm(dir, { recursive: true, force: true });
  return html;
}
