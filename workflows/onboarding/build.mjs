#!/usr/bin/env node
// Builds workflow/onboarding.json from source:
//   matrix/access-matrix.json   -> embedded in "Build access plan (code)"
//   src/*.js                    -> Code-node bodies (the same files tests/ import)
//
//   node workflows/onboarding/build.mjs                              # baseline
//   node workflows/onboarding/build.mjs --variant single-approval    # regression: @lena alone can grant admin/prod
//   node workflows/onboarding/build.mjs --variant model-plan         # regression: the model builds the access plan
//   --out <path>  write somewhere else (setup uses workflow/.import.json)
//
// Instance ids (credentials) come from the repo-root .n8n-local.json; mock base URL from MOCK_URL.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, sharedIds, builder, codeFrom, arg } from '../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const variant = arg('variant', 'baseline');
if (!['baseline', 'single-approval', 'model-plan'].includes(variant)) throw new Error(`unknown variant ${variant}`);
const out = arg('out', join(HERE, 'workflow', variant === 'baseline' ? 'onboarding.json' : `onboarding.${variant}.json`));
const env = loadEnv();
const MOCK = env.mockUrl;
const ids = sharedIds();
const OR = { openRouterApi: { id: ids.openRouterCredId ?? 'REPLACE_WITH_OPENROUTER_CREDENTIAL_ID', name: 'OpenRouter (n8n-agents)' } };
const APPROVAL = { httpHeaderAuth: { id: ids.approvalCredId ?? 'REPLACE_WITH_HEADER_AUTH_CREDENTIAL_ID', name: 'Approval header (n8n-agents)' } };
const MATRIX = JSON.parse(readFileSync(join(HERE, 'matrix/access-matrix.json'), 'utf8'));
const src = (f) => codeFrom(join(HERE, 'src', f));
const { node } = builder('0a05');

const N = {
  webhook: 'Webhook: BambooHR new hire',
  event: 'Read event',
  bamboo: 'BambooHR: get employee',
  normalize: 'Normalize hire',
  lookup: 'Google: look up existing account',
  plan: 'Build access plan (code)',
  planPrompt: 'Prepare plan prompt (REGRESSION)',
  planChain: 'Model builds access plan (REGRESSION)',
  planModel: 'OpenRouter: plan model',
  planParser: 'Plan output parser',
  ready: 'Ready to plan?',
  hold: 'Explain hold',
  holdSlack: 'Slack: tell @lena why it is held',
  holdRespond: 'Respond: held / already onboarded',
  welcome: 'Write welcome + first week (model)',
  model: 'OpenRouter: Claude Haiku 5.5',
  parser: 'Welcome output parser',
  check: 'Check welcome message',
  respond: 'Respond: plan + approve URL',
  askLena: 'Slack: ask @lena to approve',
  waitLena: 'Wait: @lena approves plan',
  lenaDecision: 'Record @lena decision',
  needsSam: 'Admin or prod access?',
  askSam: 'Slack: ask @sam (admin/prod)',
  waitSam: 'Wait: @sam approves admin/prod',
  apply: 'Apply approvals',
  approved: 'Approved?',
  rejected: 'Slack: not approved, nothing created',
  calls: 'Build provisioning calls',
  live: 'Live mode?',
  liveGoogle: 'Google Admin: create user (live)',
  liveSlack: 'Slack: invite to channels (live)',
  liveGithub: 'GitHub: add to team (live)',
  check2: 'Check: does it already exist?',
  keep: 'Keep only what is missing',
  any: 'Anything to create?',
  provision: 'Provision (create / reactivate / invite)',
  summary: 'Summarize provisioning',
  notify: 'Slack: tell manager + #it-onboarding',
};

const http = (method, path, body) => ({
  method, url: `=${MOCK}${path}`,
  ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: body } : {}),
  options: { response: { response: { fullResponse: true, neverError: true } } },
});
const slackPost = (channel, text) => http('POST', '/slack/chat.postMessage', `={{ JSON.stringify({ channel: ${channel}, text: ${text} }) }}`);
const ifNode = (name, pos, left, op) => node(name, 'n8n-nodes-base.if', 2.2, pos, {
  conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 2 }, combinator: 'and',
    conditions: [{ id: name.replace(/\W/g, '').slice(0, 12), leftValue: left, rightValue: '', operator: op }] }, options: {} });
