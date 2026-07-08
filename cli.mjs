#!/usr/bin/env node
/**
 * sharewithagent — capture a web page, collect element-anchored visual feedback,
 * hand it back to a coding agent.
 *
 *   sharewithagent annotate <url | file.html>   [--port 7331] [--json] [--out feedback]
 *
 * Flow: capture page -> self-contained snapshot -> serve viewer on localhost ->
 * open browser -> you annotate -> "Send to agent" POSTs JSON back -> we write
 * feedback.json + feedback.md (and, with --json, print the JSON to stdout).
 */
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { capture } from './capture.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { _: [], port: 7331, json: false, out: 'feedback', open: true };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--no-open') a.open = false;
    else if (t === '--port') a.port = +argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else a._.push(t);
  }
  return a;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

/* Compact, prompt-friendly Markdown — kept in the same shape as viewer.html's
   toMarkdown() (intentional twins; update both together). Box / computed styles /
   element HTML live in feedback.json, which is written alongside this file. */
function markdown(p) {
  const n = p.annotations.length;
  let s = `# ${p.tool || 'ShareWithAgent'} feedback — ${p.url || '(uploaded snapshot)'} (${p.viewport}, ${n} item${n === 1 ? '' : 's'})\n\n`;
  s += `_Each item: **author:** "comment" → the page element it refers to (CSS selector into the page DOM)._\n\n`;
  for (const a of p.annotations) {
    s += `${a.n}. ${a.author ? `**${a.author}:** ` : ''}"${a.comment || '(no comment)'}"${a.status === 'saved' ? '' : ' _(draft)_'}\n`;
    s += a.anchor.selectedText
      ? `   → selected "${a.anchor.selectedText}" in \`${a.anchor.selector}\`\n`
      : `   → \`${a.anchor.selector}\`${a.anchor.text ? ` — "${a.anchor.text}"` : ''}\n`;
    for (const r of (a.replies || [])) s += `   ↳ **${r.author}:** ${r.text}\n`;
    s += `\n`;
  }
  s += `_Full anchors (bounding box, computed styles, element HTML) are in feedback.json._\n`;
  return s;
}

async function annotate(target, opts) {
  const log = (...m) => { if (!opts.json) console.error(...m); };
  log(`\n● capturing ${target} …`);
  const snapshot = await capture(target);
  log(`● snapshot ready (${(snapshot.length / 1024).toFixed(0)} KB)`);

  const viewer = await readFile(path.join(__dir, 'viewer.html'), 'utf8');
  const isUrl = /^https?:\/\//i.test(target);

  let resolveDone;
  const done = new Promise(r => (resolveDone = r));

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(viewer);
    } else if (req.method === 'GET' && req.url.startsWith('/__snapshot.html')) {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(snapshot);
    } else if (req.method === 'POST' && req.url === '/api/done') {
      let body = ''; req.on('data', c => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
        try { resolveDone(JSON.parse(body)); } catch { resolveDone({ annotations: [] }); }
      });
    } else { res.writeHead(404); res.end(); }
  });

  await new Promise(r => server.listen(opts.port, r));
  const url = `http://localhost:${opts.port}/?return=/api/done&snapshot=/__snapshot.html&url=${encodeURIComponent(isUrl ? target : '')}`;
  log(`● review open at ${url}`);
  log(`  → annotate in the browser, then click “Send to agent”. (Ctrl-C to abort.)`);
  if (opts.open) openBrowser(url); else log('  → --no-open: not launching a browser');

  const payload = await done;
  server.close();

  payload.url = payload.url || (isUrl ? target : target);
  const md = markdown(payload);
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload));
  } else {
    await writeFile(`${opts.out}.json`, JSON.stringify(payload, null, 2));
    await writeFile(`${opts.out}.md`, md);
    console.error(`\n✓ ${payload.annotations.length} annotation(s) → ${opts.out}.json + ${opts.out}.md\n`);
    console.log(md);
  }
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (cmd === 'annotate' && args._[1]) {
  annotate(args._[1], args).catch(e => { console.error('✗', e.message); process.exit(1); });
} else {
  console.error(`sharewithagent — element-anchored visual feedback for coding agents

Usage:
  sharewithagent annotate <url | file.html>   capture, annotate in browser, return feedback
    --json        print the feedback JSON to stdout (for agents/hooks)
    --port <n>    local server port (default 7331)
    --out <name>  output basename (default "feedback" → feedback.json/.md)
`);
  process.exit(args._.length ? 1 : 0);
}
