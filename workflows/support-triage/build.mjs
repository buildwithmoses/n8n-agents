#!/usr/bin/env node
// Builds workflow/support-triage.json from the source files in this folder:
//   prompts/*.md   -> the LLM chain's system message
//   src/*.js       -> the Code nodes (the same files the tests import)
//
//   node workflows/support-triage/build.mjs                    # baseline
//   node workflows/support-triage/build.mjs --variant naive    # regression: model picks priority, no draft guardrail
//   --out <path>   write somewhere else (setup.mjs uses this)
// Credential ids come from the repo-root .n8n-local.json (written by `npm run setup:shared`).
// MOCK_URL (from .env or the shell) is baked into the HTTP Request nodes; swap it for real API hosts to go live.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, sharedIds, builder, codeFrom, arg } from '../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadEnv();
const ids = sharedIds();
const variant = arg('variant', 'baseline');
const naive = variant === 'naive';
const out = arg('out', join(HERE, 'workflow', naive ? 'support-triage.naive.json' : 'support-triage.json'));
const MOCK = env.mockUrl;
const src = (f) => codeFrom(join(HERE, 'src', f));
const { node, rl } = builder('0a03');

export const N = {
  webhook: 'Webhook: new Zendesk ticket',
  zdTrigger: 'Zendesk Trigger (live, attach credential)',
  readId: 'Read ticket id',
  getTicket: 'Zendesk: get ticket',
  getUser: 'Zendesk: get requester',
  getOrg: 'Zendesk: get organization',
  getCustomer: 'Stripe: get customer (plan, MRR)',
  getArticles: 'Zendesk Guide: help-center articles',
  searchOutage: 'Zendesk: outage tickets, last 30 min',
  openIncidents: 'Linear: open outage incidents',
  prepare: 'Prepare model input',
  chain: 'Classify + draft (Basic LLM Chain)',
  model: 'OpenRouter: Claude Haiku 5.5',
  parser: 'Structured Output Parser',
  decide: 'Decide (policy in code)',
  putNote: 'Zendesk: priority, tags, internal note',
  putNoteLive: 'Zendesk: update + internal note (live)',
  churn: 'Churn risk?',
  slack: 'Slack: alert @priya',
  slackLive: 'Slack: churn alert (live)',
  createIncident: 'Open incident?',
  linearCreate: 'Linear: open incident',
  linkIncident: 'Link to open incident?',
  linearComment: 'Linear: comment on incident',
  response: 'Build triage response',
  respond: 'Respond: triage result',
  hasDraft: 'Draft to approve?',
  wait: 'Wait for agent approval',
  apply: 'Apply agent decision',
  post: 'Agent approved?',
  publicReply: 'Zendesk: post public reply',
  publicReplyLive: 'Zendesk: public reply (live)',
};

const outputSchema = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['billing', 'bug', 'how_to', 'outage', 'cancellation', 'feature_request', 'other'] },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'angry'] },
    language: { type: 'string', description: 'Two-letter ISO code of the customer language' },
    summary: { type: 'string', description: 'One sentence for the agent, in English' },
    draft_reply: { type: 'string', description: 'Reply in the customer language citing [KB-###], or empty' },
    cited_article_ids: { type: 'array', items: { type: 'string' }, description: 'Every KB id cited in draft_reply' },
    ...(naive ? { priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] } } : {}),
  },
  required: ['category', 'sentiment', 'language', 'summary', 'draft_reply', 'cited_article_ids', ...(naive ? ['priority'] : [])],
  additionalProperties: false,
};

const http = (name, pos, method, url, extra = {}) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
  method, url, ...(extra.query ? { sendQuery: true, queryParameters: { parameters: extra.query } } : {}),
  ...(extra.json ? { sendBody: true, specifyBody: 'json', jsonBody: extra.json } : {}),
  options: { timeout: 15000 },
  // Reads retry (network blips); writes don't, so a retry can never post a note or alert twice.
}, { ...(method === 'GET' ? { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 } : {}), ...(extra.node ?? {}) });
const ifNode = (name, pos, left, op, right) => node(name, 'n8n-nodes-base.if', 2.2, pos, {
  conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 2 }, combinator: 'and',
    conditions: [{ id: name.replace(/\W/g, '').toLowerCase(), leftValue: left, rightValue: right ?? '', operator: op }] },
  options: {},
});
const ticketExpr = `$('${N.getTicket}').first().json.ticket`;
const live = (notes) => ({ disabled: true, notes });

