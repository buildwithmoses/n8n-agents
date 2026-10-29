// Offline tests for the Code-node bodies. No n8n, no network, no API key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHire, emailLocalPart } from '../src/normalize.js';
import { buildPlan, planKey } from '../src/plan.js';
import { parseDecision, finalize } from '../src/approval.js';
import { checkWelcome, modelInput } from '../src/welcome.js';
import { buildCalls, keepMissing, summarize } from '../src/provision.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, '../fixtures/hires.json'), 'utf8'));
const MATRIX = JSON.parse(readFileSync(join(HERE, '../matrix/access-matrix.json'), 'utf8'));
const existingFor = (email) => {
  const u = FX.seed.google_users.find((x) => x.primaryEmail === email);
  return u ? { exists: true, suspended: u.suspended, employee_id: u.employeeId } : { exists: false };
};
const planFor = (h) => { const hire = normalizeHire(h.record, MATRIX.domain); return buildPlan(hire, existingFor(hire.email), MATRIX, FX.as_of); };

for (const h of FX.hires) {
  test(`${h.id} ${h.why}: plan matches the label`, () => {
    const r = planFor(h);
    assert.equal(r.status, h.expected.status, JSON.stringify(r.hold_reasons));
    if (h.expected.status === 'hold') for (const p of h.expected.hold) assert.ok(r.hold_reasons.some((x) => x.startsWith(p)), `${p} in ${r.hold_reasons}`);
    else assert.deepEqual(planKey(r.plan), h.expected.plan);
  });
}

test('manager notes are carried to the approver but never change the plan', () => {
  const h = FX.hires.find((x) => x.id === 'h02');
  const a = planFor(h), b = planFor({ ...h, record: { ...h.record, onboardingNotes: '' } });
  assert.deepEqual(a.plan, b.plan);
  assert.match(a.notes_for_approver, /admin on prod/);
});

test('every planned group, channel, team and seat exists in the matrix for that role', () => {
  for (const h of FX.hires) {
    const r = planFor(h); if (r.status !== 'ready') continue;
    const role = MATRIX.roles[r.plan.title];
    const okGroups = new Set([...MATRIX.baseline.google_groups, ...MATRIX.employee_only.google_groups, ...MATRIX.contractor.google_groups, ...role.google_groups]);
    const okCh = new Set([...MATRIX.baseline.slack_channels, ...MATRIX.employee_only.slack_channels, ...role.slack_channels]);
    for (const g of r.plan.google.groups) assert.ok(okGroups.has(g), `${h.id} ${g}`);
    for (const c of r.plan.slack.channels) assert.ok(okCh.has(c), `${h.id} ${c}`);
    for (const t of r.plan.github.teams) assert.ok(role.github_teams.some((x) => x.team === t.team), `${h.id} ${t.team}`);
    if (r.plan.employment_type === 'contractor') for (const g of r.plan.google.groups) assert.ok(!MATRIX.restricted_groups.includes(g), `${h.id} contractor got ${g}`);
  }
});

test('email derivation strips accents and punctuation', () => {
  assert.equal(emailLocalPart('Lucía', 'Fernández'), 'lucia.fernandez');
  assert.equal(emailLocalPart("D'Arcy", 'O-Neil'), 'darcy.oneil');
});

test('re-sending the webhook after onboarding is a no-op', () => {
  const h = FX.hires.find((x) => x.id === 'h01');
  const hire = normalizeHire(h.record, MATRIX.domain);
  const r = buildPlan(hire, { exists: true, suspended: false, employee_id: '4101' }, MATRIX, FX.as_of);
  assert.equal(r.status, 'already_onboarded');
});

test('decisions fail safe', () => {
  assert.equal(parseDecision(undefined, 'lena').approved, false);
  assert.equal(parseDecision({ json: {} }, 'lena').approved, false);
  assert.equal(parseDecision({ body: { approver: 'dana', decision: 'approve' } }, 'lena').approved, false);
  assert.equal(parseDecision({ body: { approver: '@Lena', decision: 'approve' } }, 'lena').approved, true);
  assert.equal(parseDecision({ body: { approver: 'lena', decision: 'yes please' } }, 'lena').approved, false);
});

test('privileged access needs @sam; without him it is stripped and everything else proceeds', () => {
  const plan = planFor(FX.hires.find((x) => x.id === 'h03')).plan;
  const yes = { approved: true }, no = { approved: false, reason: 'rejected' };
  assert.equal(finalize(plan, no, yes).proceed, false);
  assert.deepEqual(finalize(plan, yes, yes).plan.privileged, ['github:prod-deploy']);
  const f = finalize(plan, yes, no);
  assert.equal(f.proceed, true);
  assert.deepEqual(f.dropped, ['github:prod-deploy']);
  assert.ok(!f.plan.github.teams.some((t) => t.team === 'prod-deploy'));
  assert.ok(f.plan.github.teams.some((t) => t.team === 'engineers'));
  const admin = planFor(FX.hires.find((x) => x.id === 'h05')).plan;
  assert.equal(finalize(admin, yes, no).plan.google.admin_role, null);
});

test('welcome check rejects promised access, extra channels and pay talk; model never sees notes', () => {
  const plan = planFor(FX.hires.find((x) => x.id === 'h20')).plan;
  assert.ok(!JSON.stringify(modelInput(plan)).includes('IGNORE'));
  const good = { welcome_message: 'Welcome Kenji! Say hi in #sales.', first_week_plan: ['a', 'b', 'c'] };
  assert.equal(checkWelcome(plan, good).used_fallback, false);
  for (const bad of ['You have admin access.', 'Join us in #exec.', 'Your $5,000 bonus is on the way.', ''])
    assert.equal(checkWelcome(plan, { ...good, welcome_message: bad }).used_fallback, true, bad);
  assert.equal(checkWelcome(plan, null).used_fallback, true);
});

test('check-then-create: existing things are skipped, failed checks create nothing', () => {
  const plan = planFor(FX.hires.find((x) => x.id === 'h14')).plan;
  const calls = buildCalls(plan, { tasks: ['x'], welcome: 'hi', personal_email: 'r@mail.example' });
  const checks = calls.map((c) => (c.key === 'google:user' ? { exists: true, suspended: true } : c.key.startsWith('hubspot') ? { exists: true } : { exists: false }));
  checks[checks.length - 1] = { error: 'boom' };
  const k = keepMissing(calls, checks);
  assert.ok(k.todo.some((c) => c.key === 'google:user' && c.method === 'PATCH'));
  assert.ok(k.skipped.includes('hubspot:marketing-hub'));
  assert.equal(k.failed.length, 1);
  const again = keepMissing(calls, calls.map(() => ({ exists: true, suspended: false })));
  assert.equal(again.todo.length, 0);
  assert.deepEqual(summarize([calls[0]], [{ statusCode: 409 }]).errors, ['google:user (HTTP 409)']);
});
