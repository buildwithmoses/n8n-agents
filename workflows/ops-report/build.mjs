#!/usr/bin/env node
// Builds workflow/ops-report.json from source:
//   src/*.js        -> Code node bodies (the same files the tests import)
//   prompts/*.md    -> the narrative chain's system message
//
//   node build.mjs                    # baseline
//   node build.mjs --variant naive    # regression: failed sources count as 0, no number check, generic prompt,
//                                     #             customer text not fenced, any approver can post to #all-hands
// Instance ids come from ../../.n8n-local.json (credentials) . MOCK_URL decides where the HTTP nodes point.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builder, codeFrom, sharedIds, loadEnv, arg } from '../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const variant = arg('variant', 'baseline');
const naive = variant === 'naive';
const env = loadEnv();
const MOCK = (process.env.MOCK_URL ?? env.mockUrl).replace(/\/$/, '');
const shared = sharedIds();
const ids = {
  openRouterCredId: shared.openRouterCredId ?? 'REPLACE_WITH_OPENROUTER_CREDENTIAL_ID',
  approvalCredId: shared.approvalCredId ?? 'REPLACE_WITH_HEADER_AUTH_CREDENTIAL_ID',
};
const src = (f) => codeFrom(join(HERE, 'src', f));
const prompt = readFileSync(join(HERE, 'prompts', naive ? 'naive.md' : 'system.md'), 'utf8').trim();
const { node, rl } = builder('0a04');

const N = {
  schedule: 'Every Monday 7am (ET)',
  webhook: 'Webhook: POST /ops-report',
  resolve: 'Resolve week',
  stripe: 'Stripe: MRR events',
  hubspot: 'HubSpot: deals',
  zendesk: 'Zendesk: tickets',
  linear: 'Linear: issues',
  github: 'GitHub: deployments',
  compute: 'Compute metrics (code)',
  chain1: 'Write narrative',
  model1: 'OpenRouter: Claude Haiku 5.5',
  check1: 'Check numbers',
  passed: 'Passed check?',
  chain2: 'Rewrite narrative (one retry)',
  model2: 'OpenRouter: Claude Haiku 5.5 (retry)',
  check2: 'Check rewrite (else table)',
  finalize: 'Build report',
  dm: 'Slack: DM @owen',
  dmLive: 'Slack: DM @owen (live)',
  fromWebhook: 'Started by webhook?',
  respond: 'Respond: report + approve URL',
  wait: 'Wait for Owen to approve #all-hands',
  decide: 'Apply approval decision',
  approved: 'Approved by Owen?',
  post: 'Slack: post to #all-hands',
  postLive: 'Slack: post to #all-hands (live)',
  notPosted: 'Not posted',
  liveStripe: 'Stripe (live)', liveHubspot: 'HubSpot (live)', liveZendesk: 'Zendesk (live)', liveLinear: 'Linear (live)', liveGithub: 'GitHub (live)',
  note: 'How this works',
};

// ---------- Code node bodies ----------
const resolveCode = `${src('week.js')}
// ---- n8n wrapper ----
let body = {};
try { body = $('${N.webhook}').first().json.body ?? {}; } catch (e) { body = {}; }
const w = resolveWeek(body.week, new Date($now.toISO()));
return [{ json: { ...w, trigger: body.week ? 'webhook' : 'schedule', weeks_param: w.week + ',' + w.prev_week } }];`;

const SRC_NODES = { stripe: N.stripe, hubspot: N.hubspot, zendesk: N.zendesk, linear: N.linear, github: N.github };
const computeCode = `${src('metrics.js')}
// ---- n8n wrapper ----
const w = $('${N.resolve}').first().json;
const grab = (name) => { try { return $(name).first().json; } catch (e) { return { error: String(e.message ?? e) }; } };
const responses = { ${Object.entries(SRC_NODES).map(([k, v]) => `${k}: grab('${v}')`).join(', ')} };
const report = computeReport(w, responses, { naive: ${naive} });
${src('report.js')}
return [{ json: { report, prompt: narrativeInput(report, { naive: ${naive} }) } }];`;

