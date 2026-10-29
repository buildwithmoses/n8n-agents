#!/usr/bin/env node
// Mock SaaS server: stands in for HubSpot, Slack, Zendesk, Stripe, QuickBooks, BambooHR, Google Workspace, etc.
// so every workflow runs end to end with real HTTP Request nodes and no real accounts.
// Each workflow owns workflows/<slug>/mock.mjs exporting `routes`: { 'GET /app/path': (req, ctx) => body, ... }.
// Paths may contain :params. Every non-GET request is recorded; evals read it back.
//   GET  /_log?app=hubspot     recorded writes for that app (or all)
//   node mock/server.mjs                 one mock per workflow, ports in mock/ports.json
//   MOCK_ONLY=<slug> node mock/server.mjs  just that workflow's mock
//   POST /_reset[?app=x]       clear recorded writes (and that app's in-memory state)
// Swap MOCK_URL for the real API base URLs (and attach credentials) to go live.
import { createServer } from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = JSON.parse(readFileSync(join(ROOT, 'mock', 'ports.json'), 'utf8'));

// Default: one isolated mock per workflow on its own port (mock/ports.json), so two workflows that both
// mock /hubspot or /slack never share routes or state. MOCK_ONLY=<slug> runs a single one.
if (!process.env.MOCK_ONLY) {
  for (const [slug, port] of Object.entries(PORTS)) {
    if (!existsSync(join(ROOT, 'workflows', slug, 'mock.mjs'))) continue;
    spawn(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, MOCK_ONLY: slug, MOCK_PORT: String(port) } });
  }
  await new Promise(() => {});
}
const PORT = Number(process.env.MOCK_PORT ?? PORTS[process.env.MOCK_ONLY] ?? 4610);
const routes = [];
const log = [];
const stores = {}; // per-app in-memory state, e.g. stores.hubspot.contacts

const ONLY = process.env.MOCK_ONLY;
for (const slug of readdirSync(join(ROOT, 'workflows'))) {
  if (ONLY && slug !== ONLY) continue;
  const f = join(ROOT, 'workflows', slug, 'mock.mjs');
  if (!existsSync(f)) continue;
  const mod = await import(pathToFileURL(f).href);
  for (const [key, handler] of Object.entries(mod.routes ?? {})) {
    const [method, path] = key.split(' ');
    const names = [];
    const re = new RegExp('^' + path.replace(/:[a-zA-Z_]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, re, names, handler, slug, app: path.split('/')[1] });
  }
}

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let raw = ''; for await (const c of req) raw += c;
  let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  if (url.pathname === '/_log') { const app = url.searchParams.get('app'); return send(res, 200, log.filter((l) => !app || l.app === app)); }
  if (url.pathname === '/_reset') {
    const app = url.searchParams.get('app');
    for (let i = log.length - 1; i >= 0; i--) if (!app || log[i].app === app) log.splice(i, 1);
    if (app) delete stores[app]; else for (const k of Object.keys(stores)) delete stores[k];
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/_health') return send(res, 200, { ok: true, routes: routes.length });
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    const store = (stores[r.app] ??= {});
    if (req.method !== 'GET') log.push({ app: r.app, method: req.method, path: url.pathname, body, at: new Date().toISOString() });
    try {
      const out = await r.handler({ params, query: Object.fromEntries(url.searchParams), body, headers: req.headers }, { store, log });
      if (out && out.__status) return send(res, out.__status, out.body ?? {});
      return send(res, 200, out ?? { ok: true });
    } catch (e) { return send(res, 500, { error: String(e.message ?? e) }); }
  }
  send(res, 404, { error: `no mock route for ${req.method} ${url.pathname}` });
}).listen(PORT, () => console.log(`mock SaaS for ${ONLY} on :${PORT} with ${routes.length} routes`));
