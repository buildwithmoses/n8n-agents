#!/usr/bin/env node
// Builds workflow/lead-router.json from the source in this folder:
//   rules.json, src/*.js   -> the Code nodes (the same files the tests import)
//   prompts/extract.md     -> the LLM's system message (extraction only)
//   --variant naive        -> regression: the model decides segment, owner and disposition, no dedupe, no approvals
// Instance ids (credentials) come from the repo-root .n8n-local.json; MOCK_URL from .env.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builder, codeFrom, sharedIds, loadEnv, arg } from '../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
const variant = arg('variant', 'baseline');
const naive = variant === 'naive';
const out = arg('out', join(HERE, 'workflow', naive ? 'lead-router.naive.json' : 'lead-router.json'));
const MOCK = arg('mock-url', env.mockUrl);
const ids = sharedIds();
const openRouterCredId = ids.openRouterCredId ?? 'REPLACE_WITH_OPENROUTER_CREDENTIAL_ID';
const approvalCredId = ids.approvalCredId ?? 'REPLACE_WITH_HEADER_AUTH_CREDENTIAL_ID';

const rules = JSON.parse(readFileSync(join(HERE, 'rules.json'), 'utf8'));
const src = (f) => codeFrom(join(HERE, 'src', f));
const { node } = builder('0a01');

const N = {
  webhook: 'Webhook: POST /lead-router',
  normalize: 'Normalize lead',
  enrich: 'Enrich company (HTTP)',
  screen: 'Screen lead (code)',
  chain: 'Extract fields (Basic LLM Chain)',
  model: 'OpenRouter: Claude Haiku 5.5',
  parser: 'Structured Output Parser',
  owners: 'HubSpot: owners + load',
  lookup: 'HubSpot: dedupe lookup',
  plan: 'Score + route + plan (code)',
  needsApproval: 'Needs Dana?',
  liveApproval: 'Live Slack approval?',
  slackApprove: 'Slack: ask Dana (send and wait)',
  respondHeld: 'Respond: held for Dana + approve URL',
  wait: 'Wait for Dana',
  apply: 'Apply approval (code)',
  hasOps: 'Anything to write?',
  explode: 'One item per write',
  live: 'Live CRM?',
  hsContactLive: 'HubSpot: upsert contact (live)',
  hsDealLive: 'HubSpot: create deal (live)',
  slackLive: 'Slack: DM owner (live)',
  write: 'Write: HubSpot + Slack (mock API)',
  summary: 'Summarize run',
  responded: 'Already answered caller?',
  respond: 'Respond: result',
};

const RULES = `const RULES = ${JSON.stringify(rules)};`;
const ifNode = (name, pos, left, op, right) => node(name, 'n8n-nodes-base.if', 2.2, pos, {
  conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 2 }, combinator: 'and',
    conditions: [{ id: name.replace(/\W/g, '').slice(0, 12), leftValue: left, rightValue: right ?? '', operator: op }] },
  options: {},
});
const isTrue = { type: 'boolean', operation: 'true', singleValue: true };

const normalizeCode = `${src('normalize.js')}
// ---- n8n wrapper ----
const body = $('${N.webhook}').first().json.body ?? {};
const raw = body.lead ?? body;
return [{ json: { ...normalizeLead(raw), live: body.live === true } }];`;

const screenCode = `${RULES}
${src('classify.js')}
// ---- n8n wrapper ----
const lead = $('${N.normalize}').first().json;
const e = $input.first().json;
const enrichment = e && e.found ? e : { found: false };
const screen = screenLead(lead, RULES);
const prompt_text = '<form_answer>\\nCompany: ' + lead.company + '\\nTeam size picked on form: ' + (lead.team_size || 'not given') + '\\n\\n' + lead.message + '\\n</form_answer>';
return [{ json: { lead, enrichment, screen, prompt_text } }];`;

const planCode = naive ? `${RULES}
${src('naive.js')}
// ---- n8n wrapper (REGRESSION: the model decides; no dedupe; no approvals) ----
const s = $('${N.screen}').first().json;
const llm = $('${N.chain}').first().json;
const owners = $('${N.owners}').first().json.owners ?? [];
return [{ json: planNaive(s.lead, llm.output ?? null, owners) }];` : `${RULES}
${src('classify.js')}
${src('route.js')}
// ---- n8n wrapper ----
const s = $('${N.screen}').first().json;
const llm = $('${N.chain}').first().json;
const extraction = llm.output ?? null;            // null when the model call failed: the rules still route on form fields
const owners = $('${N.owners}').first().json.owners ?? [];
const dedupe = $input.first().json;
if (!Array.isArray(owners) || owners.length === 0) throw new Error('no owners from HubSpot; refusing to route');
const routing = scoreLead(s.lead, s.screen, extraction, s.enrichment, RULES);
const plan = planLead(s.lead, s.screen, routing, dedupe, owners, RULES);
return [{ json: { ...plan, model_ok: !!extraction, model_error: extraction ? null : String(llm.error?.message ?? llm.error ?? 'no output'), live: s.lead.live === true } }];`;

