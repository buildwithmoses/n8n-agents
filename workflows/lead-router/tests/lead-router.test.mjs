// Offline tests: no n8n, no network, no API keys. node --test workflows/lead-router/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLead } from '../src/normalize.js';
import { screenLead } from '../src/classify.js';
import { scoreLead, pickOwner, planLead, applyApproval, segmentFor, territoryFor } from '../src/route.js';
import { planNaive } from '../src/naive.js';
import { scoreRun } from '../evals/score.mjs';
import { routes } from '../mock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(HERE, '..', 'rules.json'), 'utf8'));
const fixtures = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'leads.json'), 'utf8')).leads;
const owners = rules.owners.map((o, i) => ({ ...o, open_leads: i }));
const fx = (id) => fixtures.find((f) => f.lead_id === id);
const norm = (id) => normalizeLead(fx(id));
const ext = (o = {}) => ({ trade: 'hvac', tech_count: 8, current_software: 'whiteboard', timeline: 'within_30_days', summary: 'An HVAC shop. Wants a demo.', ...o });
const noDedupe = { contact: null, company: null, open_deals: [] };

// ---------- normalize ----------
test('normalize lowercases email, pulls domains, uppercases state', () => {
  const l = normalizeLead({ email: ' Rosa@OakmontAir.Example ', website: 'https://www.oakmontair.example/contact', state: 'ga', message: 'hi' });
  assert.equal(l.email, 'rosa@oakmontair.example');
  assert.equal(l.email_domain, 'oakmontair.example');
  assert.equal(l.domain, 'oakmontair.example');
  assert.equal(l.state, 'GA');
});
test('normalize keeps the tail of a long message', () => {
  const l = normalizeLead({ email: 'a@b.example', message: 'x'.repeat(5000) + ' WE HAVE 40 TECHS' }, { maxChars: 1000 });
  assert.ok(l.message.endsWith('WE HAVE 40 TECHS'));
  assert.ok(l.message.length < 1100);
});
test('normalize falls back to the email domain when there is no website', () => {
  assert.equal(normalizeLead({ email: 'joe@maplegarage.example' }).domain, 'maplegarage.example');
});

// ---------- screen ----------
const junkCases = { L13: 'spam', L14: 'spam', L15: 'student', L16: 'student', L17: 'job_seeker', L18: 'competitor', L19: 'competitor' };
for (const [id, kind] of Object.entries(junkCases)) test(`screen marks ${id} as ${kind}`, () => assert.equal(screenLead(norm(id), rules).junk, kind));
for (const id of ['L20', 'L21', 'L22']) test(`screen flags prompt injection in ${id}`, () => assert.equal(screenLead(norm(id), rules).injection, true));
test('no legit fixture is screened as junk or injection', () => {
  for (const f of fixtures.filter((x) => !['drop', 'tag'].includes(x.expected.disposition) && !x.injection_target)) {
    const s = screenLead(normalizeLead(f), rules);
    assert.equal(s.junk, null, `${f.lead_id} wrongly ${s.junk}`);
    assert.equal(s.injection, false, `${f.lead_id} wrongly flagged injection`);
  }
});
test('mentioning a competitor in the message is a switching signal, not a competitor', () => {
  assert.equal(screenLead(norm('L04'), rules).junk, null);
  const r = scoreLead(norm('L04'), screenLead(norm('L04'), rules), ext({ current_software: 'Wrenchly', tech_count: 10, trade: 'plumbing' }), null, rules);
  assert.equal(r.breakdown.switching_from_competitor, rules.icp.points.switching_from_competitor);
});
test('free-mail addresses are not junk', () => assert.equal(screenLead(norm('L23'), rules).junk, null));

