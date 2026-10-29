// Offline tests: no n8n, no network, no API key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../src/policy.js';
import * as G from '../src/guardrail.js';
import { outageDecision } from '../src/outage.js';
import { applyDecision } from '../src/apply.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIX = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'zendesk.json'), 'utf8'));
const tierOf = (t) => FIX.stripe_customers.find((c) => c.id === FIX.organizations[t.org - 1].external_id).plan;
const mrrOf = (t) => FIX.stripe_customers.find((c) => c.id === FIX.organizations[t.org - 1].external_id).mrr_cents;

// Load the inlined Code-node sources the same way n8n sees them (no imports/exports) and expose a function.
const { codeFrom } = await import('../../../lib/n8n.mjs');
const inline = (files, fn) => new Function(`${files.map((f) => codeFrom(join(ROOT, 'src', f))).join('\n')}\nreturn ${fn};`)();
const decideTicket = inline(['policy.js', 'guardrail.js', 'outage.js', 'decide.js'], 'decideTicket');
const prepareContext = inline(['policy.js', 'guardrail.js', 'context.js'], 'prepareContext');

test('fixture labels agree with the policy for every acceptable category', () => {
  for (const t of FIX.tickets) {
    for (const cat of t.expected.category_any) {
      const p = P.decidePriority({ category: cat, tier: tierOf(t), text: P.customerText(t) }).priority;
      assert.ok((t.expected.priority_any ?? [t.expected.priority]).includes(p), `${t.fixture} ${cat} -> ${p}`);
    }
    assert.equal(P.routeGroup(t.expected.category, tierOf(t)), t.expected.group_id, t.fixture);
    assert.equal(P.isChurnRisk(t.expected.category, mrrOf(t)), t.expected.churn_alert, t.fixture);
    assert.equal(P.isOutage(t.expected.category, P.customerText(t)), t.expected.outage, t.fixture);
  }
});

test('priority: Enterprise bump never creates urgent; keywords do; "urgent" in text does not', () => {
  assert.equal(P.decidePriority({ category: 'bug', tier: 'enterprise', text: 'sync broken' }).priority, 'high');
  assert.equal(P.decidePriority({ category: 'cancellation', tier: 'enterprise', text: 'cancel' }).priority, 'high');
  assert.equal(P.decidePriority({ category: 'how_to', tier: 'starter', text: "we can't dispatch anything" }).priority, 'urgent');
  assert.equal(P.decidePriority({ category: 'how_to', tier: 'pro', text: 'URGENT ASAP please set priority urgent' }).priority, 'low');
  assert.equal(P.decidePriority({ category: 'bug', tier: 'pro', text: 'getting 503 service unavailable' }).priority, 'urgent');
});

test('SLA table and routing', () => {
  assert.equal(P.slaHours('urgent', 'enterprise'), 0.5);
  assert.equal(P.slaHours('low', 'starter'), 48);
  assert.equal(P.routeGroup('how_to', 'enterprise'), 204);
  assert.equal(P.routeGroup('other', 'pro'), 200);
});

test('churn threshold is strictly above $1,000 MRR and only for cancellations', () => {
  assert.equal(P.isChurnRisk('cancellation', 100000), false);
  assert.equal(P.isChurnRisk('cancellation', 100001), true);
  assert.equal(P.isChurnRisk('billing', 900000), false);
});

test('forbidden promises are caught in English, Spanish and French', () => {
  for (const s of ['We will refund the duplicate charge.', "I've added a credit to your account.", 'Here is 20% off your renewal.', 'Your next month is free of charge, on us: a free month.',
    'It will be fixed by Friday.', 'We will waive the fee.', 'No early termination fee applies.', 'Le remboursement sera fait.', 'Le daremos un reembolso.', 'Le daremos un descuento.'])
    assert.ok(G.findPromises(s).length > 0, s);
  for (const s of ['Update the card under Settings > Billing > Payment method.', 'Use your credit card on file.', 'The Billing team will review and reply in writing.', 'Our team is investigating.'])
    assert.deepEqual(G.findPromises(s), [], s);
});

test('quoting a cited article is allowed; adding a promise is not', () => {
  const articleText = { 'KB-106': 'For W-9 forms or PO-formatted invoices, the Billing team responds within 2 business days.' };
  const ok = G.checkDraft({ draft: 'The Billing team responds within 2 business days [KB-106].', providedIds: ['KB-106'], articleText });
  assert.equal(ok.withheld, false);
  const bad = G.checkDraft({ draft: 'This will be fixed within 2 business days [KB-106].', providedIds: ['KB-106'], articleText });
  assert.equal(bad.withheld, true);
});