const check1Code = `${src('numbercheck.js')}
// ---- n8n wrapper ----
const report = $('${N.compute}').first().json.report;
const out = $input.first().json;
const text = typeof out.text === 'string' ? out.text : '';
const res = ${naive ? `{ ok: text.length > 0, problems: text ? [] : ['model error'], numbers: 0 }` : 'checkNarrative(text, report)'};
${src('report.js')}
return [{ json: { ok: res.ok, problems: res.problems, draft: text, model_error: out.error ? String(out.error.message ?? out.error) : null,
  retry_prompt: retryInput(report, text || '(no draft: the model call failed)', res.problems.length ? res.problems : ['model call failed']) } }];`;

const check2Code = `${src('numbercheck.js')}
${src('report.js')}
// ---- n8n wrapper ----
const report = $('${N.compute}').first().json.report;
const text = typeof $input.first().json.text === 'string' ? $input.first().json.text : '';
const res = checkNarrative(text, report);
const first = $('${N.check1}').first().json;
return [{ json: res.ok
  ? { narrative: text, mode: 'retry', check: { first: first.problems, retry: [] } }
  : { narrative: fallbackNarrative(report), mode: 'table_fallback', check: { first: first.problems, retry: res.problems } } }];`;

const finalizeCode = `${src('metrics.js')}
${src('report.js')}
// ---- n8n wrapper ----
const report = $('${N.compute}').first().json.report;
const j = $input.first().json;
// Arrives from "Passed check?" (first pass: { ok, draft }) or from the retry check ({ narrative, mode }).
const narrative = j.narrative ?? j.draft;
const mode = j.mode ?? '${naive ? 'unchecked' : 'first_pass'}';
const report_markdown = buildReport(report, narrative, mode);
return [{ json: { week: report.week, mode, narrative, report_markdown, check: j.check ?? { first: j.problems ?? [] }, report } }];`;

const decideCode = `${src('approval.js')}
// ---- n8n wrapper ----
const d = decide($input.first().json, { naive: ${naive} });
const fin = $('${N.finalize}').first().json;
return [{ json: { ...d, week: fin.week, text: d.edited ?? fin.report_markdown } }];`;

// ---------- nodes ----------
const http = (name, pos, path) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
  url: `=${MOCK}${path}?weeks={{ $('${N.resolve}').first().json.weeks_param }}`,
  options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 15000 },
}, { onError: 'continueRegularOutput', alwaysOutputData: true, retryOnFail: true, maxTries: 2, waitBetweenTries: 1000 });

const slackPost = (name, pos, channelExpr, textExpr) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
  method: 'POST', url: `${MOCK}/slack/api/chat.postMessage`, sendBody: true, specifyBody: 'json',
  jsonBody: `={{ JSON.stringify({ channel: ${channelExpr}, text: ${textExpr}, unfurl_links: false }) }}`, options: {},
});
const slackLive = (name, pos, channel, textExpr, extra = {}) => node(name, 'n8n-nodes-base.slack', 2.3, pos, {
  select: 'channel', channelId: { __rl: true, mode: 'name', value: channel }, text: textExpr, otherOptions: {},
}, { disabled: true, notes: 'Production path: attach a Slack credential, enable this node, and disable the mock HTTP sibling.', ...extra });
const liveHttp = (name, pos, url, notes) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, { url, authentication: 'predefinedCredentialType', options: {} }, { disabled: true, notes });

const ifNode = (name, pos, left, op, right) => node(name, 'n8n-nodes-base.if', 2.2, pos, {
  conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 2 }, combinator: 'and',
    conditions: [{ id: name.replace(/\W/g, '').slice(0, 12), leftValue: left, rightValue: right, operator: op }] },
  options: {},
});
const model = (name, pos) => node(name, '@n8n/n8n-nodes-langchain.lmChatOpenRouter', 1, pos, {
  model: 'anthropic/claude-haiku-5.5',
  options: { maxTokens: 2000, temperature: 0.2, timeout: 60000, maxRetries: 2, providerRouting: { dataCollection: 'deny' } },
}, { credentials: { openRouterApi: { id: ids.openRouterCredId, name: 'OpenRouter (n8n-agents)' } } });
const chain = (name, pos, textExpr) => node(name, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, pos, {
  promptType: 'define', text: textExpr, messages: { messageValues: [{ message: prompt }] },
}, { onError: 'continueRegularOutput' });