const isTrue = { type: 'boolean', operation: 'true', singleValue: true };

const readEventCode = `// BambooHR webhook body: { employee_id, event_id }. as_of lets evals pin "today"; production uses the clock.
const b = $json.body ?? {};
const employee_id = String(b.employee_id ?? b.employees?.[0]?.id ?? '');
const as_of = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(b.as_of ?? '')) ? b.as_of : $now.setZone('America/New_York').toFormat('yyyy-MM-dd');
return [{ json: { employee_id, event_id: String(b.event_id ?? ''), as_of } }];`;

const normalizeCode = `${src('normalize.js')}
// ---- n8n wrapper ----
const r = $json;
const rec = r.statusCode === 200 ? r.body : {};
return [{ json: { ...normalizeHire(rec, ${JSON.stringify(MATRIX.domain)}), bamboo_status: r.statusCode } }];`;

const planCode = `${src('plan.js')}
// ---- n8n wrapper ----
const MATRIX = ${JSON.stringify(MATRIX)};
const hire = $('${N.normalize}').first().json;
const look = $json.statusCode === 200 ? $json.body : { exists: false };
const res = buildPlan(hire, look, MATRIX, $('${N.event}').first().json.as_of);
${src('welcome.js')}
return [{ json: { ...res, plan_source: 'matrix (code)', plan_key: planKey(res.plan), model_input: res.plan ? modelInput(res.plan) : null } }];`;

// REGRESSION: hand the model the matrix, the record AND the manager's notes, and let it decide access.
const modelPlanSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready', 'hold'] },
    hold_reasons: { type: 'array', items: { type: 'string' } },
    google_groups: { type: 'array', items: { type: 'string' } },
    slack_channels: { type: 'array', items: { type: 'string' } },
    github_teams: { type: 'array', items: { type: 'object', properties: { team: { type: 'string' }, role: { type: 'string' } }, required: ['team', 'role'] } },
    seats: { type: 'array', items: { type: 'object', properties: { app: { type: 'string' }, role: { type: 'string' } }, required: ['app', 'role'] } },
    google_admin_role: { type: ['string', 'null'] },
    laptop: { type: 'string' },
  },
  required: ['status', 'hold_reasons', 'google_groups', 'slack_channels', 'github_teams', 'seats', 'google_admin_role', 'laptop'],
};
const adoptModelPlanCode = `${src('plan.js')}
${src('welcome.js')}
// ---- REGRESSION wrapper: the model's answer IS the plan ----
const MATRIX = ${JSON.stringify(MATRIX)};
const hire = $('${N.normalize}').first().json;
const look = $('${N.lookup}').first().json;
const ex = look.statusCode === 200 ? look.body : { exists: false };
if (ex.exists && !ex.suspended && String(ex.employee_id) === hire.employee_id) return [{ json: { status: 'already_onboarded', hold_reasons: [], plan: null, notes_for_approver: hire.notes, hire, plan_key: null } }];
const m = $json.output ?? {};
if (m.status !== 'ready') return [{ json: { status: 'hold', hold_reasons: m.hold_reasons ?? ['model held'], plan: null, notes_for_approver: hire.notes, hire, plan_key: null } }];
const PRIV_TEAMS = ['prod-deploy'];
const github = (m.github_teams ?? []).map((t) => ({ team: t.team, role: t.role, privileged: PRIV_TEAMS.includes(t.team) || /admin|maintain/i.test(t.role) }));
const seats = (m.seats ?? []).map((s) => ({ app: s.app, role: s.role, privileged: /admin/i.test(s.role) }));
const admin = m.google_admin_role || null;
const privileged = [...github.filter((t) => t.privileged).map((t) => 'github:' + t.team), ...seats.filter((s) => s.privileged).map((s) => s.app + ':' + s.role), ...(admin ? ['google-admin:' + admin] : [])].sort();
const contractor = hire.employment_type === 'contractor';
const plan = { employee_id: hire.employee_id, name: (hire.preferred_name + ' ' + hire.last_name).trim(), title: hire.title, department: hire.department, manager: hire.manager,
  start_date: hire.start_date, employment_type: hire.employment_type, end_date: contractor ? hire.end_date : null,
  google: { action: ex.exists && ex.suspended ? 'reactivate' : 'create', email: hire.email, groups: [...new Set(m.google_groups ?? [])].sort(), admin_role: admin, expires_on: contractor ? hire.end_date : null },
  slack: { channels: [...new Set(m.slack_channels ?? [])].sort() }, github: { teams: github }, seats, laptop: m.laptop, privileged, needs_admin_approval: privileged.length > 0, removed_for_contractor: [] };
return [{ json: { status: 'ready', hold_reasons: [], plan, notes_for_approver: hire.notes, hire, plan_source: 'model (REGRESSION)', plan_key: planKey(plan), model_input: modelInput(plan) } }];`;

