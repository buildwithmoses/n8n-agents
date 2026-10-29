#!/usr/bin/env node
// Builds the n8n workflow JSON from this folder's source files:
//   src/*.js        -> Code node bodies (the same files the tests import)
//   prompts/*.md    -> the extraction prompt
//
//   node workflows/invoice-processor/build.mjs                         # baseline -> workflow/invoice-processor.json
//   node workflows/invoice-processor/build.mjs --variant trust-model   # regression: the model decides, code checks removed
//   ... --out path.json
// Credential ids come from the repo-root .n8n-local.json (npm run setup:shared). Mock base URL from MOCK_URL.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, sharedIds, builder, codeFrom, arg } from '../../lib/n8n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SLUG = 'invoice-processor';
export const VARIANTS = ['baseline', 'trust-model', 'no-bank-check'];

export function buildWorkflow({ variant = 'baseline', mockUrl, ids = {} } = {}) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant}`);
  const trust = variant === 'trust-model';
  const noBank = variant === 'no-bank-check';
  const MOCK = (mockUrl ?? 'http://host.docker.internal:4610').replace(/\/$/, '');
  const cred = {
    openRouter: { openRouterApi: { id: ids.openRouterCredId ?? 'REPLACE_WITH_OPENROUTER_CREDENTIAL_ID', name: 'OpenRouter (n8n-agents)' } },
    approval: { httpHeaderAuth: { id: ids.approvalCredId ?? 'REPLACE_WITH_HEADER_AUTH_CREDENTIAL_ID', name: 'Approval header (n8n-agents)' } },
  };
  const { node } = builder('0a02');
  const code = (f) => codeFrom(join(HERE, 'src', f));
  const N = {
    webhook: 'Webhook: POST /invoice-processor',
    gmail: 'Gmail Trigger: ap@ inbox (live)',
    normalize: 'Normalize invoice email',
    toFile: 'PDF base64 to file',
    extract: 'Extract text from PDF',
    prep: 'Prep document',
    vendors: 'QuickBooks: vendors',
    pos: 'QuickBooks: purchase orders',
    bills: 'QuickBooks: existing bills',
    chain: 'Read invoice (Basic LLM Chain)',
    model: 'OpenRouter: Claude Haiku 5.5',
    parser: 'Structured Output Parser',
    checks: trust ? 'Model assessment decides (REGRESSION)' : noBank ? 'AP checks, no bank check (REGRESSION)' : 'AP checks (code, not the model)',
    blocked: 'Fraud hold or duplicate?',
    alert: 'Slack: #ap-alerts hold notice',
    heldWebhook: 'Came from webhook? (held)',
    respondHeld: 'Respond: held',
    liveMarcus: 'Live Gmail run?',
    slackMarcusLive: 'Slack: ask @marcus and wait (live)',
    slackMarcus: 'Slack: ask @marcus',
    respondWaiting: 'Respond: awaiting approval',
    waitMarcus: 'Wait for @marcus',
    applyMarcus: 'Apply @marcus decision',
    marcusOk: '@marcus approved?',
    notApproved: 'Slack: not approved, no bill',
    needsOwen: 'Over $10,000? (needs @owen)',
    liveOwen: 'Live run? (owen)',
    slackOwenLive: 'Slack: ask @owen and wait (live)',
    slackOwen: 'Slack: ask @owen',
    waitOwen: 'Wait for @owen',
    applyOwen: 'Apply @owen decision',
    owenOk: '@owen approved?',
    buildBill: 'Build QuickBooks bill',
    liveQb: 'Live QuickBooks?',
    qbLive: 'QuickBooks: create bill (live)',
    qbMock: 'QuickBooks: create bill',
    created: 'Slack: bill entered',
  };

  const ifNode = (name, pos, leftValue, operator, rightValue = '') => node(name, 'n8n-nodes-base.if', 2.2, pos, {
    conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: 'c1', leftValue, rightValue, operator }] }, options: {},
  });
  const isTrue = { type: 'boolean', operation: 'true', singleValue: true };
  const isGmail = { type: 'string', operation: 'equals' };
  const get = (name, pos, path) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, { method: 'GET', url: `${MOCK}${path}`, options: {} });
  const post = (name, pos, path, jsonBody, extra = {}) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos,
    { method: 'POST', url: `${MOCK}${path}`, sendBody: true, specifyBody: 'json', jsonBody, options: {} }, extra);
  const slack = (name, pos, channel, textExpr) => post(name, pos, '/slack/chat.postMessage',
    `={{ JSON.stringify({ channel: '${channel}', text: ${textExpr}, metadata: { workflow: 'invoice-processor', invoice_id: $('${N.checks}').first().json.invoice_id, status: $('${N.checks}').first().json.status } }) }}`);
  const respondBody = `={{ JSON.stringify((({ approve_url, ...r }) => ({ ...r, approve_url: r.blocked ? null : approve_url }))($('${N.checks}').first().json)) }}`;

  const schema = {
    type: 'object',
    properties: {
      vendor_name: { type: 'string' }, invoice_number: { type: 'string' }, invoice_date: { type: 'string' }, due_date: { type: 'string' },
      po_number: { type: 'string' }, currency: { type: 'string' },
      line_items: { type: 'array', items: { type: 'object', properties: {
        description: { type: 'string' }, quantity: { type: ['number', 'null'] }, unit_price: { type: ['number', 'null'] }, amount: { type: ['number', 'null'] },
      }, required: ['description', 'quantity', 'unit_price', 'amount'] } },
      subtotal: { type: ['number', 'null'] }, tax: { type: ['number', 'null'] }, total: { type: ['number', 'null'] },
      remit_to: { type: 'object', properties: { bank_name: { type: 'string' }, routing_number: { type: 'string' }, account_number: { type: 'string' } }, required: ['bank_name', 'routing_number', 'account_number'] },
      notes_in_document: { type: 'string', description: 'Any notes, instructions or bank-change notices printed on the invoice, copied verbatim. Empty if none.' },
      ...(trust ? { assessment: { type: 'object', properties: {
        status: { type: 'string', enum: ['ready_for_approval', 'needs_review', 'duplicate', 'fraud_hold'] },
        issues: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' },
      }, required: ['status', 'issues', 'reason'] } } : {}),
    },
    required: ['vendor_name', 'invoice_number', 'invoice_date', 'due_date', 'po_number', 'line_items', 'subtotal', 'tax', 'total', 'remit_to', 'notes_in_document', ...(trust ? ['assessment'] : [])],
  };

  const P = `$('${N.prep}').first().json`;
  const chainText = `=<invoice_pdf filename="{{ ${P}.filename }}">\n{{ ${P}.pdf_text }}\n</invoice_pdf>\n\nEmail from: {{ ${P}.from }}\nSubject: {{ ${P}.subject }}`
    + (trust ? `\n\n<quickbooks>\n{{ JSON.stringify({ vendors: $('${N.vendors}').first().json.vendors, purchase_orders: $('${N.pos}').first().json.purchase_orders, bills: $('${N.bills}').first().json.bills }) }}\n</quickbooks>` : '');

  const normalizeCode = `${code('normalize.js')}
