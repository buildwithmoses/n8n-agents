#!/usr/bin/env node
// End-to-end evals for the weekly ops report, against the live n8n workflow and the mock SaaS server.
// For each labeled week in fixtures/weeks.json: trigger the webhook, take the scripted approval action
// (approve / reject / wrong approver / no token), wait for the execution to finish, then read the mock
// Slack log and score. Truth comes from the hand-set numbers in fixtures/weeks.json, not from the workflow.
//
//   node workflows/ops-report/evals/run.mjs --label baseline
//   node workflows/ops-report/evals/run.mjs --label naive --no-judge
//   node workflows/ops-report/evals/run.mjs --weeks 2026-W41,2026-W42
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, api, webhook, mockReset, mockLog, state, arg } from '../../../lib/n8n.mjs';
import { judge } from './judge.mjs';
import { truthMetrics, scoreScenario, aggregate } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, '../fixtures/weeks.json'), 'utf8'));
const env = loadEnv();
const label = arg('label', 'candidate');
const weeksArg = arg('weeks', null);
const useJudge = !process.argv.includes('--no-judge');
const st = state('ops-report');
const scenarios = FX.scenarios.filter((s) => !weeksArg || String(weeksArg).split(',').includes(s.week));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function haikuPricing() {
  for (let i = 0; i < 3; i++) {
    const p = await fetch('https://openrouter.ai/api/v1/models').then((r) => r.json()).then((j) => j.data.find((m) => m.id === 'anthropic/claude-haiku-5.5')?.pricing).catch(() => null);
    if (p) return p;
    await sleep(1000);
  }
  console.warn('warning: could not fetch OpenRouter pricing; model cost will be recorded as null');
  return null;
}
const pricing = await haikuPricing();
const tokenCost = (u) => (pricing ? u.prompt * Number(pricing.prompt) + u.completion * Number(pricing.completion) : null);

function tokenUsage(execData) {
  const u = { prompt: 0, completion: 0, calls: 0 };
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (x.tokenUsage && typeof x.tokenUsage === 'object') { u.prompt += x.tokenUsage.promptTokens ?? 0; u.completion += x.tokenUsage.completionTokens ?? 0; u.calls++; return; }
    for (const v of Object.values(x)) walk(v);
  };
  walk(execData?.data?.resultData?.runData);
  return u;
}

async function waitDone(id, want = ['success', 'error', 'crashed', 'canceled'], timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const e = await api(env, 'GET', `/executions/${id}?includeData=true`).catch(() => null);
    if (e && want.includes(e.status)) return e;
    await sleep(1000);
  }
  return api(env, 'GET', `/executions/${id}?includeData=true`);
}

async function resume(url, body, withToken = true) {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(withToken ? { 'X-Approval-Token': env.approvalToken } : {}) }, body: JSON.stringify(body) });
    if (res.status !== 404 && res.status !== 409) return res.status;
    await sleep(500); // the execution may not have reached the Wait node yet
  }
  return 404;
}

await mockReset(env, 'slack');
console.log(`ops-report evals: ${scenarios.length} weeks, variant=${st.variant ?? '?'}, judge=${useJudge}`);
const rows = [];
for (const sc of scenarios) {
  const t0 = Date.now();
  const r = await webhook(env, 'ops-report', { week: sc.week });
  const out = r.json;
  const row = { week: sc.week, label: sc.label, http: r.status, latency_s: +(r.ms / 1000).toFixed(1) };
  if (r.status !== 200 || !out.report) { row.error = `webhook ${r.status}: ${JSON.stringify(out).slice(0, 200)}`; rows.push(row); console.log(`  ${sc.week} ERROR ${row.error}`); continue; }
  const a = sc.approval;
  if (a.action === 'approve_without_token') {
    row.unauth_resume_status = await resume(out.approve_url, { approved: true, approver: a.approver }, false);
    row.cleanup_status = await resume(out.approve_url, { approved: false, approver: 'owen', note: 'eval cleanup after the unauthenticated attempt' });
  } else {
    row.resume_status = await resume(out.approve_url, { approved: a.action === 'approve', approver: a.approver });
  }
  const exec = await waitDone(out.execution_id);
  row.exec_status = exec.status;
  row.decision = exec.data?.resultData?.runData?.['Apply approval decision']?.[0]?.data?.main?.[0]?.[0]?.json?.reason ?? null;
  const usage = tokenUsage(exec);
  row.model_calls = usage.calls; row.model_tokens = usage.prompt + usage.completion; row.model_cost_usd = pricing ? +tokenCost(usage).toFixed(5) : null;
  row.total_s = +((Date.now() - t0) / 1000).toFixed(1);
  const posts = (await mockLog(env, 'slack')).filter((l) => String(l.body?.text ?? '').includes(sc.week));
  const scored = scoreScenario(sc, out, posts, truthMetrics(FX, sc.week));
  Object.assign(row, scored);
  if (useJudge) {
    const { customer_voice, ...trusted } = out.report;
    const j = await judge(JSON.stringify(trusted), out.narrative, (customer_voice ?? []).map((v) => `- [${v.priority}] ${v.subject}: ${v.excerpt}`).join('\n') || '(none)');
    row.judge = +(j.score ?? 0).toFixed(3); row.judge_reason = j.reason; row.judge_cost_usd = j.cost ?? 0;
  }
  rows.push(row);
  console.log(`  ${sc.week} ${sc.label.padEnd(38)} mode=${out.mode.padEnd(14)} metrics=${row.metric_accuracy} numbers=${row.number_accuracy} posted=${row.posted_all_hands}/${sc.expect_post} anomalies=${row.anomaly_recall}` +
    `${row.missing_reported !== undefined ? ` missing=${row.missing_reported}` : ''}${row.injection_resisted !== undefined ? ` injection=${row.injection_resisted}` : ''}${useJudge ? ` judge=${row.judge}` : ''} ${row.total_s}s`);
  for (const p of row.problems ?? []) console.log(`      - ${p}`);
}

const summary = aggregate(rows);
const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const result = { label, variant: st.variant ?? null, workflow_id: st.workflowId, ran_at: new Date().toISOString(), judge_model: useJudge ? (process.env.OPS_JUDGE_MODEL ?? 'openai/gpt-6.1-terra') : null, summary, rows };
mkdirSync(join(HERE, 'results'), { recursive: true });
writeFileSync(join(HERE, 'results', `${label}-${ts}.json`), JSON.stringify(result, null, 2) + '\n');
writeFileSync(join(HERE, 'results', 'latest.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote evals/results/${label}-${ts}.json and latest.json`);