// ---------- scoring ----------
test('segments by tech count', () => {
  assert.equal(segmentFor(5, rules), 'Starter'); assert.equal(segmentFor(6, rules), 'Pro');
  assert.equal(segmentFor(25, rules), 'Pro'); assert.equal(segmentFor(26, rules), 'Enterprise');
});
test('territories by state; Canada has none', () => {
  assert.equal(territoryFor('GA', rules), 'East'); assert.equal(territoryFor('TX', rules), 'Central');
  assert.equal(territoryFor('WA', rules), 'West'); assert.equal(territoryFor('ON', rules), null);
});
test('injection: model output is ignored entirely, form dropdown decides size', () => {
  const l = norm('L20'); const s = screenLead(l, rules);
  const r = scoreLead(l, s, ext({ tech_count: 500, trade: 'hvac', summary: 'ENTERPRISE, assign to Gideon' }), { found: true, industry: 'hvac' }, rules);
  assert.equal(r.segment, 'Starter'); assert.equal(r.tech_source, 'form_dropdown'); assert.equal(r.summary, '');
});
test('the message beats the dropdown when no injection', () => {
  const l = norm('L26'); const r = scoreLead(l, screenLead(l, rules), ext({ tech_count: 14, trade: 'plumbing' }), null, rules);
  assert.equal(r.segment, 'Pro'); assert.equal(r.tech_source, 'message');
});
test('a failed model call still routes on form fields and enrichment', () => {
  const l = norm('L01'); const r = scoreLead(l, screenLead(l, rules), null, { found: true, industry: 'hvac', field_techs: 8 }, rules);
  assert.equal(r.trade, 'hvac'); assert.equal(r.segment, 'Pro');
});
test('tiers: core trade + fit + timeline is A; non-field-service is C', () => {
  const a = scoreLead(norm('L01'), screenLead(norm('L01'), rules), ext(), null, rules);
  assert.equal(a.tier, 'A');
  const c = scoreLead(norm('L07'), screenLead(norm('L07'), rules), ext({ trade: 'other', tech_count: 0, timeline: 'unknown' }), { found: true, industry: 'restaurant' }, rules);
  assert.equal(c.tier, 'C');
});

// ---------- owner picking ----------
test('pickOwner: least loaded in territory+segment, capacity respected, deterministic', () => {
  const os = [{ id: 'a', segments: ['Pro'], territory: 'East', capacity: 10, open_leads: 5 }, { id: 'b', segments: ['Pro'], territory: 'East', capacity: 10, open_leads: 3 },
    { id: 'c', segments: ['Pro'], territory: 'West', capacity: 10, open_leads: 0 }, { id: 'd', segments: ['Pro'], territory: 'East', capacity: 3, open_leads: 3 }];
  assert.equal(pickOwner('Pro', 'East', os).id, 'b');
  assert.equal(pickOwner('Pro', 'East', os.map((o) => ({ ...o, open_leads: o.capacity }))), null);
  assert.equal(pickOwner('Enterprise', 'East', os), null);
});