const applyCode = `${RULES}
${src('route.js')}
// ---- n8n wrapper: runs after Dana answers, or after the 24h timeout (no body => nothing applied) ----
const plan = $('${N.plan}').first().json;
const owners = $('${N.owners}').first().json.owners ?? [];
const response = $input.first().json.body ?? null;
return [{ json: applyApproval(plan, response, owners, RULES) }];`;

const explodeCode = `// One n8n item per planned write, so one HTTP Request node does them in order.
const p = $input.first().json;
return (p.ops ?? []).map((op, i) => ({ json: { ...op, seq: i, lead_id: p.lead_id } }));`;

const summaryCode = `// One result per lead for the caller (and the eval harness).
const plan = $('${N.plan}').first().json;
let final = plan;
if (plan.needs_approval) { try { final = $('${N.apply}').first().json; } catch (e) { final = { ...plan, decision: 'not_applied', ops: [] }; } }
let writes = [];
try { writes = $('${N.write}').all().map((i) => i.json); } catch (e) { writes = []; }
const errors = writes.filter((w) => w.error).map((w) => String(w.error?.message ?? w.error));
return [{ json: {
  lead_id: plan.lead_id, disposition: plan.disposition, reason: plan.reason, holds: plan.holds ?? [],
  needs_approval: !!plan.needs_approval, decision: final.decision ?? (plan.needs_approval ? 'pending' : 'auto'),
  segment: plan.routing?.segment ?? null, territory: plan.routing?.territory ?? null, tier: plan.routing?.tier ?? null, score: plan.routing?.score ?? null,
  tech_count: plan.routing?.techs ?? null, tech_source: plan.routing?.tech_source ?? null, trade: plan.routing?.trade ?? null,
  screen: plan.screen, proposed_owner: plan.proposed_owner ?? null, final_owner: final.final_owner ?? (plan.needs_approval ? null : plan.proposed_owner ?? null),
  ops_planned: (final.ops ?? []).length, writes_ok: writes.length - errors.length, write_errors: errors,
  model_ok: plan.model_ok ?? null, model_error: plan.model_error ?? null, execution_id: $execution.id,
} }];`;

const extractSchema = {
  type: 'object',
  properties: {
    trade: { type: 'string', enum: ['hvac', 'plumbing', 'electrical', 'roofing', 'garage_door', 'pest_control', 'appliance_repair', 'landscaping', 'solar', 'other', 'unknown'] },
    tech_count: { type: 'integer', description: 'Field techs, crews or trucks stated in the text. 0 if not stated.' },
    current_software: { type: 'string' },
    timeline: { type: 'string', enum: ['now', 'within_30_days', '1_3_months', '3_plus_months', 'unknown'] },
    summary: { type: 'string', description: 'Two plain sentences for the sales rep.' },
  },
  required: ['trade', 'tech_count', 'current_software', 'timeline', 'summary'],
  additionalProperties: false,
};
const naiveSchema = {
  ...extractSchema,
  properties: { ...extractSchema.properties,
    segment: { type: 'string', enum: ['Starter', 'Pro', 'Enterprise'] },
    owner_id: { type: 'string', description: 'id of the rep who should own this lead' },
    disposition: { type: 'string', enum: ['route', 'nurture', 'drop'] } },
  required: [...extractSchema.required, 'segment', 'owner_id', 'disposition'],
};
const ownersText = rules.owners.map((o) => `- ${o.id}: ${o.name}, ${o.territory} territory, ${o.segments.join('/')}`).join('\n');
const systemPrompt = naive ? readFileSync(join(HERE, 'prompts/naive.md'), 'utf8').replace('{{OWNERS}}', ownersText).trim() : readFileSync(join(HERE, 'prompts/extract.md'), 'utf8').trim();

const http = (name, pos, params, extra = {}) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, { options: {}, ...params }, extra);