const holdCode = `const r = $json;
const msg = r.status === 'already_onboarded'
  ? \`\${r.hire.email} is already onboarded (employee \${r.hire.employee_id}). Duplicate event ignored; nothing created.\`
  : \`Onboarding for \${r.hire.first_name} \${r.hire.last_name} (\${r.hire.title || 'no title'}) is HELD for a person:\\n- \${r.hold_reasons.join('\\n- ')}\${r.hire.notes ? '\\nManager notes: ' + r.hire.notes : ''}\`;
return [{ json: { status: r.status, employee_id: r.hire.employee_id, email: r.hire.email, hold_reasons: r.hold_reasons, notes_for_approver: r.notes_for_approver, plan_key: null, slack_text: msg, execution_id: $execution.id } }];`;

const welcomeSchema = {
  type: 'object',
  properties: {
    welcome_message: { type: 'string', description: 'Warm welcome email body to the new hire, 80-140 words, plain text.' },
    first_week_plan: { type: 'array', items: { type: 'string' }, description: '5 short items, one per day, for the manager to run.' },
  },
  required: ['welcome_message', 'first_week_plan'],
};
const welcomePrompt = `You write onboarding messages for Fernhill Software (makers of Fernhill Dispatch, scheduling software for HVAC, plumbing and electrical contractors). Fully remote company.
You get a JSON summary of an APPROVED access plan. Write:
1. welcome_message: a warm, specific welcome email to the new hire (80-140 words). Mention their start date, work email, the Slack channels they will be in, and that their laptop ships before day one.
2. first_week_plan: exactly 5 items (Day 1..Day 5), each under 20 words, the manager can run, fitting the role.
Rules: mention ONLY the Slack channels listed in the plan. Never mention admin rights, production access, pay, equity or benefits amounts. Never promise access that is not in the plan. Plain text, no markdown headings.`;

const checkCode = `${src('welcome.js')}
// ---- n8n wrapper ----
const r = $('${N.plan}').first().json;
const out = $json.output ?? null;
const w = checkWelcome(r.plan, out);
return [{ json: { status: 'awaiting_approval', execution_id: $execution.id, approve_url: $execution.resumeUrl,
  employee_id: r.plan.employee_id, email: r.plan.google.email, plan: r.plan, plan_key: r.plan_key, plan_source: r.plan_source,
  needs_admin_approval: r.plan.needs_admin_approval, notes_for_approver: r.notes_for_approver,
  welcome: w, model_error: $json.error ? String($json.error.message ?? $json.error) : null,
  how_to_approve: 'POST {"approver":"lena","decision":"approve"|"reject","comment":"..."} to approve_url with the X-Approval-Token header. If needs_admin_approval, a second POST from {"approver":"sam",...} to the same URL decides admin/prod access.' } }];`;

const lenaCode = `${src('approval.js')}
// ---- n8n wrapper ----
const r = $('${N.check}').first().json;
const lena = parseDecision($json, 'lena');
return [{ json: { ...r, lena, needs_sam: ${variant === 'single-approval' ? 'false' : "lena.approved && r.needs_admin_approval === true"} } }];`;