// ---- n8n wrapper: one invoice per execution (each needs its own approval wait) ----
const items = $input.all();
const out = [];
for (let i = 0; i < items.length; i++) {
  const item = items[i]; const j = item.json;
  let raw; let source; let b64 = '';
  if (j.body && j.body.invoice) { source = 'webhook'; raw = j.body.invoice; b64 = String(raw.pdf_base64 ?? ''); }
  else {
    source = 'gmail'; raw = j;
    const key = Object.keys(item.binary ?? {}).find((k) => String(item.binary[k].mimeType ?? '').includes('pdf'));
    if (key) { b64 = (await this.helpers.getBinaryDataBuffer(i, key)).toString('base64'); raw = { ...j, filename: item.binary[key].fileName }; }
  }
  if (!b64) throw new Error('No PDF attachment on this email. Nothing to process.');
  out.push({ json: { ...normalizeInvoiceEmail(raw, source), pdf_base64: b64 } });
}
return out.slice(0, 1);`;

  const prepCode = `// Keep the PDF text, drop the base64 so later nodes stay small.
const meta = $('${N.normalize}').first().json;
const text = String($input.first().json.text ?? '');
const { pdf_base64, ...rest } = meta;
return [{ json: { ...rest, pdf_text: text.slice(0, 20000), pdf_chars: text.length } }];`;

  const checksCode = `${code('checks.js')}