const nodes = [
  node(N.webhook, 'n8n-nodes-base.webhook', 2.1, [0, 300], { httpMethod: 'POST', path: naive ? 'lead-router' : 'lead-router', responseMode: 'responseNode', options: {} }, { webhookId: '0a01d3c9-1b7e-4f0a-9d7c-1f2e3a4b0001' }),
  node(N.normalize, 'n8n-nodes-base.code', 2, [220, 300], { jsCode: normalizeCode }),
  http(N.enrich, [440, 300], { method: 'GET', url: `${MOCK}/enrich/company`, sendQuery: true, queryParameters: { parameters: [{ name: 'domain', value: '={{ $json.domain }}' }] } },
    { onError: 'continueRegularOutput', alwaysOutputData: true, notes: 'Clearbit-style enrichment. Failure is fine: routing falls back to form fields.' }),
  node(N.screen, 'n8n-nodes-base.code', 2, [660, 300], { jsCode: screenCode }),
  node(N.chain, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, [880, 300], {
    promptType: 'define', text: '={{ $json.prompt_text }}', hasOutputParser: true,
    messages: { messageValues: [{ message: systemPrompt }] },
  }, { onError: 'continueRegularOutput', notes: naive ? 'REGRESSION variant: the model decides routing.' : 'Extraction only. The model never sees the routing rules and cannot change where a lead goes.' }),
  node(N.model, '@n8n/n8n-nodes-langchain.lmChatOpenRouter', 1, [880, 520], {
    model: 'anthropic/claude-haiku-5.5', options: { maxTokens: 800, temperature: 0, timeout: 45000, maxRetries: 2, providerRouting: { dataCollection: 'deny' } },
  }, { credentials: { openRouterApi: { id: openRouterCredId, name: 'OpenRouter (n8n-agents)' } } }),
  node(N.parser, '@n8n/n8n-nodes-langchain.outputParserStructured', 1.3, [1060, 520], { schemaType: 'manual', inputSchema: JSON.stringify(naive ? naiveSchema : extractSchema, null, 2) }),
  http(N.owners, [1100, 300], { method: 'GET', url: `${MOCK}/hubspot/owners` }, { executeOnce: true }),
  http(N.lookup, [1320, 300], { method: 'GET', url: `${MOCK}/hubspot/lookup`, sendQuery: true, queryParameters: { parameters: [
    { name: 'email', value: `={{ $('${N.screen}').first().json.lead.email }}` }, { name: 'domain', value: `={{ $('${N.screen}').first().json.lead.domain }}` }] } },
    { executeOnce: true, notes: naive ? 'Called but ignored in the naive variant.' : 'Existing contact, company, open deals, customer flag.' }),
  node(N.plan, 'n8n-nodes-base.code', 2, [1540, 300], { jsCode: planCode }),
  ifNode(N.needsApproval, [1760, 300], '={{ $json.needs_approval }}', isTrue),
  ifNode(N.liveApproval, [1980, 120], '={{ $json.live }}', isTrue),
  node(N.slackApprove, 'n8n-nodes-base.slack', 2.3, [2200, 0], {
    operation: 'sendAndWait', select: 'user', user: { __rl: true, mode: 'username', value: rules.approver.slack.replace('@', '') },
    message: '=Lead held for you: {{ $json.company }} ({{ $json.email }}). Why: {{ $json.reason }}. Proposed owner: {{ $json.proposed_owner?.name ?? "none" }}. Rules pick: {{ $json.rules_pick?.name ?? "none" }}.',
    responseType: 'customForm', defineForm: 'json',
    jsonOutput: `={{ JSON.stringify([{ fieldLabel: 'Decision', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'approve' }, { option: 'reject' }] }, requiredField: true }, { fieldLabel: 'Owner id (blank = proposed)', fieldType: 'text' }]) }}`,
    options: { messageButtonLabel: 'Review lead', responseFormTitle: 'Approve lead routing', limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: 24, resumeUnit: 'hours' } } },
  }, { disabled: true, webhookId: '0a01e4d0-2c8f-4a1b-8e9d-2a3b4c5d0002', notes: 'Production approval. Attach a Slack credential and enable; map the form answer to {decision, owner_id, approver:"dana"}. Timeout = nothing applied.' }),
  node(N.respondHeld, 'n8n-nodes-base.respondToWebhook', 1.4, [2200, 220], { respondWith: 'json', responseBody: `={{ JSON.stringify({ held: true, lead_id: $json.lead_id, disposition: $json.disposition, reason: $json.reason, holds: $json.holds, proposed_owner: $json.proposed_owner, rules_pick: $json.rules_pick, segment: $json.routing?.segment, territory: $json.routing?.territory, execution_id: $execution.id, approve_url: $execution.resumeUrl, how_to_approve: 'POST {"decision":"approve"|"reject","owner_id":"optional","approver":"dana"} to approve_url with the X-Approval-Token header' }) }}`, options: {} }),
  node(N.wait, 'n8n-nodes-base.wait', 1.1, [2420, 220], {
    resume: 'webhook', httpMethod: 'POST', incomingAuthentication: 'headerAuth', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 24, resumeUnit: 'hours', options: {},
  }, { webhookId: '0a01f5e1-3d9a-4b2c-9fae-3b4c5d6e0003', credentials: { httpHeaderAuth: { id: approvalCredId, name: 'Approval header (n8n-agents)' } } }),
  node(N.apply, 'n8n-nodes-base.code', 2, [2640, 120], { jsCode: applyCode }),
  ifNode(N.hasOps, [2860, 300], '={{ ($json.ops ?? []).length }}', { type: 'number', operation: 'gt' }, 0),
  node(N.explode, 'n8n-nodes-base.code', 2, [3080, 200], { jsCode: explodeCode }),
  ifNode(N.live, [3300, 200], `={{ $('${N.plan}').first().json.live }}`, isTrue),
  node(N.hsContactLive, 'n8n-nodes-base.hubspot', 2.1, [3520, 0], { resource: 'contact', operation: 'upsert', email: '={{ $json.body?.properties?.email }}', additionalFields: {} },
    { disabled: true, notes: 'Production path. Attach a HubSpot app token and enable; map the remaining properties from $json.body.properties.' }),
  node(N.hsDealLive, 'n8n-nodes-base.hubspot', 2.1, [3740, 0], { resource: 'deal', operation: 'create', stage: 'appointmentscheduled', additionalFields: { dealName: '={{ $json.body?.name }}' } },
    { disabled: true, notes: 'Production path. Only runs for ops the plan (or Dana) produced.' }),
  node(N.slackLive, 'n8n-nodes-base.slack', 2.3, [3960, 0], { select: 'user', user: { __rl: true, mode: 'username', value: '={{ $json.body?.channel?.replace("@", "") }}' }, text: '={{ $json.body?.text }}', otherOptions: {} },
    { disabled: true, webhookId: '0a01a6f2-4e0b-4c3d-8a1f-4c5d6e7f0004', notes: 'Production path. Attach a Slack credential and enable.' }),
  http(N.write, [3520, 300], {
    method: '={{ $json.method }}', url: `=${MOCK}{{ $json.path }}`, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
  }, { onError: 'continueRegularOutput', notes: `Mock HubSpot/Slack at ${MOCK}. Swap for the live nodes above in production.` }),
  node(N.summary, 'n8n-nodes-base.code', 2, [3740, 400], { jsCode: summaryCode }),
  ifNode(N.responded, [3960, 400], `={{ $('${N.plan}').first().json.needs_approval }}`, isTrue),
  node(N.respond, 'n8n-nodes-base.respondToWebhook', 1.4, [4180, 480], { respondWith: 'firstIncomingItem', options: {} }),
];