const nodes = [
  node(N.note, 'n8n-nodes-base.stickyNote', 1, [-40, -420], { width: 760, height: 300, content:
    '## Fernhill weekly ops report\nPulls last week and the week before from Stripe, HubSpot, Zendesk, Linear and GitHub.\n**Code** computes every metric, delta and anomaly. A failed or empty source is *missing*, never zero.\n**The model** only writes the narrative from that JSON. **Code** then checks every number in it; one rewrite, then a numbers-only fallback.\nOwen gets a DM. **#all-hands only after Owen approves** (Wait node, header auth).\nThe grey "(live)" nodes are the production path; the HTTP nodes above them hit the mock SaaS server.' }),
  node(N.schedule, 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 7, triggerAtMinute: 0 }] } }),
  node(N.webhook, 'n8n-nodes-base.webhook', 2.1, [0, 200], { httpMethod: 'POST', path: 'ops-report', responseMode: 'responseNode', options: {} }, { webhookId: '0a04c0de-0000-4000-8000-00000000a001' }),
  node(N.resolve, 'n8n-nodes-base.code', 2, [240, 100], { jsCode: resolveCode }),
  http(N.stripe, [480, 100], '/stripe/v1/weekly'),
  http(N.hubspot, [700, 100], '/hubspot/crm/v3/weekly'),
  http(N.zendesk, [920, 100], '/zendesk/api/v2/weekly'),
  http(N.linear, [1140, 100], '/linear/weekly'),
  http(N.github, [1360, 100], '/github/repos/fernhill/dispatch/deployments/weekly'),
  liveHttp(N.liveStripe, [480, 320], 'https://api.stripe.com/v1/events?type=customer.subscription.*', 'Production: Stripe credential; page through events for the two weeks, then feed Compute metrics the same shape.'),
  liveHttp(N.liveHubspot, [700, 320], 'https://api.hubapi.com/crm/v3/objects/deals/search', 'Production: HubSpot private-app credential; search deals by createdate / closedate.'),
  liveHttp(N.liveZendesk, [920, 320], 'https://fernhill.zendesk.com/api/v2/search.json?query=type:ticket', 'Production: Zendesk API token; tickets created in the window with metrics sideloaded.'),
  liveHttp(N.liveLinear, [1140, 320], 'https://api.linear.app/graphql', 'Production: Linear API key; issues created/completed in the window with labels and priority.'),
  liveHttp(N.liveGithub, [1360, 320], 'https://api.github.com/repos/fernhill/dispatch/deployments', 'Production: GitHub token; deployments + statuses for environment=production.'),
  node(N.compute, 'n8n-nodes-base.code', 2, [1600, 100], { jsCode: computeCode }),
  chain(N.chain1, [1840, 100], '={{ $json.prompt }}'),
  model(N.model1, [1840, 320]),
  node(N.check1, 'n8n-nodes-base.code', 2, [2100, 100], { jsCode: check1Code }),
  ifNode(N.passed, [2340, 100], '={{ $json.ok }}', { type: 'boolean', operation: 'true', singleValue: true }, ''),
  chain(N.chain2, [2580, 300], '={{ $json.retry_prompt }}'),
  model(N.model2, [2580, 520]),
  node(N.check2, 'n8n-nodes-base.code', 2, [2820, 300], { jsCode: check2Code }),
  node(N.finalize, 'n8n-nodes-base.code', 2, [3060, 100], { jsCode: finalizeCode }),
  slackPost(N.dm, [3300, 0], "'@owen'", `$json.report_markdown`),
  slackLive(N.dmLive, [3300, -200], '@owen', '={{ $json.report_markdown }}'),
  ifNode(N.fromWebhook, [3540, 0], `={{ $('${N.resolve}').first().json.trigger }}`, { type: 'string', operation: 'equals' }, 'webhook'),
  node(N.respond, 'n8n-nodes-base.respondToWebhook', 1.4, [3780, -100], {
    respondWith: 'json',
    responseBody: `={{ JSON.stringify({ ...$('${N.finalize}').first().json, execution_id: $execution.id, approve_url: $execution.resumeUrl, how_to_approve: 'POST {"approved": true, "approver": "owen"} to approve_url with the X-Approval-Token header. Anything else, or no answer in 48 hours, means #all-hands is not posted.' }) }}`,
    options: {},
  }),
  node(N.wait, 'n8n-nodes-base.wait', 1.1, [4020, 0], {
    resume: 'webhook', httpMethod: 'POST', incomingAuthentication: 'headerAuth',
    limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 48, resumeUnit: 'hours', options: {},
  }, { webhookId: '0a04c0de-0000-4000-8000-00000000a002', credentials: { httpHeaderAuth: { id: ids.approvalCredId, name: 'Approval header (n8n-agents)' } } }),
  node(N.decide, 'n8n-nodes-base.code', 2, [4260, 0], { jsCode: decideCode }),
  ifNode(N.approved, [4500, 0], '={{ $json.post }}', { type: 'boolean', operation: 'true', singleValue: true }, ''),
  slackPost(N.post, [4740, -100], "'#all-hands'", '$json.text'),
  slackLive(N.postLive, [4740, -300], '#all-hands', '={{ $json.text }}'),
  node(N.notPosted, 'n8n-nodes-base.noOp', 1, [4740, 120], {}),
];

