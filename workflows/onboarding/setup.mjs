#!/usr/bin/env node
// Builds the workflow and creates/updates + activates it in n8n (public REST API). Idempotent.
// Needs the shared credentials first: `node scripts/setup-shared.mjs` at the repo root.
//   node workflows/onboarding/setup.mjs                               # baseline
//   node workflows/onboarding/setup.mjs --variant single-approval     # swap in a regression (same workflow id)
//   node workflows/onboarding/setup.mjs --variant model-plan
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, sharedIds, state, deploy, arg } from '../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
if (!env.apiKey) throw new Error('Set N8N_API_KEY in .env');
const ids = sharedIds();
if (!ids.openRouterCredId || !ids.approvalCredId) throw new Error('Run `node scripts/setup-shared.mjs` first (shared credentials).');
const variant = arg('variant', 'baseline');
const tmp = join(HERE, 'workflow', '.import.json');
execFileSync(process.execPath, [join(HERE, 'build.mjs'), '--variant', variant, '--out', tmp], { stdio: 'inherit' });
const st = state('onboarding');
const id = await deploy(env, st, JSON.parse(readFileSync(tmp, 'utf8')));
st.variant = variant; st.save();
console.log(`active (${variant}). webhook: ${env.url}/webhook/onboarding/new-hire   editor: ${env.url}/workflow/${id}`);