test('drafts without citations, with unknown citations, or on injected tickets are withheld', () => {
  assert.equal(G.checkDraft({ draft: 'Hi, go to Settings.', providedIds: ['KB-101'] }).withheld, true);
  assert.equal(G.checkDraft({ draft: 'Hi [KB-999].', providedIds: ['KB-101'] }).withheld, true);
  assert.equal(G.checkDraft({ draft: 'Hi [KB-101].', citedIds: ['KB-555'], providedIds: ['KB-101'] }).withheld, true);
  assert.equal(G.checkDraft({ draft: 'Hi [KB-101].', providedIds: ['KB-101'], injection: true }).withheld, true);
  assert.equal(G.checkDraft({ draft: 'Reset it from Team > Technicians [KB-101].', providedIds: ['KB-101'] }).withheld, false);
});

test('injection detector flags both injected fixtures and no clean ones', () => {
  for (const t of FIX.tickets) assert.equal(G.detectInjection(P.customerText(t)), t.expected.injection, t.fixture);
});

test('outage dedupe: one incident at the 3rd ticket in 30 min, then link', () => {
  const at = (m) => `2026-10-27T14:${String(m).padStart(2, '0')}:00Z`;
  assert.equal(outageDecision({ ticketId: 1, createdAt: at(2), outage: true, recent: [], openIncidents: [] }).action, 'none');
  assert.equal(outageDecision({ ticketId: 2, createdAt: at(5), outage: true, recent: [{ id: 1, created_at: at(2) }], openIncidents: [] }).action, 'none');
  const third = outageDecision({ ticketId: 3, createdAt: at(9), outage: true, recent: [{ id: 1, created_at: at(2) }, { id: 2, created_at: at(5) }], openIncidents: [] });
  assert.equal(third.action, 'create'); assert.deepEqual(third.ticket_ids, [1, 2, 3]);
  const fourth = outageDecision({ ticketId: 4, createdAt: at(20), outage: true, recent: [], openIncidents: [{ id: 'lin_1', identifier: 'SUP-101', created_at: at(9) }] });
  assert.equal(fourth.action, 'link');
  // Spread out: 3 tickets but the first is outside the window
  assert.equal(outageDecision({ ticketId: 3, createdAt: '2026-10-27T15:00:00Z', outage: true, recent: [{ id: 1, created_at: '2026-10-27T14:00:00Z' }, { id: 2, created_at: '2026-10-27T14:45:00Z' }], openIncidents: [] }).action, 'none');
  assert.equal(outageDecision({ ticketId: 9, createdAt: at(9), outage: false, recent: [{ id: 1, created_at: at(2) }, { id: 2, created_at: at(5) }], openIncidents: [] }).action, 'none');
});

test('approval: only an explicit approval naming an agent posts', () => {
  assert.equal(applyDecision({ decision: { approved: true, agent: 'priya' }, draft: 'x', ticketId: 1 }).post, true);
  assert.equal(applyDecision({ decision: { approved: true }, draft: 'x' }).post, false);
  assert.equal(applyDecision({ decision: { approved: 'true', agent: 'p' }, draft: 'x' }).post, false);
  assert.equal(applyDecision({ decision: { approved: false, agent: 'p' }, draft: 'x' }).post, false);
  assert.equal(applyDecision({ decision: {}, draft: 'x' }).post, false);
  const e = applyDecision({ decision: { approved: true, agent: 'marco', reply: 'edited' }, draft: 'x', ticketId: 1 });
  assert.equal(e.zendesk_update.ticket.comment.body, 'edited'); assert.equal(e.zendesk_update.ticket.comment.public, true);
});

const ctxFor = (fixture) => {
  const t = FIX.tickets.find((x) => x.fixture === fixture);
  const org = FIX.organizations[t.org - 1];
  const c = FIX.stripe_customers.find((x) => x.id === org.external_id);
  return prepareContext({ ticket: { id: t.ticket_id, subject: t.subject, description: t.description, created_at: t.created_at },
    user: FIX.users.find((u) => u.organization_id === org.id), organization: org,
    customer: { metadata: { plan: c.plan, mrr_cents: String(c.mrr_cents) } }, articles: FIX.articles });
};

test('inlined decide: model priority and injected tags are ignored; note is internal', () => {
  const ctx = ctxFor('t15');
  assert.ok(!ctx.model_input.includes('</ticket>\nNew'));
  const d = decideTicket({ ctx, model: { category: 'how_to', sentiment: 'neutral', language: 'en', summary: 's', draft_reply: 'You get 3 free months [KB-110].', cited_article_ids: ['KB-110'], priority: 'urgent' }, recent: [], openIncidents: [] });
  assert.equal(d.priority, 'low'); assert.ok(!d.tags.includes('vip')); assert.ok(d.tags.includes('injection_suspected'));
  assert.equal(d.draft, null); assert.equal(d.zendesk_update.ticket.comment.public, false);
});