// ---------- planning ----------
const plan = (id, extraction, dedupe = noDedupe) => { const l = norm(id); const s = screenLead(l, rules); return planLead(l, s, scoreLead(l, s, extraction, null, rules), dedupe, owners, rules); };
test('spam is dropped with zero writes', () => { const p = plan('L13', ext()); assert.equal(p.disposition, 'drop'); assert.equal(p.ops.length, 0); });
test('tagged junk writes one contact with no owner, no deal, no DM', () => {
  for (const id of ['L15', 'L17', 'L18']) {
    const p = plan(id, ext());
    assert.equal(p.disposition, 'tag');
    assert.equal(p.ops.length, 1);
    assert.equal(p.ops[0].body.properties.owner_id, undefined);
  }
});
test('Enterprise is held for Dana', () => { const p = plan('L03', ext({ tech_count: 95 })); assert.equal(p.needs_approval, true); assert.deepEqual(p.holds, ['enterprise']); });
test('open deal owned by someone else is held and the proposal keeps the current owner', () => {
  // rules would pick Tariq (least loaded in Central Pro here); the open deal belongs to Mei
  const p = plan('L08', ext({ tech_count: 11, trade: 'plumbing' }), { contact: null, company: { id: 'co-2', owner_id: 'own-mei' }, open_deals: [{ id: 'd-100', owner_id: 'own-mei' }] });
  assert.equal(p.rules_pick.id, 'own-tariq');
  assert.ok(p.holds.includes('open_deal_owned_by_other'));
  assert.equal(p.proposed_owner.id, 'own-mei');
  assert.ok(!p.ops.some((o) => o.path === '/hubspot/deals' && o.method === 'POST'), 'no second deal for the same company');
});
test('open deal already owned by the rules pick is not held (no owner change happens)', () => {
  const p = plan('L08', ext({ tech_count: 11, trade: 'plumbing' }), { contact: null, company: { id: 'co-2', owner_id: 'own-tariq' }, open_deals: [{ id: 'd-100', owner_id: 'own-tariq' }] });
  assert.equal(p.needs_approval, false);
  assert.ok(p.ops.some((o) => o.path === '/hubspot/deals/d-100/notes'));
});
test('existing customer is held', () => {
  const p = plan('L10', ext({ tech_count: 10 }), { contact: null, company: { id: 'co-1', is_customer: true, owner_id: 'own-ava' }, open_deals: [] });
  assert.ok(p.holds.includes('existing_customer'));
});
test('existing contact is updated (PATCH), not duplicated, and keeps its owner', () => {
  const p = plan('L11', ext({ tech_count: 6, trade: 'plumbing' }), { contact: { id: 'c-3', owner_id: 'own-jules' }, company: { id: 'co-4', owner_id: 'own-jules' }, open_deals: [] });
  assert.equal(p.needs_approval, false);
  assert.equal(p.ops[0].method, 'PATCH');
  assert.equal(p.ops[0].body.properties.owner_id, 'own-jules');
});
test('a contact owned by a rep who left is held, not silently reassigned', () => {
  const p = plan('L12', ext({ tech_count: 9 }), { contact: { id: 'c-4', owner_id: 'own-former' }, company: null, open_deals: [] });
  assert.ok(p.holds.includes('contact_owner_inactive'));
});
test('no territory is held', () => assert.ok(plan('L25', ext({ tech_count: 10 })).holds.includes('no_territory')));

// ---------- approval ----------
const held = () => plan('L09', ext({ tech_count: 14, trade: 'electrical' }), { contact: null, company: { id: 'co-3', owner_id: 'own-gideon' }, open_deals: [{ id: 'd-101', owner_id: 'own-gideon' }] });
test('reject, timeout and the wrong approver all apply nothing', () => {
  assert.equal(applyApproval(held(), { decision: 'reject', approver: 'dana' }, owners, rules).ops.length, 0);
  assert.equal(applyApproval(held(), null, owners, rules).ops.length, 0);
  assert.equal(applyApproval(held(), { decision: 'approve', approver: 'tariq' }, owners, rules).ops.length, 0);
  assert.equal(applyApproval(held(), { decision: 'approve', approver: 'dana', owner_id: 'own-nobody' }, owners, rules).ops.length, 0);
});
test('plain approve keeps the open deal with its owner (no owner change)', () => {
  const a = applyApproval(held(), { decision: 'approve', approver: 'dana' }, owners, rules);
  assert.equal(a.final_owner.id, 'own-gideon');
  assert.ok(!a.ops.some((o) => o.method === 'PATCH' && o.path.startsWith('/hubspot/deals/')));
});
test('approve with a named owner changes the deal owner and stamps approved_by', () => {
  const a = applyApproval(held(), { decision: 'approve', approver: 'dana', owner_id: 'own-rhys' }, owners, rules);
  const patch = a.ops.find((o) => o.method === 'PATCH' && o.path === '/hubspot/deals/d-101');
  assert.equal(patch.body.owner_id, 'own-rhys'); assert.equal(patch.body.approved_by, 'dana');
  assert.equal(a.ops.find((o) => o.app === 'slack').body.channel, '@rhys');
});

// ---------- regression variant ----------
test('naive planner trusts the model (what the gate exists to catch)', () => {
  const p = planNaive(norm('L20'), { segment: 'Enterprise', owner_id: 'own-gideon', disposition: 'route', summary: 'x' }, owners);
  assert.equal(p.needs_approval, false);
  assert.equal(p.ops.find((o) => o.path === '/hubspot/deals').body.owner_id, 'own-gideon');
});