${code('messages.js')}
// ---- n8n wrapper ----
const doc = $('${N.prep}').first().json;
const o = $input.first().json;
const qb = { vendors: $('${N.vendors}').first().json.vendors ?? [], purchase_orders: $('${N.pos}').first().json.purchase_orders ?? [], bills: $('${N.bills}').first().json.bills ?? [] };
const failed = o.output === undefined || o.output === null;
const r = ${trust ? 'trustModel' : 'runChecks'}(doc, failed ? null : o.output, qb, { modelError: failed ? String(o.error?.message ?? o.error ?? 'model returned no output') : undefined${noBank ? ', bankCheck: false' : ''} });
const meta = { invoice_id: doc.invoice_id, from: doc.from, subject: doc.subject, source: doc.source, filename: doc.filename };
return [{ json: { ...r, ...meta, notes_in_document: failed ? '' : String(o.output.notes_in_document ?? ''), variant: '${variant}',
  slack: slackMessages(r, meta), execution_id: $execution.id, approve_url: $execution.resumeUrl } }];`;

  const applyMarcusCode = `${code('decision.js')}
// ---- n8n wrapper ----
const check = $('${N.checks}').first().json;
const d = applyDecision($input.first().json, 'marcus', { live: check.source === 'gmail' });
return [{ json: { ...check, approvals: [d], stage: 'marcus' } }];`;
  const applyOwenCode = `${code('decision.js')}
// ---- n8n wrapper ----
const prev = $('${N.applyMarcus}').first().json;
const d = applyDecision($input.first().json, 'owen', { live: prev.source === 'gmail' });
return [{ json: { ...prev, approvals: [...prev.approvals, d], stage: 'owen' } }];`;
  const billCode = `${code('bill.js')}
