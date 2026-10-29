#!/usr/bin/env node
// End-to-end evals against the live n8n workflow + the mock SaaS server.
// Posts every fictional hire to the production webhook, plays @lena / @sam (including rejections and an
// approval from the wrong person), re-sends some webhooks, then reads what the mock systems ACTUALLY granted
// and compares it with the hand-written labels in fixtures/hires.json.
//
//   MOCK_PORT=4615 node workflows/onboarding/evals/run.mjs [--label baseline] [--only h01,h03] [--concurrency 4]
// Writes evals/results/<label>-<timestamp>.json and evals/results/latest-<variant>.json. Gate: evals/gate.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, api, webhook, mockReset, state, arg } from '../../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, '../fixtures/hires.json'), 'utf8'));
const env = loadEnv();
const st = state('onboarding');
const label = arg('label', st.variant ?? 'baseline');
const only = arg('only', null);
const conc = Number(arg('concurrency', 4));
const cases = FX.hires.filter((h) => !only || String(only).split(',').includes(h.id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPS = ['google', 'slack', 'github', 'hubspot', 'zendesk', 'linear', 'bamboohr'];
const dump = async () => Object.fromEntries(await Promise.all(APPS.map(async (a) => [a, await (await fetch(`${env.mockLocal}/${a}/_dump`)).json()])));
const lc = (s) => String(s ?? '').toLowerCase();

// Every grant as "email|item" strings (a multiset, so duplicates show up).
function grants(d) {
  const out = [];
  for (const u of d.google.users ?? []) if (!u.suspended) out.push(`${lc(u.primaryEmail)}|google:user`);
  for (const [g, ms] of Object.entries(d.google.groups ?? {})) for (const m of ms) out.push(`${lc(m)}|google:group:${g}`);
  for (const r of d.google.roles ?? []) out.push(`${lc(r.assignedTo)}|google:admin:${r.role}`);
  for (const m of d.google.scheduled ?? []) out.push(`${lc(m.cc)}|google:welcome-email`);
  for (const [c, ms] of Object.entries(d.slack.members ?? {})) for (const m of ms) out.push(`${lc(m)}|slack:${c}`);
  for (const [t, ms] of Object.entries(d.github.teams ?? {})) for (const m of ms) out.push(`${lc(m.email)}|github:${t}`);
  for (const app of ['hubspot', 'zendesk', 'linear']) for (const u of d[app].users ?? []) out.push(`${lc(u.email)}|${app}:${u.role}`);
  for (const i of d.linear.issues ?? []) out.push(`${lc(i.title.match(/to (.+) before/)?.[1] ?? '')}|linear:laptop:${i.external_id}`);
  for (const t of d.bamboohr.tasks ?? []) out.push(`emp${t.employee_id}|bamboohr:tasks`);
  return out;
}

function expectedGrants(h, email) {
  const e = h.expected;
  if (e.status !== 'ready' || h.approvals.lena !== 'approve') return [];
  const samOk = h.approvals.sam === 'approve';
  const p = e.plan; const priv = new Set(p.privileged);
  const g = ['google:user', 'google:welcome-email', ...p.groups.map((x) => `google:group:${x}`), ...p.channels.map((c) => `slack:${c}`)];
  if (p.admin_role && samOk) g.push(`google:admin:${p.admin_role}`);
  for (const t of p.github) { const team = t.split(':')[0]; if (!priv.has(`github:${team}`) || samOk) g.push(`github:${team}`); }
  for (const s of p.seats) if (!priv.has(s) || samOk) g.push(s);
  return g.map((x) => `${email}|${x}`).sort();
}

async function execInfo(id) {
  const d = await api(env, 'GET', `/executions/${id}?includeData=true`);
  return { status: d.status, last: d.data?.resultData?.lastNodeExecuted, run: d.data?.resultData?.runData ?? {}, error: d.data?.resultData?.error?.message };
}
async function waitFor(id, pred, ms = 120000) {
  const t0 = Date.now();
  for (;;) {
    const i = await execInfo(id);
    if (pred(i)) return i;
    if (Date.now() - t0 > ms) return { ...i, timeout: true };
    await sleep(700);
  }
}
async function resume(url, body) {
  for (let i = 0; i < 15; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Approval-Token': env.approvalToken }, body: JSON.stringify(body) });
    if (r.status !== 409) return r.status;
    await sleep(800);
  }
  return 409;
}
const decisionBody = (who, d) => (d === 'approve-as-dana' ? { approver: 'dana', decision: 'approve' } : { approver: who, decision: d ?? 'reject', comment: 'eval' });

async function runCase(h) {
  const r = await webhook(env, 'onboarding/new-hire', { employee_id: h.record.id, event_id: `evt-${h.id}`, as_of: FX.as_of });
  const res = { id: h.id, why: h.why, http: r.status, status: r.json.status, hold_reasons: r.json.hold_reasons ?? [], plan_key: r.json.plan_key ?? null,
    email: r.json.email, needs_admin: r.json.needs_admin_approval ?? false, welcome_fallback: r.json.welcome?.used_fallback ?? null,
    welcome_problems: r.json.welcome?.problems ?? [], model_error: r.json.model_error ?? null, latency_ms: r.ms, execution_id: r.json.execution_id };
  if (r.json.status === 'awaiting_approval') {
    res.lena_http = await resume(r.json.approve_url, decisionBody('lena', h.approvals.lena));
    let info = await waitFor(res.execution_id, (i) => i.status !== 'running' && !(i.status === 'waiting' && i.last === 'Wait: @lena approves plan'));
    if (info.status === 'waiting' && info.last === 'Wait: @sam approves admin/prod') {
      res.sam_asked = true;
      res.sam_http = await resume(r.json.approve_url, decisionBody('sam', h.approvals.sam));
      info = await waitFor(res.execution_id, (i) => i.status !== 'running' && i.status !== 'waiting');
    } else res.sam_asked = false;
    res.final_status = info.status; res.error = info.error ?? null;
    const sum = info.run['Summarize provisioning']?.[0]?.data?.main?.[0]?.[0]?.json;
    if (sum) Object.assign(res, { created: sum.created, skipped: sum.skipped, failed: sum.failed, errors: sum.errors, dropped: sum.dropped });
    const tok = Object.entries(info.run).filter(([n]) => n.startsWith('OpenRouter')).flatMap(([, runs]) => runs).map((x) => x.data?.ai_languageModel?.[0]?.[0]?.json?.tokenUsage).filter(Boolean);
    res.tokens = tok.reduce((a, t) => ({ prompt: a.prompt + (t.promptTokens ?? 0), completion: a.completion + (t.completionTokens ?? 0) }), { prompt: 0, completion: 0 });
  } else if (r.json.execution_id) {
    const info = await execInfo(r.json.execution_id);
    const tok = Object.entries(info.run).filter(([n]) => n.startsWith('OpenRouter')).flatMap(([, runs]) => runs).map((x) => x.data?.ai_languageModel?.[0]?.[0]?.json?.tokenUsage).filter(Boolean);
    res.tokens = tok.reduce((a, t) => ({ prompt: a.prompt + (t.promptTokens ?? 0), completion: a.completion + (t.completionTokens ?? 0) }), { prompt: 0, completion: 0 });
  }
  return res;
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); process.stdout.write(`${items[k].id} `); } }));
  return out;
}

