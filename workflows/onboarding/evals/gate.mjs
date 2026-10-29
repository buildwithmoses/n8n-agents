#!/usr/bin/env node
// Blocks a change if any hard floor is missed. Exit 1 = do not ship.
//   node workflows/onboarding/evals/gate.mjs [results.json]     (default: evals/results/latest-<variant>.json)
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { state } from '../../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] ?? join(HERE, 'results', `latest-${state('onboarding').variant ?? 'baseline'}.json`);
if (!existsSync(path)) { console.error(`no results at ${path}; run evals/run.mjs first`); process.exit(2); }
const r = JSON.parse(readFileSync(path, 'utf8'));
const base = JSON.parse(readFileSync(join(HERE, 'baseline.json'), 'utf8'));

// Hard floors: access and approvals are decided by code, so anything under 1.0 is a bug, not noise.
const FLOORS = {
  no_access_beyond_matrix: 1.0,
  admin_needs_both_approvals: 1.0,
  no_duplicates: 1.0,
  reruns_are_noops: 1.0,
  notes_never_change_plan: 1.0,
  unknown_titles_held: 1.0,
  holds_create_nothing: 1.0,
  plan_exact_match: 1.0,
  provisioned_exactly: 1.0,
};
const fails = [];
console.log(`${r.label}: ${r.cases} hires, ${r.wall_seconds}s, est. $${r.cost_usd_estimate}`);
for (const [k, floor] of Object.entries(FLOORS)) {
  const v = r.metrics[k];
  const ok = v !== null && v !== undefined && v >= floor;
  if (!ok) fails.push(`${k}: ${v} < floor ${floor}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k.padEnd(28)} ${String(v).padEnd(6)} (floor ${floor}, baseline ${base.metrics[k]})`);
}
for (const k of ['welcome_used_fallback', 'webhook_latency_p50_ms']) console.log(`  info ${k.padEnd(28)} ${r.metrics[k]} (baseline ${base.metrics[k]})`);
if (fails.length) {
  console.log(`GATE FAILED - ${r.label} - do not ship this change`);
  for (const f of fails) console.log(` - ${f}`);
  for (const p of r.per_case.filter((p) => Object.values(p.m).some((v) => v !== 1)).slice(0, 10))
    console.log(`   ${p.id} (${p.why}):${p.extra.length ? ' extra ' + p.extra.map((g) => g.split('|')[1]).join(', ') : ''}${p.missing.length ? ' missing ' + p.missing.map((g) => g.split('|')[1]).join(', ') : ''}${p.status_ok ? '' : ' status ' + p.status}`);
  process.exit(1);
}
console.log(`GATE PASSED - ${r.label}`);
