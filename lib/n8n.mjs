// Shared helpers for every workflow in this repo. Node 20+, no dependencies.
//   loadEnv()                     .env at the repo root (never printed)
//   api(env, method, path, body)  n8n public REST API (/api/v1)
//   sharedIds()                   credential ids created once by `npm run setup:shared`
//   state(slug)                   per-workflow ids in workflows/<slug>/.n8n-local.json (gitignored)
//   ensureTable(env, st, key, name, columns)   find-or-create an n8n Data Table
//   builder()                     node() factory with stable ids, plus rl() and codeFrom()
//   deploy(env, st, wf)           create or update the workflow, then activate it
//   webhook(env, path, body, headers)  POST to a production webhook and parse the reply
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const p = join(ROOT, '.env');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  // Each workflow has its own mock port (mock/ports.json). Unless MOCK_URL / MOCK_PORT are set in the
  // shell, infer the workflow from the running script's path (workflows/<slug>/...).
  const ports = JSON.parse(readFileSync(join(ROOT, 'mock', 'ports.json'), 'utf8'));
  const slug = (process.argv[1] ?? '').match(/workflows\/([^/]+)\//)?.[1];
  const port = process.env.MOCK_PORT ?? ports[slug] ?? 4610;
  return {
    url: (process.env.N8N_URL ?? 'http://localhost:5678').replace(/\/$/, ''),
    apiKey: process.env.N8N_API_KEY,
    approvalToken: process.env.APPROVAL_TOKEN,
    mockUrl: (process.env.MOCK_URL ?? `http://${process.env.MOCK_HOST ?? 'host.docker.internal'}:${port}`).replace(/\/$/, ''),
    mockLocal: `http://localhost:${port}`,
  };
}

export async function api(env, method, path, body) {
  const res = await fetch(`${env.url}/api/v1${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': env.apiKey ?? '', 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

const sharedPath = join(ROOT, '.n8n-local.json');
export const sharedIds = () => (existsSync(sharedPath) ? JSON.parse(readFileSync(sharedPath, 'utf8')) : {});
export const writeShared = (s) => writeFileSync(sharedPath, JSON.stringify(s, null, 2) + '\n');

export function state(slug) {
  const p = join(ROOT, 'workflows', slug, '.n8n-local.json');
  const s = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  Object.defineProperty(s, 'save', { enumerable: false, value: () => writeFileSync(p, JSON.stringify(s, null, 2) + '\n') });
  return s;
}

export async function ensureTable(env, st, key, name, columns) {
  if (st[key]) return st[key];
  const list = await api(env, 'GET', `/data-tables?filter=${encodeURIComponent(JSON.stringify({ name }))}`);
  const found = (list.data ?? []).find((t) => t.name === name);
  const t = found ?? (await api(env, 'POST', '/data-tables', { name, columns }));
  st[key] = t.id; st.save();
  return t.id;
}

export async function clearTable(env, tableId) {
  const filter = { type: 'or', filters: [{ columnName: 'id', condition: 'gte', value: 0 }] };
  await api(env, 'DELETE', `/data-tables/${tableId}/rows/delete?filter=${encodeURIComponent(JSON.stringify(filter))}`).catch(() => null);
}

export function builder(prefix) {
  // prefix: 4 hex chars unique per workflow so node ids never collide across workflows
  let n = 0;
  const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
    id: `00000000-${prefix}-4000-8000-${String(++n).padStart(12, '0')}`, name, type, typeVersion, position, parameters, ...extra,
  });
  return { node, rl: (value) => ({ __rl: true, mode: 'id', value }) };
}

// Turn an ES module source file into Code-node text: drop `export` and import lines.
export const codeFrom = (absPath) => readFileSync(absPath, 'utf8').replace(/^import .*$/gm, '').replace(/^export (default )?/gm, '');

export async function deploy(env, st, wf) {
  const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? { executionOrder: 'v1' } };
  if (st.workflowId) {
    try { await api(env, 'POST', `/workflows/${st.workflowId}/deactivate`); } catch {}
    await api(env, 'PUT', `/workflows/${st.workflowId}`, body);
  } else {
    const created = await api(env, 'POST', '/workflows', body);
    st.workflowId = created.id; st.save();
  }
  await api(env, 'POST', `/workflows/${st.workflowId}/activate`);
  return st.workflowId;
}

export async function webhook(env, path, body, headers = {}) {
  const t0 = Date.now();
  const res = await fetch(`${env.url}/webhook/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json, ms: Date.now() - t0 };
}

// Mock SaaS helpers (the server in mock/server.mjs records every write it receives).
export async function mockReset(env, app) { await fetch(`${env.mockLocal}/_reset${app ? `?app=${app}` : ''}`, { method: 'POST' }); }
export async function mockLog(env, app) { return (await fetch(`${env.mockLocal}/_log?app=${app}`)).json(); }

export const arg = (name, dflt) => { const a = process.argv; const i = a.indexOf(`--${name}`); return i === -1 ? dflt : (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true); };