const nodes = [
  node(N.webhook, 'n8n-nodes-base.webhook', 2.1, [0, 300], { httpMethod: 'POST', path: 'support-triage', responseMode: 'responseNode', options: {} },
    { webhookId: '0a03c0de-0001-4a00-8000-000000000001', notes: 'Zendesk trigger -> webhook with body {"ticket_id": {{ticket.id}}}' }),
  node(N.zdTrigger, 'n8n-nodes-base.zendeskTrigger', 1, [0, 520], { service: 'support', events: ['ticket.created'], options: {} },
    { webhookId: '0a03c0de-0002-4a00-8000-000000000002', ...live('Production path: attach a Zendesk credential and enable instead of the webhook.') }),
  node(N.readId, 'n8n-nodes-base.code', 2, [220, 300], { jsCode: `// Webhook body {ticket_id} or a Zendesk Trigger item {id}.
const j = $input.first().json;
const id = j.body?.ticket_id ?? j.ticket_id ?? j.id;
if (!/^\\d+$/.test(String(id ?? ''))) throw new Error('ticket_id missing or not numeric');
return [{ json: { ticket_id: Number(id) } }];` }),
  http(N.getTicket, [440, 300], 'GET', `=${MOCK}/zendesk/api/v2/tickets/{{ $json.ticket_id }}.json`),
  http(N.getUser, [660, 300], 'GET', `=${MOCK}/zendesk/api/v2/users/{{ ${ticketExpr}.requester_id }}.json`),
  http(N.getOrg, [880, 300], 'GET', `=${MOCK}/zendesk/api/v2/organizations/{{ ${ticketExpr}.organization_id }}.json`),
  http(N.getCustomer, [1100, 300], 'GET', `=${MOCK}/stripe/v1/customers/{{ $json.organization.external_id }}`),
  http(N.getArticles, [1320, 300], 'GET', `=${MOCK}/zendesk/api/v2/help_center/articles.json`),
  http(N.searchOutage, [1540, 300], 'GET', `=${MOCK}/zendesk/api/v2/search.json`, { query: [{ name: 'query',
    value: `=type:ticket tags:outage created>{{ new Date(new Date(${ticketExpr}.created_at).getTime() - 30 * 60000).toISOString() }}` }] }),
  http(N.openIncidents, [1760, 300], 'GET', `=${MOCK}/linear/issues`, { query: [{ name: 'label', value: 'outage' }, { name: 'state', value: 'open' }] }),
  node(N.prepare, 'n8n-nodes-base.code', 2, [1980, 300], { jsCode: `${src('policy.js')}\n${src('guardrail.js')}\n${src('context.js')}
// ---- n8n wrapper ----
const ctx = prepareContext({
  ticket: ${ticketExpr},
  user: $('${N.getUser}').first().json.user,
  organization: $('${N.getOrg}').first().json.organization,
  customer: $('${N.getCustomer}').first().json,
  articles: $('${N.getArticles}').first().json.articles,
});
return [{ json: ctx }];` }),
  node(N.chain, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, [2200, 300], {
    promptType: 'define', text: '={{ $json.model_input }}', hasOutputParser: true,
    messages: { messageValues: [{ message: readFileSync(join(HERE, 'prompts', naive ? 'naive.md' : 'system.md'), 'utf8').trim() }] },
  }, { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),
  node(N.model, '@n8n/n8n-nodes-langchain.lmChatOpenRouter', 1, [2140, 540], {
    model: 'anthropic/claude-haiku-5.5', options: { maxTokens: 1500, temperature: 0, timeout: 45000, maxRetries: 2, providerRouting: { dataCollection: 'deny' } },
  }, { credentials: { openRouterApi: { id: ids.openRouterCredId ?? 'REPLACE_WITH_OPENROUTER_CREDENTIAL_ID', name: 'OpenRouter (n8n-agents)' } } }),
  node(N.parser, '@n8n/n8n-nodes-langchain.outputParserStructured', 1.3, [2300, 540], { schemaType: 'manual', inputSchema: JSON.stringify(outputSchema, null, 2) }),
  node(N.decide, 'n8n-nodes-base.code', 2, [2460, 300], { jsCode: `${src('policy.js')}\n${src('guardrail.js')}\n${src('outage.js')}\n${src('decide.js')}
// ---- n8n wrapper ----
const out = $input.first().json;
const model = out.output && typeof out.output === 'object' ? out.output : null;
const decision = decideTicket({
  ctx: $('${N.prepare}').first().json,
  model,
  recent: $('${N.searchOutage}').first().json.results ?? [],
  openIncidents: $('${N.openIncidents}').first().json.issues ?? [],
}, { variant: '${variant}' });
return [{ json: { ...decision, model_error: model ? null : String(out.error?.message ?? out.error ?? 'no output') } }];` }),
  http(N.putNote, [2680, 300], 'PUT', `=${MOCK}/zendesk/api/v2/tickets/{{ $json.ticket_id }}.json`, { json: '={{ JSON.stringify($json.zendesk_update) }}' }),
  node(N.putNoteLive, 'n8n-nodes-base.zendesk', 1, [2680, 520], {
    resource: 'ticket', operation: 'update', id: '={{ $json.ticket_id }}', jsonParameters: true,
    updateFieldsJson: '={{ JSON.stringify({ priority: $json.priority, group_id: $json.group_id, tags: $json.tags, comment: { body: $json.zendesk_update.ticket.comment.body, public: false } }) }}',
  }, live('Production path: attach a Zendesk credential, enable, and disable the mock PUT. Internal note only (public: false).')),
  ifNode(N.churn, [2900, 300], `={{ $('${N.decide}').first().json.churn_alert }}`, { type: 'boolean', operation: 'true', singleValue: true }),
  http(N.slack, [3120, 160], 'POST', `=${MOCK}/slack/api/chat.postMessage`, { json: `={{ JSON.stringify($('${N.decide}').first().json.slack) }}` }),
  node(N.slackLive, 'n8n-nodes-base.slack', 2.3, [3120, -40], {
    select: 'channel', channelId: { __rl: true, mode: 'name', value: '#support-leads' }, text: `={{ $('${N.decide}').first().json.slack.text }}`, otherOptions: {},
  }, live('Production path: attach a Slack credential and enable.')),
  ifNode(N.createIncident, [3340, 300], `={{ $('${N.decide}').first().json.linear.action }}`, { type: 'string', operation: 'equals' }, 'create'),
  http(N.linearCreate, [3560, 160], 'POST', `=${MOCK}/linear/issues`, { json: `={{ JSON.stringify($('${N.decide}').first().json.linear.body) }}` }),
  ifNode(N.linkIncident, [3560, 420], `={{ $('${N.decide}').first().json.linear.action }}`, { type: 'string', operation: 'equals' }, 'link'),
  http(N.linearComment, [3780, 420], 'POST', `=${MOCK}/linear/issues/{{ $('${N.decide}').first().json.linear.incident_id }}/comments`, { json: `={{ JSON.stringify($('${N.decide}').first().json.linear.body) }}` }),
  node(N.response, 'n8n-nodes-base.code', 2, [4000, 300], { jsCode: `const d = $('${N.decide}').first().json;
let incident = null;
try { incident = $('${N.linearCreate}').first().json.issue?.identifier ?? null; } catch (e) {}
return [{ json: {
  ticket_id: d.ticket_id, category: d.category, priority: d.priority, sla_hours: d.sla_hours, group_id: d.group_id, tags: d.tags,
  language: d.language, sentiment: d.sentiment, churn_alert: d.churn_alert, injection_suspected: d.injection_suspected,
  outage: d.outage, outage_action: d.linear.action, outage_count: d.outage_count, incident_opened: incident,
  draft_saved_as_internal_note: !d.draft_withheld, draft: d.draft, withheld_reasons: d.withheld_reasons, citations: d.citations,
  model_error: d.model_error, variant: d.variant, execution_id: $execution.id,
  approve_url: d.draft_withheld ? null : $execution.resumeUrl,
  how_to_approve: d.draft_withheld ? null : 'POST {"approved": true, "agent": "<name>", "reply": "<optional edited text>"} to approve_url with the X-Approval-Token header. Anything else posts nothing.',
} }];` }),
  node(N.respond, 'n8n-nodes-base.respondToWebhook', 1.4, [4220, 300], { respondWith: 'firstIncomingItem', options: {} }),
  ifNode(N.hasDraft, [4440, 300], '={{ $json.draft_saved_as_internal_note }}', { type: 'boolean', operation: 'true', singleValue: true }),
  node(N.wait, 'n8n-nodes-base.wait', 1.1, [4660, 280], {
    resume: 'webhook', httpMethod: 'POST', incomingAuthentication: 'headerAuth', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 24, resumeUnit: 'hours', options: {},
  }, { webhookId: '0a03c0de-0003-4a00-8000-000000000003', credentials: { httpHeaderAuth: { id: ids.approvalCredId ?? 'REPLACE_WITH_HEADER_AUTH_CREDENTIAL_ID', name: 'Approval header (n8n-agents)' } } }),
  node(N.apply, 'n8n-nodes-base.code', 2, [4880, 280], { jsCode: `${src('apply.js')}
// ---- n8n wrapper ----
const d = $('${N.decide}').first().json;
const w = $input.first().json;
const decision = w.body && typeof w.body === 'object' ? w.body : {};
return [{ json: { ...applyDecision({ decision, draft: d.draft, ticketId: d.ticket_id }), ticket_id: d.ticket_id } }];` }),
  ifNode(N.post, [5100, 280], '={{ $json.post }}', { type: 'boolean', operation: 'true', singleValue: true }),
  http(N.publicReply, [5320, 180], 'PUT', `=${MOCK}/zendesk/api/v2/tickets/{{ $json.ticket_id }}.json`, { json: '={{ JSON.stringify($json.zendesk_update) }}' }),
  node(N.publicReplyLive, 'n8n-nodes-base.zendesk', 1, [5320, 400], {
    resource: 'ticket', operation: 'update', id: '={{ $json.ticket_id }}', jsonParameters: true,
    updateFieldsJson: '={{ JSON.stringify({ status: "pending", comment: { body: $json.zendesk_update.ticket.comment.body, public: true } }) }}',
  }, live('Production path: attach a Zendesk credential and enable. Reachable only after an agent approves.')),
];

const c = (to, index = 0) => ({ node: to, type: 'main', index });
const connections = {
  [N.webhook]: { main: [[c(N.readId)]] },
  [N.zdTrigger]: { main: [[c(N.readId)]] },
  [N.readId]: { main: [[c(N.getTicket)]] },
  [N.getTicket]: { main: [[c(N.getUser)]] },
  [N.getUser]: { main: [[c(N.getOrg)]] },
  [N.getOrg]: { main: [[c(N.getCustomer)]] },
  [N.getCustomer]: { main: [[c(N.getArticles)]] },
  [N.getArticles]: { main: [[c(N.searchOutage)]] },
  [N.searchOutage]: { main: [[c(N.openIncidents)]] },
  [N.openIncidents]: { main: [[c(N.prepare)]] },
  [N.prepare]: { main: [[c(N.chain)]] },
  [N.model]: { ai_languageModel: [[{ node: N.chain, type: 'ai_languageModel', index: 0 }]] },
  [N.parser]: { ai_outputParser: [[{ node: N.chain, type: 'ai_outputParser', index: 0 }]] },
  [N.chain]: { main: [[c(N.decide)]] },
  [N.decide]: { main: [[c(N.putNote), c(N.putNoteLive)]] },
  [N.putNote]: { main: [[c(N.churn)]] },
  [N.churn]: { main: [[c(N.slack), c(N.slackLive)], [c(N.createIncident)]] },
  [N.slack]: { main: [[c(N.createIncident)]] },
  [N.createIncident]: { main: [[c(N.linearCreate)], [c(N.linkIncident)]] },
  [N.linearCreate]: { main: [[c(N.response)]] },
  [N.linkIncident]: { main: [[c(N.linearComment)], [c(N.response)]] },
  [N.linearComment]: { main: [[c(N.response)]] },
  [N.response]: { main: [[c(N.respond)]] },
  [N.respond]: { main: [[c(N.hasDraft)]] },
  [N.hasDraft]: { main: [[c(N.wait)], []] },
  [N.wait]: { main: [[c(N.apply)]] },
  [N.apply]: { main: [[c(N.post)]] },
  [N.post]: { main: [[c(N.publicReply), c(N.publicReplyLive)], []] },
};

const wf = {
  name: `Support Triage - Fernhill Software${naive ? ' (regression: naive)' : ''}`,
  nodes, connections,
  settings: { executionOrder: 'v1', timezone: 'America/New_York', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveExecutionProgress: true },
  meta: { variant, built_from: 'workflows/support-triage/build.mjs' },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(wf, null, 2) + '\n');
console.log(`wrote ${out} (${nodes.length} nodes, variant ${variant})`);