const c = (to, index = 0) => ({ node: to, type: 'main', index });
const connections = {
  [N.webhook]: { main: [[c(N.normalize)]] },
  [N.normalize]: { main: [[c(N.enrich)]] },
  [N.enrich]: { main: [[c(N.screen)]] },
  [N.screen]: { main: [[c(N.chain)]] },
  [N.chain]: { main: [[c(N.owners)]] },
  [N.model]: { ai_languageModel: [[{ node: N.chain, type: 'ai_languageModel', index: 0 }]] },
  [N.parser]: { ai_outputParser: [[{ node: N.chain, type: 'ai_outputParser', index: 0 }]] },
  [N.owners]: { main: [[c(N.lookup)]] },
  [N.lookup]: { main: [[c(N.plan)]] },
  [N.plan]: { main: [[c(N.needsApproval)]] },
  [N.needsApproval]: { main: [[c(N.liveApproval)], [c(N.hasOps)]] },
  [N.liveApproval]: { main: [[c(N.slackApprove)], [c(N.respondHeld)]] },
  [N.slackApprove]: { main: [[c(N.apply)]] },
  [N.respondHeld]: { main: [[c(N.wait)]] },
  [N.wait]: { main: [[c(N.apply)]] },
  [N.apply]: { main: [[c(N.hasOps)]] },
  [N.hasOps]: { main: [[c(N.explode)], [c(N.summary)]] },
  [N.explode]: { main: [[c(N.live)]] },
  [N.live]: { main: [[c(N.hsContactLive)], [c(N.write)]] },
  [N.hsContactLive]: { main: [[c(N.hsDealLive)]] },
  [N.hsDealLive]: { main: [[c(N.slackLive)]] },
  [N.slackLive]: { main: [[c(N.summary)]] },
  [N.write]: { main: [[c(N.summary)]] },
  [N.summary]: { main: [[c(N.responded)]] },
  [N.responded]: { main: [[], [c(N.respond)]] },
};

const wf = {
  name: naive ? 'Lead Router - Fernhill (REGRESSION: model decides)' : 'Lead Router - Fernhill Software',
  nodes, connections,
  settings: { executionOrder: 'v1', timezone: 'America/New_York', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveManualExecutions: true },
  meta: { variant, mock_url: MOCK },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(wf, null, 2) + '\n');
console.log(`wrote ${out} (${nodes.length} nodes, variant ${variant})`);
export { N };