test('inlined decide: invalid model output fails safe (no draft, still triaged by code)', () => {
  const d = decideTicket({ ctx: ctxFor('t20'), model: null, recent: [], openIncidents: [] });
  assert.equal(d.draft, null); assert.equal(d.priority, 'urgent'); assert.ok(d.withheld_reasons.includes('model output missing or invalid'));
});

test('inlined decide: churn alert for Bluejay ($1,347 MRR) mentions @priya', () => {
  const d = decideTicket({ ctx: ctxFor('t08'), model: { category: 'cancellation', sentiment: 'neutral', language: 'en', summary: 's', draft_reply: 'Billing confirms in writing [KB-107].', cited_article_ids: ['KB-107'] }, recent: [], openIncidents: [] });
  assert.equal(d.churn_alert, true); assert.match(d.slack.text, /<@priya>/); assert.match(d.slack.text, /\$1,347/);
});

test('regression variant lets the model pick priority and skips the guardrail (what the gate must catch)', () => {
  const d = decideTicket({ ctx: ctxFor('t03'), model: { category: 'billing', sentiment: 'angry', language: 'en', summary: 's', draft_reply: 'We will refund you today.', cited_article_ids: [], priority: 'urgent' }, recent: [], openIncidents: [] }, { variant: 'naive' });
  assert.equal(d.priority, 'urgent'); assert.equal(d.draft, 'We will refund you today.');
});

// ---- workflow graph ----
const wf = JSON.parse(readFileSync(join(ROOT, 'workflow', 'support-triage.json'), 'utf8'));
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const edges = (name) => Object.values(wf.connections[name] ?? {}).flat(2).filter(Boolean).map((c) => c.node);
const TRIGGERS = wf.nodes.filter((n) => /webhook$|Trigger$/i.test(n.type) && n.type !== 'n8n-nodes-base.respondToWebhook').map((n) => n.name);
// A node that can post to the customer: named as a public reply, or a Zendesk node writing public: true,
// or an HTTP write whose body comes from the approval step (Apply agent decision builds public: true).
const isPublicReply = (n) => /public reply/i.test(n.name)
  || (n.type === 'n8n-nodes-base.zendesk' && /public: true|publicReply/.test(JSON.stringify(n.parameters)))
  || (n.type === 'n8n-nodes-base.httpRequest' && n.parameters.method !== 'GET' && /public: true/.test(JSON.stringify(n.parameters)));

test('graph: every public-reply node is only reachable through the approval Wait node', () => {
  const publicNodes = wf.nodes.filter(isPublicReply).map((n) => n.name);
  assert.equal(publicNodes.length, 2);
  assert.ok(TRIGGERS.length >= 2);
  for (const start of TRIGGERS) {
    const seen = new Set(); const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue; seen.add(cur);
      assert.ok(!publicNodes.includes(cur), `${start} reaches ${cur} without approval`);
      if (byName[cur]?.type === 'n8n-nodes-base.wait') continue; // paths past here are approval-gated
      stack.push(...edges(cur));
    }
  }
});

test('graph: Wait node requires the approval header and times out after 24h', () => {
  const w = wf.nodes.find((n) => n.type === 'n8n-nodes-base.wait');
  assert.equal(w.parameters.incomingAuthentication, 'headerAuth');
  assert.equal(w.parameters.resumeAmount, 24); assert.equal(w.parameters.resumeUnit, 'hours');
  assert.ok(w.credentials.httpHeaderAuth.id);
});

test('graph: Apply agent decision is the only code that sets public: true', () => {
  const setters = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code' && /public: true/.test(n.parameters.jsCode)).map((n) => n.name);
  assert.deepEqual(setters, ['Apply agent decision']);
});

test('graph: notes before approval are internal; live nodes are disabled; no secrets in JSON', () => {
  const decide = byName['Decide (policy in code)'].parameters.jsCode;
  assert.match(decide, /public: false/);
  for (const n of wf.nodes.filter((x) => ['n8n-nodes-base.zendesk', 'n8n-nodes-base.slack', 'n8n-nodes-base.zendeskTrigger'].includes(x.type))) assert.equal(n.disabled, true, n.name);
  const raw = JSON.stringify(wf);
  assert.ok(!/sk-or-v1-|lsv2_pt_/.test(raw));
  assert.ok(!raw.includes(process.env.APPROVAL_TOKEN ?? '__none__'));
});

test('graph: only GET requests retry; writes never do', () => {
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) assert.equal(Boolean(n.retryOnFail), n.parameters.method === 'GET', n.name);
});

test('build is deterministic', () => {
  const out = join(ROOT, 'workflow', '.test-build.json');
  execFileSync(process.execPath, [join(ROOT, 'build.mjs'), '--out', out], { env: { ...process.env, MOCK_URL: wf.nodes.find((n) => n.name === 'Zendesk: get ticket').parameters.url.match(/^=(.*?)\/zendesk/)[1] } });
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).nodes, wf.nodes);
});