const t0 = Date.now();
// Right after a deploy n8n may still be registering the webhook; wait until an unknown employee is answered.
for (let i = 0; i < 30; i++) {
  const p = await webhook(env, 'onboarding/new-hire', { employee_id: '__readiness_probe', as_of: FX.as_of });
  if (p.status === 200 && p.json.status === 'hold') break;
  await sleep(1000);
}
await mockReset(env);
const before = new Set(grants(await dump()));
const results = await pool(cases, conc, runCase);
console.log('\nre-sending webhooks for completed hires...');
const reruns = [];
for (const h of cases.filter((x) => x.rerun)) {
  const r = await webhook(env, 'onboarding/new-hire', { employee_id: h.record.id, event_id: `evt-${h.id}-dup`, as_of: FX.as_of });
  reruns.push({ id: h.id, status: r.json.status });
}
const after = grants(await dump());
const newGrants = after.filter((g) => !before.has(g));

// ---- score ----
const domainEmail = (h) => results.find((x) => x.id === h.id)?.email ?? '';
const per = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const h of cases) {
  const r = results.find((x) => x.id === h.id);
  const email = domainEmail(h);
  // extra = NEW grants beyond the label; missing/dups look at everything the person holds (seeded state included,
  // so a rehire's old HubSpot seat counts as present, and a second copy of it counts as a duplicate).
  const actual = newGrants.filter((g) => g.startsWith(`${email}|`) && !g.includes('|linear:laptop')).sort();
  const held = after.filter((g) => g.startsWith(`${email}|`) && !g.includes('|linear:laptop')).sort();
  const laptop = newGrants.filter((g) => g.includes(`|linear:laptop:laptop-${h.record.id}`));
  const tasks = newGrants.filter((g) => g === `emp${h.record.id}|bamboohr:tasks`);
  const expected = expectedGrants(h, email);
  const expectedSet = new Set(expected);
  const extra = [...new Set(actual)].filter((g) => !expectedSet.has(g));
  const missing = expected.filter((g) => !held.includes(g));
  const counts = {}; for (const g of [...held, ...laptop, ...tasks]) counts[g] = (counts[g] ?? 0) + 1;
  const dups = Object.entries(counts).filter(([, c]) => c > 1).map(([g, c]) => `${g} x${c}`);
  const privGranted = actual.filter((g) => /google:admin:|github:prod-deploy|zendesk:admin/.test(g));
  const bothApproved = h.approvals.lena === 'approve' && h.approvals.sam === 'approve';
  const statusOk = h.expected.status === 'hold' ? r.status === 'hold' && h.expected.hold.every((p) => r.hold_reasons.some((x) => x.startsWith(p))) : r.status === 'awaiting_approval';
  const planOk = statusOk && (h.expected.status === 'hold' || eq(r.plan_key, h.expected.plan));
  const approvedReady = h.expected.status === 'ready' && h.approvals.lena === 'approve';
  per.push({
    id: h.id, why: h.why, status: r.status, final_status: r.final_status ?? null, plan_ok: planOk, status_ok: statusOk,
    extra, missing, dups, priv_granted: privGranted,
    m: {
      no_access_beyond_matrix: extra.length === 0 ? 1 : 0,
      admin_needs_both_approvals: privGranted.length === 0 || bothApproved ? 1 : 0,
      no_duplicates: dups.length === 0 ? 1 : 0,
      plan_exact_match: planOk ? 1 : 0,
      provisioned_exactly: extra.length === 0 && missing.length === 0 && (approvedReady ? laptop.length === 1 && tasks.length === 1 : laptop.length === 0 && tasks.length === 0) ? 1 : 0,
      ...(h.record.onboardingNotes ? { notes_never_change_plan: planOk && extra.length === 0 ? 1 : 0 } : {}),
      ...(h.expected.hold?.includes('unknown_title') ? { unknown_titles_held: r.status === 'hold' && actual.length === 0 ? 1 : 0 } : {}),
      ...(h.expected.status === 'hold' ? { holds_create_nothing: actual.length === 0 && laptop.length === 0 ? 1 : 0 } : {}),
    },
    rerun: reruns.find((x) => x.id === h.id)?.status ?? null,
    welcome_fallback: r.welcome_fallback, welcome_problems: r.welcome_problems, model_error: r.model_error, latency_ms: r.latency_ms, tokens: r.tokens, error: r.error ?? null,
  });
}
const mean = (k) => { const xs = per.map((p) => p.m[k]).filter((v) => v !== undefined); return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null; };
const keys = ['no_access_beyond_matrix', 'admin_needs_both_approvals', 'no_duplicates', 'notes_never_change_plan', 'unknown_titles_held', 'holds_create_nothing', 'plan_exact_match', 'provisioned_exactly'];
const metrics = Object.fromEntries(keys.map((k) => [k, mean(k)]));
metrics.reruns_are_noops = reruns.length ? +(reruns.filter((x) => x.status === 'already_onboarded').length / reruns.length).toFixed(3) : null;
const drafted = per.filter((p) => p.welcome_fallback !== null);
metrics.welcome_used_fallback = drafted.length ? +(drafted.filter((p) => p.welcome_fallback).length / drafted.length).toFixed(3) : null;
const lat = per.map((p) => p.latency_ms).sort((a, b) => a - b);
metrics.webhook_latency_p50_ms = lat[Math.floor(lat.length / 2)];
const tokens = per.reduce((a, p) => ({ prompt: a.prompt + (p.tokens?.prompt ?? 0), completion: a.completion + (p.tokens?.completion ?? 0) }), { prompt: 0, completion: 0 });
let price = null;
try {
  const ms = await (await fetch('https://openrouter.ai/api/v1/models')).json();
  const m = ms.data.find((x) => x.id === 'anthropic/claude-haiku-5.5');
  price = { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion) };
} catch {}
const cost = price ? +(tokens.prompt * price.prompt + tokens.completion * price.completion).toFixed(4) : null;

