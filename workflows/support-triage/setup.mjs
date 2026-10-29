#!/usr/bin/env node
// Builds the workflow and creates or updates it in n8n, then activates it. Idempotent.
//   node workflows/support-triage/setup.mjs                   # baseline
//   node workflows/support-triage/setup.mjs --variant naive   # swap in the regression build (same workflow id)
// Needs `npm run setup:shared` first (OpenRouter + approval-header credentials).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, sharedIds, state, deploy, arg } from '../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
if (!env.apiKey) throw new Error('Set N8N_API_KEY in .env');
if (!sharedIds().openRouterCredId) throw new Error('Run `npm run setup:shared` first');
const variant = arg('variant', 'baseline');
const tmp = join(HERE, 'workflow', '.import.json');
execFileSync(process.execPath, [join(HERE, 'build.mjs'), '--variant', variant, '--out', tmp], { stdio: 'inherit' });
const st = state('support-triage');
const id = await deploy(env, st, JSON.parse(readFileSync(tmp, 'utf8')));
st.variant = variant; st.save();
console.log(`active (${variant}). webhook: ${env.url}/webhook/support-triage   editor: ${env.url}/workflow/${id}`);