const main = (...targets) => targets.map((t) => (Array.isArray(t) ? t : [t]).map((name) => ({ node: name, type: 'main', index: 0 })));
const connections = {
  [N.schedule]: { main: main(N.resolve) },
  [N.webhook]: { main: main(N.resolve) },
  [N.resolve]: { main: main(N.stripe) },
  [N.stripe]: { main: main(N.hubspot) },
  [N.hubspot]: { main: main(N.zendesk) },
  [N.zendesk]: { main: main(N.linear) },
  [N.linear]: { main: main(N.github) },
  [N.github]: { main: main(N.compute) },
  [N.compute]: { main: main(N.chain1) },
  [N.chain1]: { main: main(N.check1) },
  [N.model1]: { ai_languageModel: [[{ node: N.chain1, type: 'ai_languageModel', index: 0 }]] },
  [N.check1]: { main: main(N.passed) },
  [N.passed]: { main: main(N.finalize, N.chain2) },
  [N.chain2]: { main: main(N.check2) },
  [N.model2]: { ai_languageModel: [[{ node: N.chain2, type: 'ai_languageModel', index: 0 }]] },
  [N.check2]: { main: main(N.finalize) },
  [N.finalize]: { main: [[{ node: N.dm, type: 'main', index: 0 }, { node: N.dmLive, type: 'main', index: 0 }]] },
  [N.dm]: { main: main(N.fromWebhook) },
  [N.fromWebhook]: { main: main(N.respond, N.wait) },
  [N.respond]: { main: main(N.wait) },
  [N.wait]: { main: main(N.decide) },
  [N.decide]: { main: main(N.approved) },
  [N.approved]: { main: [[{ node: N.post, type: 'main', index: 0 }, { node: N.postLive, type: 'main', index: 0 }], [{ node: N.notPosted, type: 'main', index: 0 }]] },
};

const workflow = {
  name: naive ? 'Ops Report - Fernhill (NAIVE regression variant)' : 'Ops Report - Fernhill',
  nodes, connections,
  settings: { executionOrder: 'v1', timezone: 'America/New_York', saveManualExecutions: true, saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveExecutionProgress: true },
};
const out = arg('out', join(HERE, 'workflow', naive ? 'ops-report.naive.json' : 'ops-report.json'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
console.log(`wrote ${out} (${nodes.length} nodes incl. sticky note, variant=${variant}, mock=${MOCK})`);
export { N };