// ---- n8n wrapper: throws (and creates nothing) unless every required approver said yes ----
const c = $input.first().json;
return [{ json: { bill: buildBill(c, c.approvals, { from: c.from, invoice_id: c.invoice_id }), source: c.source, invoice_id: c.invoice_id } }];`;

  const waitParams = { resume: 'webhook', httpMethod: 'POST', incomingAuthentication: 'headerAuth', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 72, resumeUnit: 'hours', options: {} };
  const sendAndWait = (name, pos, msgExpr, webhookId) => node(name, 'n8n-nodes-base.slack', 2.3, pos, {
    operation: 'sendAndWait', select: 'channel', channelId: { __rl: true, mode: 'name', value: '#ap-approvals' }, message: msgExpr,
    approvalOptions: { values: { approvalType: 'double', approveLabel: 'Approve bill', disapproveLabel: 'Reject' } },
    options: { limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: 72, resumeUnit: 'hours' } } },
  }, { disabled: true, webhookId, notes: 'Production approval path. Attach a Slack credential and enable. Timeout or Reject = no bill.' });

  const nodes = [
    node(N.webhook, 'n8n-nodes-base.webhook', 2.1, [0, 300], { httpMethod: 'POST', path: 'invoice-processor', responseMode: 'responseNode', options: {} }, { webhookId: '0a020000-1111-4aaa-8000-000000000001' }),
    node(N.gmail, 'n8n-nodes-base.gmailTrigger', 1.3, [0, 520], { pollTimes: { item: [{ mode: 'everyX', value: 15, unit: 'minutes' }] }, simple: false,
      filters: { q: 'to:ap@fernhill.example has:attachment filename:pdf', readStatus: 'unread' }, options: { downloadAttachments: true } },
      { disabled: true, notes: 'Live entry point. Attach a Gmail OAuth2 credential, then enable. The webhook above needs no credentials.' }),
    node(N.normalize, 'n8n-nodes-base.code', 2, [240, 400], { jsCode: normalizeCode }),
    node(N.toFile, 'n8n-nodes-base.convertToFile', 1.1, [460, 400], { operation: 'toBinary', sourceProperty: 'pdf_base64', binaryPropertyName: 'data', options: { fileName: '={{ $json.filename }}', mimeType: 'application/pdf' } }),
    node(N.extract, 'n8n-nodes-base.extractFromFile', 1, [680, 400], { operation: 'pdf', binaryPropertyName: 'data', options: {} }),
    node(N.prep, 'n8n-nodes-base.code', 2, [900, 400], { jsCode: prepCode }),
    get(N.vendors, [1120, 400], '/quickbooks/vendors'),
    get(N.pos, [1340, 400], '/quickbooks/purchaseorders'),
    get(N.bills, [1560, 400], '/quickbooks/bills'),
    node(N.chain, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, [1800, 400], {
      promptType: 'define', text: chainText, hasOutputParser: true,
      messages: { messageValues: [{ message: readFileSync(join(HERE, 'prompts', trust ? 'trust-model.md' : 'extract.md'), 'utf8').trim() }] },
    }, { onError: 'continueRegularOutput' }),
    node(N.model, '@n8n/n8n-nodes-langchain.lmChatOpenRouter', 1, [1760, 640], {
      model: 'anthropic/claude-haiku-5.5', options: { temperature: 0, maxTokens: 2500, timeout: 60000, maxRetries: 4, providerRouting: { dataCollection: 'deny' } },
    }, { credentials: cred.openRouter }),
    node(N.parser, '@n8n/n8n-nodes-langchain.outputParserStructured', 1.3, [1960, 640], { schemaType: 'manual', inputSchema: JSON.stringify(schema, null, 2) }),
    node(N.checks, 'n8n-nodes-base.code', 2, [2100, 400], { jsCode: checksCode }),
    ifNode(N.blocked, [2340, 400], '={{ $json.blocked }}', isTrue),
    slack(N.alert, [2580, 200], '#ap-alerts', `$('${N.checks}').first().json.slack.alert`),
    ifNode(N.heldWebhook, [2800, 200], `={{ $('${N.checks}').first().json.source }}`, { type: 'string', operation: 'notEquals' }, 'gmail'),
    node(N.respondHeld, 'n8n-nodes-base.respondToWebhook', 1.4, [3020, 200], { respondWith: 'json', responseBody: respondBody, options: {} }),
    ifNode(N.liveMarcus, [2580, 560], '={{ $json.source }}', isGmail, 'gmail'),
    sendAndWait(N.slackMarcusLive, [2820, 460], `={{ $json.slack.ask_marcus }}`, '0a020000-1111-4aaa-8000-000000000002'),
    slack(N.slackMarcus, [2820, 680], '#ap-approvals', `$('${N.checks}').first().json.slack.ask_marcus`),
    node(N.respondWaiting, 'n8n-nodes-base.respondToWebhook', 1.4, [3040, 680], { respondWith: 'json', responseBody: respondBody, options: {} }),
    node(N.waitMarcus, 'n8n-nodes-base.wait', 1.1, [3260, 680], waitParams, { webhookId: '0a020000-1111-4aaa-8000-000000000003', credentials: cred.approval }),
    node(N.applyMarcus, 'n8n-nodes-base.code', 2, [3480, 560], { jsCode: applyMarcusCode }),
    ifNode(N.marcusOk, [3700, 560], '={{ $json.approvals[0].approved }}', isTrue),
    slack(N.notApproved, [4900, 900], '#ap-approvals', `'Not approved, no bill entered: ' + $json.invoice_id + ' (' + $json.approvals.map(a => a.reason).join('; ') + ')'`),
    ifNode(N.needsOwen, [3920, 460], `={{ $json.required_approvers.includes('owen') }}`, isTrue),
    ifNode(N.liveOwen, [4140, 300], '={{ $json.source }}', isGmail, 'gmail'),
    sendAndWait(N.slackOwenLive, [4360, 200], `={{ $json.slack.ask_owen }}`, '0a020000-1111-4aaa-8000-000000000004'),
    slack(N.slackOwen, [4360, 400], '#ap-approvals', `$('${N.checks}').first().json.slack.ask_owen`),
    node(N.waitOwen, 'n8n-nodes-base.wait', 1.1, [4580, 400], waitParams, { webhookId: '0a020000-1111-4aaa-8000-000000000005', credentials: cred.approval }),
    node(N.applyOwen, 'n8n-nodes-base.code', 2, [4800, 300], { jsCode: applyOwenCode }),
    ifNode(N.owenOk, [5020, 300], '={{ $json.approvals[1].approved }}', isTrue),
    node(N.buildBill, 'n8n-nodes-base.code', 2, [5240, 560], { jsCode: billCode }),
    ifNode(N.liveQb, [5460, 560], '={{ $json.source }}', isGmail, 'gmail'),
    node(N.qbLive, 'n8n-nodes-base.quickbooks', 1, [5700, 460], {
      resource: 'bill', operation: 'create', VendorRef: '={{ $json.bill.vendor_id }}',
      Line: { values: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: '={{ $json.bill.total }}', Description: '={{ $json.bill.memo }}' }] },
      additionalFields: { DocNumber: '={{ $json.bill.doc_number }}', TxnDate: '={{ $json.bill.txn_date }}', DueDate: '={{ $json.bill.due_date }}' },
    }, { disabled: true, notes: 'Production write. Attach a QuickBooks OAuth2 credential and map the expense account. Creates an open bill; never pays it.' }),
    post(N.qbMock, [5700, 680], '/quickbooks/bills', '={{ JSON.stringify($json.bill) }}'),
    slack(N.created, [5920, 680], '#ap-approvals', `'Bill entered in QuickBooks (open, not paid): ' + $json.bill.id + ' for ' + $('${N.buildBill}').first().json.bill.doc_number`),
  ];

  const c = {};
  const link = (from, to, out = 0) => { c[from] ??= { main: [] }; while (c[from].main.length <= out) c[from].main.push([]); c[from].main[out].push({ node: to, type: 'main', index: 0 }); };
  const ai = (from, to, type) => { c[from] ??= {}; (c[from][type] ??= [[]])[0].push({ node: to, type, index: 0 }); };
  link(N.webhook, N.normalize); link(N.gmail, N.normalize);
  link(N.normalize, N.toFile); link(N.toFile, N.extract); link(N.extract, N.prep);
  link(N.prep, N.vendors); link(N.vendors, N.pos); link(N.pos, N.bills); link(N.bills, N.chain);
  ai(N.model, N.chain, 'ai_languageModel'); ai(N.parser, N.chain, 'ai_outputParser');
  link(N.chain, N.checks); link(N.checks, N.blocked);
  link(N.blocked, N.alert, 0); link(N.alert, N.heldWebhook); link(N.heldWebhook, N.respondHeld, 0);
  link(N.blocked, N.liveMarcus, 1);
  link(N.liveMarcus, N.slackMarcusLive, 0); link(N.slackMarcusLive, N.applyMarcus);
  link(N.liveMarcus, N.slackMarcus, 1); link(N.slackMarcus, N.respondWaiting); link(N.respondWaiting, N.waitMarcus); link(N.waitMarcus, N.applyMarcus);
  link(N.applyMarcus, N.marcusOk);
  link(N.marcusOk, N.needsOwen, 0); link(N.marcusOk, N.notApproved, 1);
  link(N.needsOwen, N.liveOwen, 0); link(N.needsOwen, N.buildBill, 1);
  link(N.liveOwen, N.slackOwenLive, 0); link(N.slackOwenLive, N.applyOwen);
  link(N.liveOwen, N.slackOwen, 1); link(N.slackOwen, N.waitOwen); link(N.waitOwen, N.applyOwen);
  link(N.applyOwen, N.owenOk); link(N.owenOk, N.buildBill, 0); link(N.owenOk, N.notApproved, 1);
  link(N.buildBill, N.liveQb); link(N.liveQb, N.qbLive, 0); link(N.liveQb, N.qbMock, 1);
  link(N.qbLive, N.created); link(N.qbMock, N.created);

  return {
    name: `Invoice Processor - Fernhill Software${variant === 'baseline' ? '' : ` [REGRESSION: ${variant}]`}`,
    nodes, connections: c,
    settings: { executionOrder: 'v1', timezone: 'America/New_York', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', saveExecutionProgress: true, saveManualExecutions: true },
    names: N,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = loadEnv();
  const variant = arg('variant', 'baseline');
  const wf = buildWorkflow({ variant, mockUrl: env.mockUrl, ids: sharedIds() });
  const { names, ...out } = wf;
  const outPath = arg('out', join(HERE, 'workflow', variant === 'baseline' ? 'invoice-processor.json' : `invoice-processor.${variant}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`built ${variant}: ${out.nodes.length} nodes -> ${outPath}`);
}