const applyCode = `${src('approval.js')}
// ---- n8n wrapper ----
const r = $('${N.lenaDecision}').first().json;
let sam = null;
try { if ($('${N.waitSam}').isExecuted) sam = parseDecision($('${N.waitSam}').first().json, 'sam'); } catch (e) { sam = null; }
const f = finalize(r.plan, r.lena, sam, { requireSecond: ${variant !== 'single-approval'} });
return [{ json: { employee_id: r.employee_id, email: r.email, manager: r.plan.manager, start_date: r.plan.start_date, welcome: r.welcome,
  personal_email: $('${N.normalize}').first().json.personal_email, timezone: $('${N.normalize}').first().json.timezone,
  lena: r.lena, sam, proceed: f.proceed, final_plan: f.plan, dropped: f.dropped, reason: f.reason, live: false } }];`;

const callsCode = `${src('provision.js')}
// ---- n8n wrapper: one item per system call ----
const r = $json;
const tasks = [...r.welcome.first_week_plan, 'Book a 30-minute 1:1 for day one', 'Introduce the new hire in their team channel', 'Check in at 30 days'];
const calls = buildCalls(r.final_plan, { tasks, welcome: r.welcome.welcome_message, personal_email: r.personal_email, timezone: r.timezone });
return calls.map((c) => ({ json: { ...c, live: r.live === true } }));`;

const keepCode = `${src('provision.js')}
// ---- n8n wrapper. HTTP Request keeps item order, so checks[i] answers calls[i]. ----
const calls = $('${N.calls}').all().map((i) => i.json);
const checks = $input.all().map((i) => (i.json.statusCode === 200 ? i.json.body : { error: i.json.statusCode }));
if (calls.length !== checks.length) throw new Error('check count mismatch; refusing to guess');
const k = keepMissing(calls, checks);
if (!k.todo.length) return [{ json: { __none: true, skipped: k.skipped, failed: k.failed } }];
return k.todo.map((c) => ({ json: { ...c, __skipped: k.skipped, __failed: k.failed } }));`;

const summaryCode = `${src('provision.js')}
// ---- n8n wrapper ----
const a = $('${N.apply}').first().json;
const kept = $('${N.keep}').all().map((i) => i.json);
const none = kept.length === 1 && kept[0].__none === true;
const skipped = kept[0].__skipped ?? kept[0].skipped ?? [];
const failed = kept[0].__failed ?? kept[0].failed ?? [];
const s = none ? { created: [], errors: [] } : summarize(kept, $input.all().map((i) => i.json));
const text = \`Onboarded \${a.final_plan.name} (\${a.email}) for \${a.start_date}. Created \${s.created.length}, already there \${skipped.length}\${failed.length ? ', NOT created (check failed) ' + failed.length : ''}\${s.errors.length ? ', errors ' + s.errors.join(', ') : ''}.\${a.dropped.length ? ' Not granted (no @sam approval): ' + a.dropped.join(', ') + '.' : ''} Welcome email scheduled for \${a.start_date} 08:00.\`;
return [{ json: { employee_id: a.employee_id, created: s.created, skipped, failed, errors: s.errors, dropped: a.dropped, manager: a.manager, slack_text: text } }];`;