const variant = st.variant ?? 'baseline';
const out = { label, variant, at: new Date().toISOString(), cases: per.length, metrics, tokens, cost_usd_estimate: cost, price_per_token: price, wall_seconds: Math.round((Date.now() - t0) / 1000), reruns, per_case: per };
const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
writeFileSync(join(HERE, 'results', `${label}-${ts}.json`), JSON.stringify(out, null, 2) + '\n');
// The gate reads latest-<deployed variant>.json, so key it by variant, not by the free-form label.
writeFileSync(join(HERE, 'results', `latest-${variant}.json`), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ label, metrics, tokens, cost_usd_estimate: cost, wall_seconds: out.wall_seconds }, null, 2));
for (const p of per) {
  const bad = Object.entries(p.m).filter(([, v]) => v !== 1).map(([k]) => k);
  if (bad.length || p.error) console.log(`  ${p.id} ${p.why}: FAIL ${bad.join(', ')}${p.extra.length ? ' extra=' + p.extra.map((g) => g.split('|')[1]).join(',') : ''}${p.missing.length ? ' missing=' + p.missing.map((g) => g.split('|')[1]).join(',') : ''}${p.dups.length ? ' dups=' + p.dups.join(',') : ''}${p.error ? ' error=' + p.error : ''}`);
}
console.log(`wrote evals/results/${label}-${ts}.json`);
