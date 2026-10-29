#!/usr/bin/env node
// Creates the credentials every workflow shares (idempotent). Ids go to .n8n-local.json (gitignored).
//   OpenRouter (key from .env, never printed)   -> openRouterCredId
//   Header auth X-Approval-Token                -> approvalCredId (guards every Wait-for-approval webhook)
import { loadEnv, api, sharedIds, writeShared } from '../lib/n8n.mjs';
const env = loadEnv();
if (!env.apiKey) throw new Error('Set N8N_API_KEY in .env');
const s = sharedIds();
async function ensure(key, body) {
  if (s[key]) return console.log(`${body.name}: ${s[key]} (exists)`);
  const c = await api(env, 'POST', '/credentials', body);
  s[key] = c.id; writeShared(s); console.log(`${body.name}: ${c.id} (created)`);
}
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing from .env');
await ensure('openRouterCredId', { name: 'OpenRouter (n8n-agents)', type: 'openRouterApi', data: { apiKey: process.env.OPENROUTER_API_KEY } });
if (!env.approvalToken) throw new Error('APPROVAL_TOKEN missing from .env');
await ensure('approvalCredId', { name: 'Approval header (n8n-agents)', type: 'httpHeaderAuth', data: { name: 'X-Approval-Token', value: env.approvalToken } });
