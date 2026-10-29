#!/usr/bin/env node
// Builds and deploys the lead router to a running n8n (public REST API), then activates it.
//   node workflows/lead-router/setup.mjs                    # baseline
//   node workflows/lead-router/setup.mjs --variant naive    # regression variant (same workflow id)
// Needs: repo .env (N8N_API_KEY, MOCK_URL) and `npm run setup:shared` run once for the credentials.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, state, deploy, sharedIds, arg } from '../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
if (!env.apiKey) throw new Error('Set N8N_API_KEY in .env');
if (!sharedIds().openRouterCredId) throw new Error('Run `npm run setup:shared` first (creates the OpenRouter + approval credentials).');
const variant = arg('variant', 'baseline');
const out = join(HERE, 'workflow', '.import.json');
execFileSync(process.execPath, [join(HERE, 'build.mjs'), '--variant', variant, '--out', out], { stdio: 'inherit' });
const st = state('lead-router');
const id = await deploy(env, st, JSON.parse(readFileSync(out, 'utf8')));
st.variant = variant; st.save();
console.log(`active (${variant}). webhook: ${env.url}/webhook/lead-router   editor: ${env.url}/workflow/${id}`);