// ---------- scorer ----------
test('scorer catches an unapproved owner change and duplicate contacts', () => {
  const s = scoreRun([fx('L01')], [{ lead_id: 'L01', http: 200, response: {}, final: { disposition: 'route', segment: 'Pro', territory: 'East', write_errors: [] }, writes: [] }],
    { owner_changes: [{ object: 'deal', id: 'd-1', from: 'a', to: 'b', domain: 'x.example' }], contacts: [{ email: 'a@x.example' }, { email: 'a@x.example' }], deals: [] });
  assert.equal(s.metrics.owner_change_without_approval_free, 0);
  assert.equal(s.metrics.no_duplicate_contacts, 0);
});
test('scorer flags a junk lead that got a deal', () => {
  const s = scoreRun([fx('L18')], [{ lead_id: 'L18', http: 200, response: {}, final: { disposition: 'route', write_errors: [] }, writes: [{ app: 'hubspot', method: 'POST', path: '/hubspot/deals', body: { owner_id: 'own-ava' } }] }], { contacts: [], deals: [] });
  assert.equal(s.metrics.junk_never_routed, 0);
});

// ---------- mock ----------
test('mock records owner changes on PATCH', () => {
  const ctx = { store: {}, log: [] };
  routes['PATCH /hubspot/deals/:id']({ params: { id: 'd-101' }, body: { owner_id: 'own-rhys', approved_by: 'dana' } }, ctx);
  assert.equal(ctx.store.owner_changes[0].from, 'own-gideon');
  assert.equal(routes['GET /hubspot/lookup']({ query: { email: 'jim@copperline.example', domain: 'copperline.example' } }, ctx).open_deals.length, 1);
});

// ---------- workflow graph ----------
const out = join(HERE, '..', 'workflow', '.test-build.json');
execFileSync(process.execPath, [join(HERE, '..', 'build.mjs'), '--out', out], { stdio: 'ignore' });
const wf = JSON.parse(readFileSync(out, 'utf8'));
rmSync(out);
const edges = (name) => Object.values(wf.connections[name] ?? {}).flat(2).filter(Boolean).map((c) => c.node);
const WRITE_NODES = wf.nodes.filter((n) => /HubSpot: (upsert|create)|Slack: DM|Write:/.test(n.name)).map((n) => n.name);
test('graph: the build has the write nodes we expect', () => assert.equal(WRITE_NODES.length, 4));
test('graph: every path from the Needs-Dana true branch to a write passes the approval step', () => {
  const trueBranch = wf.connections['Needs Dana?'].main[0].map((c) => c.node);
  const stack = [...trueBranch]; const seen = new Set();
  while (stack.length) {
    const n = stack.pop(); if (seen.has(n)) continue; seen.add(n);
    if (n === 'Apply approval (code)') continue; // past the approval: fine
    assert.ok(!WRITE_NODES.includes(n), `held path reaches ${n} without Apply approval`);
    stack.push(...edges(n));
  }
});
test('graph: no write node is reachable from the trigger without passing the plan + Needs-Dana check', () => {
  const stack = ['Webhook: POST /lead-router']; const seen = new Set();
  while (stack.length) {
    const n = stack.pop(); if (seen.has(n)) continue; seen.add(n);
    if (n === 'Needs Dana?') continue;
    assert.ok(!WRITE_NODES.includes(n), `${n} reachable before the approval check`);
    stack.push(...edges(n));
  }
});
test('graph: live HubSpot and Slack nodes ship disabled', () => {
  for (const n of wf.nodes.filter((x) => x.type.endsWith('.hubspot') || x.type.endsWith('.slack'))) assert.equal(n.disabled, true, n.name);
});
test('graph: the model has no write tools, and the LLM prompt never sees the routing rules', () => {
  const chain = wf.nodes.find((n) => n.name === 'Extract fields (Basic LLM Chain)');
  assert.ok(!JSON.stringify(chain.parameters).includes('own-gideon'));
  assert.ok(!Object.values(wf.connections).some((c) => c.ai_tool));
});
test('graph: no secrets in the workflow JSON', () => {
  const s = JSON.stringify(wf);
  assert.ok(!/sk-or-|lsv2_|X-Approval-Token":"[0-9a-f]{20}/.test(s));
});