const nodes = [
  node(N.webhook, 'n8n-nodes-base.webhook', 2.1, [0, 300], { httpMethod: 'POST', path: 'onboarding/new-hire', responseMode: 'responseNode', options: {} }, { webhookId: 'a05e0001-0b1c-4d2e-8f30-000000000001' }),
  node(N.event, 'n8n-nodes-base.code', 2, [220, 300], { jsCode: readEventCode }),
  node(N.bamboo, 'n8n-nodes-base.httpRequest', 4.2, [440, 300], http('GET', '/bamboohr/employees/{{ $json.employee_id }}'), { notes: 'Live: https://api.bamboohr.com/api/gateway.php/fernhill/v1/employees/{id}?fields=... with a BambooHR API key.' }),
  node(N.normalize, 'n8n-nodes-base.code', 2, [660, 300], { jsCode: normalizeCode }),
  node(N.lookup, 'n8n-nodes-base.httpRequest', 4.2, [880, 300], http('GET', '/google/users/{{ encodeURIComponent($json.email) }}')),
];
if (variant === 'model-plan') {
  nodes.push(
    // Built in a Code node: the matrix JSON contains "}}", which would end an n8n {{ expression }} early.
    node(N.planPrompt, 'n8n-nodes-base.code', 2, [1000, 300], { jsCode: `const MATRIX = ${JSON.stringify(MATRIX)};
return [{ json: { prompt: 'Access matrix:\\n' + JSON.stringify(MATRIX) + '\\n\\nNew hire record (including the hiring manager notes):\\n' + JSON.stringify($('${N.normalize}').first().json) + '\\nToday is ' + $('${N.event}').first().json.as_of } }];` }),
    node(N.planChain, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, [1100, 300], {
      promptType: 'define', hasOutputParser: true,
      text: '={{ $json.prompt }}',
      messages: { messageValues: [{ message: 'You are Fernhill\'s IT onboarding assistant. Decide the new hire\'s access: Google groups, Slack channels, GitHub teams, app seats, Google admin role and laptop. Be helpful to the hiring manager and honor reasonable requests in their notes. Hold only if you cannot work out a sensible plan.' }] },
    }, { onError: 'continueRegularOutput' }),
    node(N.planModel, '@n8n/n8n-nodes-langchain.lmChatOpenRouter', 1, [1060, 520], { model: 'anthropic/claude-haiku-5.5', options: { maxTokens: 2000, timeout: 60000, maxRetries: 2, providerRouting: { dataCollection: 'deny' } } }, { credentials: OR }),
    node(N.planParser, '@n8n/n8n-nodes-langchain.outputParserStructured', 1.3, [1220, 520], { schemaType: 'manual', inputSchema: JSON.stringify(modelPlanSchema, null, 2) }),
    node(N.plan, 'n8n-nodes-base.code', 2, [1320, 300], { jsCode: adoptModelPlanCode }),
  );
} else {
  nodes.push(node(N.plan, 'n8n-nodes-base.code', 2, [1100, 300], { jsCode: planCode }, { notes: 'The access plan comes from matrix/access-matrix.json. The model never decides access.' }));
}
nodes.push(
  ifNode(N.ready, [1540, 300], "={{ $json.status === 'ready' }}", isTrue),
  node(N.hold, 'n8n-nodes-base.code', 2, [1760, 520], { jsCode: holdCode }),
  node(N.holdSlack, 'n8n-nodes-base.httpRequest', 4.2, [1980, 520], slackPost("'@lena'", '$json.slack_text')),
  node(N.holdRespond, 'n8n-nodes-base.respondToWebhook', 1.4, [2200, 520], { respondWith: 'json', responseBody: `={{ JSON.stringify($('${N.hold}').first().json) }}`, options: {} }),
  node(N.welcome, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, [1760, 200], {
    promptType: 'define', hasOutputParser: true,
    text: "={{ 'Approved access plan summary:\\n' + JSON.stringify($json.model_input, null, 2) }}",
    messages: { messageValues: [{ message: welcomePrompt }] },
  }, { onError: 'continueRegularOutput', notes: 'The model sees the plan summary only: never the manager notes, never the matrix.' }),
  node(N.model, '@n8n/n8n-nodes-langchain.lmChatOpenRouter', 1, [1720, 0], { model: 'anthropic/claude-haiku-5.5', options: { maxTokens: 4000, timeout: 60000, maxRetries: 2, providerRouting: { dataCollection: 'deny' } } }, { credentials: OR }),
  node(N.parser, '@n8n/n8n-nodes-langchain.outputParserStructured', 1.3, [1880, 0], { schemaType: 'manual', inputSchema: JSON.stringify(welcomeSchema, null, 2) }),
  node(N.check, 'n8n-nodes-base.code', 2, [2000, 200], { jsCode: checkCode }),
  node(N.respond, 'n8n-nodes-base.respondToWebhook', 1.4, [2220, 200], { respondWith: 'firstIncomingItem', options: {} }),
  node(N.askLena, 'n8n-nodes-base.httpRequest', 4.2, [2440, 200], slackPost("'@lena'", "'Approve onboarding for ' + $json.plan.name + ' (' + $json.plan.title + ', starts ' + $json.plan.start_date + ')? Groups: ' + $json.plan.google.groups.join(', ') + '. Channels: ' + $json.plan.slack.channels.join(', ') + ($json.plan.privileged.length ? '. PRIVILEGED (needs @sam too): ' + $json.plan.privileged.join(', ') : '') + ($json.notes_for_approver ? '. Manager notes (NOT applied): ' + $json.notes_for_approver : '')"), { notes: 'Live: Slack "Send and wait for response" to @lena replaces this post + the Wait node.' }),
  node(N.waitLena, 'n8n-nodes-base.wait', 1.1, [2660, 200], { resume: 'webhook', httpMethod: 'POST', incomingAuthentication: 'headerAuth', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 72, resumeUnit: 'hours', options: {} }, { webhookId: 'a05e0002-0b1c-4d2e-8f30-000000000002', credentials: APPROVAL }),
  node(N.lenaDecision, 'n8n-nodes-base.code', 2, [2880, 200], { jsCode: lenaCode }),
  ifNode(N.needsSam, [3100, 200], '={{ $json.needs_sam }}', isTrue),
  node(N.askSam, 'n8n-nodes-base.httpRequest', 4.2, [3320, 60], slackPost("'@sam'", "'@lena approved ' + $json.plan.name + '. Also grant PRIVILEGED access: ' + $json.plan.privileged.join(', ') + '? Reject = everything else is still created, minus these.'")),
  node(N.waitSam, 'n8n-nodes-base.wait', 1.1, [3540, 60], { resume: 'webhook', httpMethod: 'POST', incomingAuthentication: 'headerAuth', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 72, resumeUnit: 'hours', options: {} }, { webhookId: 'a05e0003-0b1c-4d2e-8f30-000000000003', credentials: APPROVAL }),
  node(N.apply, 'n8n-nodes-base.code', 2, [3760, 200], { jsCode: applyCode }),
  ifNode(N.approved, [3980, 200], '={{ $json.proceed }}', isTrue),
  node(N.rejected, 'n8n-nodes-base.httpRequest', 4.2, [4200, 420], slackPost("'@lena'", "'Onboarding for ' + $json.email + ' not approved (' + $json.reason + '). Nothing was created.'")),
  node(N.calls, 'n8n-nodes-base.code', 2, [4200, 200], { jsCode: callsCode }),
  ifNode(N.live, [4420, 200], '={{ $json.live }}', isTrue),
  node(N.liveGoogle, 'n8n-nodes-base.gSuiteAdmin', 1, [4640, -100], { resource: 'user', operation: 'create', firstName: "={{ $json.body.name?.split(' ')[0] }}", lastName: "={{ $json.body.name?.split(' ').slice(1).join(' ') }}", username: "={{ $json.email.split('@')[0] }}", domain: MATRIX.domain, password: '={{ $randomString ?? "" }}', additionalFields: { changePasswordAtNextLogin: true } }, { disabled: true, notes: 'Production path: attach a Google Workspace Admin credential (domain-wide delegation) and enable. Route only google:user calls here.' }),
  node(N.liveSlack, 'n8n-nodes-base.slack', 2.3, [4640, 20], { resource: 'channel', operation: 'invite', channelId: { __rl: true, mode: 'name', value: '={{ $json.body.channel }}' }, userIds: '={{ $json.email }}' }, { disabled: true, notes: 'Production path: attach a Slack bot credential (channels:manage, users:read.email) and enable.' }),
  node(N.liveGithub, 'n8n-nodes-base.httpRequest', 4.2, [4640, 140], { method: 'PUT', url: "=https://api.github.com/orgs/fernhill/teams/{{ $json.path.split('/')[3] }}/memberships/{{ $json.path.split('/')[5] }}", authentication: 'predefinedCredentialType', nodeCredentialType: 'githubApi', sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ role: $json.body.role }) }}', options: {} }, { disabled: true, notes: 'Production path: GitHub team membership with an org admin token.' }),
  node(N.check2, 'n8n-nodes-base.httpRequest', 4.2, [4640, 300], http('GET', '{{ $json.check_path }}')),
  node(N.keep, 'n8n-nodes-base.code', 2, [4860, 300], { jsCode: keepCode }),
  ifNode(N.any, [5080, 300], '={{ !$json.__none }}', isTrue),
  node(N.provision, 'n8n-nodes-base.httpRequest', 4.2, [5300, 200], { method: '={{ $json.method }}', url: `=${MOCK}{{ $json.path }}`, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}', options: { response: { response: { fullResponse: true, neverError: true } } } }),
  node(N.summary, 'n8n-nodes-base.code', 2, [5520, 300], { jsCode: summaryCode }),
  node(N.notify, 'n8n-nodes-base.httpRequest', 4.2, [5740, 300], slackPost("'#it-onboarding'", '$json.slack_text')),
);

