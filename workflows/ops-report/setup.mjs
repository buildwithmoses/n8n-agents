#!/usr/bin/env node
// Builds the workflow from source and creates/updates + activates it in the running n8n (public REST API).
// Run `npm run setup:shared` at the repo root first (OpenRouter + approval credentials).
//   node workflows/ops-report/setup.mjs                    # baseline
//   node workflows/ops-report/setup.mjs --variant naive    # regression variant, same workflow id
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, state, deploy, sharedIds, arg } from '../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
if (!env.apiKey) throw new Error('Set N8N_API_KEY in .env');
if (!sharedIds().openRouterCredId) throw new Error('Run `npm run setup:shared` first');
const variant = arg('variant', 'baseline');
const out = join(HERE, 'workflow', '.import.json');
execFileSync(process.execPath, [join(HERE, 'build.mjs'), '--variant', variant, '--out', out], { stdio: 'inherit' });
const wf = JSON.parse(readFileSync(out, 'utf8'));
const st = state('ops-report');
const id = await deploy(env, st, wf);
st.variant = variant; st.save();
console.log(`active (${variant}). webhook: ${env.url}/webhook/ops-report   editor: ${env.url}/workflow/${id}`);
