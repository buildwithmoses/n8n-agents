#!/usr/bin/env node
// Runs the 26 labeled leads through the LIVE n8n workflow (production webhook), plays Dana for every lead the
// workflow holds (POST to its Wait resume URL with the approval header), then reads the mock HubSpot/Slack
// state back and scores it. Labels and scripted approvals never reach the workflow.
//
//   node workflows/lead-router/evals/run.mjs                    # label from the deployed variant
//   node workflows/lead-router/evals/run.mjs --label baseline --ids L01,L20
// Writes evals/results/<label>-<ts>.json and evals/results/latest.json; gate.mjs reads latest.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, api, webhook, state, arg } from '../../../lib/n8n.mjs';
import { scoreRun } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
const MOCK = `http://localhost:${process.env.MOCK_PORT ?? 4611}`;
const st = state('lead-router');
const label = arg('label', st.variant ?? 'baseline');
const only = arg('ids') ? String(arg('ids')).split(',') : null;
const fixtures = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'leads.json'), 'utf8')).leads.filter((l) => !only || only.includes(l.lead_id));
const strip = ({ expected, approval, injection_target, note, ...lead }) => lead;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (p) => (await fetch(`${MOCK}${p}`)).json();

async function waitForExecution(id, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ex = await api(env, 'GET', `/executions/${id}`);
    if (ex.status && !['running', 'waiting', 'new'].includes(ex.status)) return ex;
    await sleep(500);
  }
  throw new Error(`execution ${id} did not finish in ${timeoutMs} ms`);
}

async function tokens(executionId) {
  try {
    const ex = await api(env, 'GET', `/executions/${executionId}?includeData=true`);
    const runs = ex.data?.resultData?.runData?.['OpenRouter: Claude Haiku 5.5'] ?? [];
    return runs.reduce((a, r) => { const u = r.data?.ai_languageModel?.[0]?.[0]?.json?.tokenUsage ?? {}; return { in: a.in + (u.promptTokens ?? 0), out: a.out + (u.completionTokens ?? 0) }; }, { in: 0, out: 0 });
  } catch { return { in: 0, out: 0 }; }
}

await fetch(`${MOCK}/_reset?app=hubspot`, { method: 'POST' });
await fetch(`${MOCK}/_reset?app=slack`, { method: 'POST' });
const results = [];
for (const fx of fixtures) {
  const before = await getJson('/_log');
  const r = await webhook(env, 'lead-router', { lead: strip(fx) });
  const row = { lead_id: fx.lead_id, http: r.status, ms: r.ms, response: r.json, approval_sent: null, final: null };
  let executionId = r.json.execution_id;
  if (r.json.held) {
    const decision = fx.approval ?? { decision: 'reject', approver: 'dana', note: 'no scripted approval: reject' };
    let res;
    for (let i = 0; i < 20; i++) { // 409 until the Wait node has parked the execution
      res = await fetch(r.json.approve_url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Approval-Token': env.approvalToken }, body: JSON.stringify(decision) });
      if (res.status !== 409) break;
      await sleep(500);
    }
    row.approval_sent = { ...decision, http: res.status };
  }
  if (executionId) {
    const ex = await waitForExecution(executionId);
    row.execution_status = ex.status;
    row.tokens = await tokens(executionId);
    if (r.json.held) {
      const full = await api(env, 'GET', `/executions/${executionId}?includeData=true`);
      row.final = full.data?.resultData?.runData?.['Summarize run']?.[0]?.data?.main?.[0]?.[0]?.json ?? null;
    } else row.final = r.json;
  }
  const after = await getJson('/_log');
  row.writes = after.slice(before.length).map((l) => ({ app: l.app, method: l.method, path: l.path, body: l.body }));
  results.push(row);
  const f = row.final ?? {};
  console.log(`${fx.lead_id} ${String(r.status).padEnd(3)} ${String(r.ms).padStart(5)}ms  ${(f.disposition ?? r.json.disposition ?? '?').padEnd(7)} ${(f.decision ?? '').padEnd(9)} seg=${f.segment ?? r.json.segment ?? '-'} terr=${f.territory ?? r.json.territory ?? '-'} owner=${f.final_owner?.id ?? '-'} writes=${row.writes.length}`);
}
const audit = await getJson('/hubspot/_audit');
const pricing = await (async () => {
  try { const m = (await (await fetch('https://openrouter.ai/api/v1/models')).json()).data.find((x) => x.id === 'anthropic/claude-haiku-5.5'); return { in: Number(m.pricing.prompt), out: Number(m.pricing.completion) }; } catch { return null; }
})();
const tok = results.reduce((a, r) => ({ in: a.in + (r.tokens?.in ?? 0), out: a.out + (r.tokens?.out ?? 0) }), { in: 0, out: 0 });
const cost = pricing ? tok.in * pricing.in + tok.out * pricing.out : null;
const scored = scoreRun(fixtures, results, audit);
const report = { label, variant: st.variant, ran_at: new Date().toISOString(), leads: fixtures.length, metrics: scored.metrics, failures: scored.failures,
  spend: { input_tokens: tok.in, output_tokens: tok.out, cost_usd: cost, cost_per_lead_usd: cost === null ? null : cost / fixtures.length, pricing_per_token: pricing },
  latency_ms: { p50: pct(results.map((r) => r.ms), 0.5), p95: pct(results.map((r) => r.ms), 0.95) }, per_lead: scored.perLead, raw: results, audit };
function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
mkdirSync(join(HERE, 'results'), { recursive: true });
const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
writeFileSync(join(HERE, 'results', `${label}-${ts}.json`), JSON.stringify(report, null, 2));
writeFileSync(join(HERE, 'results', 'latest.json'), JSON.stringify(report, null, 2));
console.log('\n' + JSON.stringify(report.metrics, null, 2));
for (const f of scored.failures.slice(0, 15)) console.log(`  FAIL ${f.lead_id} ${f.check}: ${f.detail}`);
console.log(`spend: ${tok.in} in / ${tok.out} out tokens = $${cost?.toFixed(4)}  ·  wrote evals/results/${label}-${ts}.json`);
