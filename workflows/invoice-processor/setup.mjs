#!/usr/bin/env node
// Builds the workflow and creates/updates + activates it in a running n8n (public REST API). Idempotent.
//   node workflows/invoice-processor/setup.mjs                         # baseline
//   node workflows/invoice-processor/setup.mjs --variant trust-model   # swap in the regression (same workflow id)
// Needs `npm run setup:shared` first (OpenRouter + approval-header credentials).
import { loadEnv, sharedIds, state, deploy, arg } from '../../lib/n8n.mjs';
import { buildWorkflow, SLUG } from './build.mjs';

const env = loadEnv();
if (!env.apiKey) throw new Error('Set N8N_API_KEY in .env');
const ids = sharedIds();
if (!ids.openRouterCredId || !ids.approvalCredId) throw new Error('Run `npm run setup:shared` first.');
const variant = arg('variant', 'baseline');
const st = state(SLUG);
const { names, ...wf } = buildWorkflow({ variant, mockUrl: env.mockUrl, ids });
const id = await deploy(env, st, wf);
st.variant = variant; st.mockUrl = env.mockUrl; st.save();
console.log(`${variant} active (${wf.nodes.length} nodes). webhook: ${env.url}/webhook/invoice-processor  editor: ${env.url}/workflow/${id}  mock: ${env.mockUrl}`);
