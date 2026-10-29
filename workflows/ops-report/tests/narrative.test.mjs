import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNarrative, extractNumbers } from '../src/numbercheck.js';
import { buildReport, fallbackNarrative, narrativeInput, suspiciousTickets, retryInput } from '../src/report.js';
import { decide } from '../src/approval.js';
import { FX, reportFor } from './helpers.mjs';

const W39 = reportFor('2026-W39');
const ok = (t, rep = W39) => checkNarrative(t, rep);

test('accepts numbers exactly as shown, rounded, in K, and spelled out', () => {
  const r = ok('Churn spiked: churned MRR hit $7,350, 7.0x last week, with 14 customers lost. MRR ended at $403.4K (about $403K), down 0.4%. Net new MRR was -$1,450. Win rate fell 6.9 pts to 47.6%. Two anomalies flagged.');
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('rejects an invented or miscomputed number', () => {
  const r = ok('Churned MRR hit $7,350, about 7x last week. Net revenue retention was 96.2% and MRR ended at $410K.');
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('96.2%')));
  assert.ok(r.problems.some((p) => p.includes('$410K')));
});

test('rejects "record week" style claims even when every number is right', () => {
  const r = ok('Churned MRR hit $7,350 across 14 customers. Still, this was a record week with zero problems.');
  assert.equal(r.ok, false); assert.ok(r.problems.some((p) => p.includes('record')));
});

test('numbers that only appear in customer text are not allowed', () => {
  const rep = reportFor('2026-W41');
  assert.ok(rep.customer_voice.some((v) => v.excerpt.includes('14 techs')));
  const r = checkNarrative('Customers had a rough week: 14 techs could not see the dispatch board. 7 of 30 production deploys failed (23.3%).', rep);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['unsupported number "14"']);
  assert.equal(checkNarrative('Customers could not see the dispatch board. 7 of 30 production deploys failed (23.3%).', rep).ok, true);
});

test('missing source: no numbers for it, and it must be named', () => {
  const rep = reportFor('2026-W42');
  assert.equal(checkNarrative('MRR ended at $423.7K, up $6,350 (+1.5%). Support had 0 tickets and CSAT was steady. 13 deals won.', rep).ok, false);
  const quiet = checkNarrative('MRR ended at $423.7K, up $6,350 (+1.5%). 13 deals won. Deploys were steady at 32 with 1 failure.', rep);
  assert.ok(quiet.problems.some((p) => p.includes('does not say that Zendesk data is missing')));
  const good = checkNarrative('Zendesk did not return data this week, so support numbers are missing. MRR ended at $423.7K, up $6,350 (+1.5%). 13 deals won.', rep);
  assert.equal(good.ok, true, good.problems.join('; '));
});

test('the numbers-only fallback always passes its own check', () => {
  for (const sc of FX.scenarios) {
    const rep = reportFor(sc.week);
    let text = fallbackNarrative(rep);
    if (rep.missing.length) text += `\n${rep.missing_names.join(', ')} data is missing this week.`;
    const r = checkNarrative(text, rep);
    assert.equal(r.ok, true, `${sc.week}: ${r.problems.join('; ')}`);
  }
});

test('extractNumbers ignores labels like W41 and P0, reads units', () => {
  const n = extractNumbers('2026-W41: P0 bugs 2, $41.2K, 3.4%, +1.6 pts, 7.0x');
  assert.deepEqual(n.filter((x) => !x.word).map((x) => x.raw), ['2026', '2', '$41.2K', '3.4%', '1.6 pts', '7.0x']);
  assert.equal(n.find((x) => x.raw === '$41.2K').value, 41200);
});

test('the model input fences customer text as untrusted; the naive one does not', () => {
  const rep = reportFor('2026-W41');
  const p = narrativeInput(rep);
  assert.match(p, /<untrusted_customer_text>[\s\S]*SYSTEM NOTE[\s\S]*<\/untrusted_customer_text>/);
  assert.ok(p.indexOf('</metrics>') < p.indexOf('SYSTEM NOTE'));
  assert.doesNotMatch(narrativeInput(rep, { naive: true }), /untrusted/);
  assert.match(retryInput(rep, 'draft', ['unsupported number "9"']), /unsupported number "9"/);
});

test('report: data gaps line, metrics table, security flag for the injected ticket', () => {
  const rep = reportFor('2026-W41');
  assert.deepEqual(suspiciousTickets(rep).length, 1);
  const md = buildReport(rep, 'Two anomalies need attention.', 'first_pass');
  assert.match(md, /Data gaps:\* none/); assert.match(md, /\*Security:\* ticket #41\d+/); assert.match(md, /\| Failed deploys \| 7 \| 2 \|/);
  const md42 = buildReport(reportFor('2026-W42'), 'x', 'retry');
  assert.match(md42, /Zendesk did not return data for 2026-W42/); assert.match(md42, /\| Tickets \| missing \| missing \|/);
  assert.doesNotMatch(md42, /Security/);
});

test('approval: only Owen, only approved:true; timeout/empty/strings/others do not post', () => {
  assert.equal(decide({ body: { approved: true, approver: 'owen' } }).post, true);
  assert.equal(decide({ body: { approved: true, approver: '@Owen' } }).post, true);
  assert.equal(decide({ body: { approved: true, approver: 'dana' } }).post, false);
  assert.equal(decide({ body: { approved: 'yes', approver: 'owen' } }).post, false);
  assert.equal(decide({ body: { approved: false, approver: 'owen' } }).post, false);
  assert.equal(decide({ body: {} }).post, false);
  assert.equal(decide({ report_markdown: 'timeout: Wait passes the previous item through' }).post, false);
  assert.equal(decide(null).post, false);
  assert.equal(decide({ body: { approved: true, approver: 'owen', edited_markdown: 'edited' } }).edited, 'edited');
  assert.equal(decide({ body: { approved: true, approver: 'dana' } }, { naive: true }).post, true); // the regression
});