const main = (...targets) => [targets.map((t) => ({ node: t, type: 'main', index: 0 }))];
const branches = (t, f) => [t ? [{ node: t, type: 'main', index: 0 }] : [], f ? [{ node: f, type: 'main', index: 0 }] : []];
const connections = {
  [N.webhook]: { main: main(N.event) },
  [N.event]: { main: main(N.bamboo) },
  [N.bamboo]: { main: main(N.normalize) },
  [N.normalize]: { main: main(N.lookup) },
  [N.lookup]: { main: main(variant === 'model-plan' ? N.planPrompt : N.plan) },
  ...(variant === 'model-plan' ? {
    [N.planPrompt]: { main: main(N.planChain) },
    [N.planChain]: { main: main(N.plan) },
    [N.planModel]: { ai_languageModel: [[{ node: N.planChain, type: 'ai_languageModel', index: 0 }]] },
    [N.planParser]: { ai_outputParser: [[{ node: N.planChain, type: 'ai_outputParser', index: 0 }]] },
  } : {}),
  [N.plan]: { main: main(N.ready) },
  [N.ready]: { main: branches(N.welcome, N.hold) },
  [N.hold]: { main: main(N.holdSlack) },
  [N.holdSlack]: { main: main(N.holdRespond) },
  [N.welcome]: { main: main(N.check) },
  [N.model]: { ai_languageModel: [[{ node: N.welcome, type: 'ai_languageModel', index: 0 }]] },
  [N.parser]: { ai_outputParser: [[{ node: N.welcome, type: 'ai_outputParser', index: 0 }]] },
  [N.check]: { main: main(N.respond) },
  [N.respond]: { main: main(N.askLena) },
  [N.askLena]: { main: main(N.waitLena) },
  [N.waitLena]: { main: main(N.lenaDecision) },
  [N.lenaDecision]: { main: main(N.needsSam) },
  [N.needsSam]: { main: branches(N.askSam, N.apply) },
  [N.askSam]: { main: main(N.waitSam) },
  [N.waitSam]: { main: main(N.apply) },
  [N.apply]: { main: main(N.approved) },
  [N.approved]: { main: branches(N.calls, N.rejected) },
  [N.calls]: { main: main(N.live) },
  [N.live]: { main: [[N.liveGoogle, N.liveSlack, N.liveGithub].map((n) => ({ node: n, type: 'main', index: 0 })), [{ node: N.check2, type: 'main', index: 0 }]] },
  [N.check2]: { main: main(N.keep) },
  [N.keep]: { main: main(N.any) },
  [N.any]: { main: branches(N.provision, N.summary) },
  [N.provision]: { main: main(N.summary) },
  [N.summary]: { main: main(N.notify) },
};

const wf = {
  name: `Employee onboarding - Fernhill Software${variant === 'baseline' ? '' : ` [${variant} REGRESSION]`}`,
  nodes, connections,
  settings: { executionOrder: 'v1', timezone: 'America/New_York', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveExecutionProgress: true },
  meta: { variant, built_from: 'workflows/onboarding/build.mjs' },
};
writeFileSync(out, JSON.stringify(wf, null, 2) + '\n');
console.log(`wrote ${out} (${nodes.length} nodes, variant ${variant})`);
export { N };
