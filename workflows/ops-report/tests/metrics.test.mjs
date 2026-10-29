import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReport, sourceStatus, METRIC_DEFS, fmtUsd } from '../src/metrics.js';
import { resolveWeek, prevWeek, weekLabel, weekStart, lastFullWeek } from '../src/week.js';
import { truthMetrics } from '../evals/score.mjs';
import { FX, responsesFor, reportFor } from './helpers.mjs';

const SRC = (k) => METRIC_DEFS[k].source;

for (const sc of FX.scenarios) {
  test(`${sc.week} (${sc.label}): every metric matches the hand-set truth`, () => {
    const rep = reportFor(sc.week); const t = truthMetrics(FX, sc.week);
    for (const [k, m] of Object.entries(rep.metrics)) {
      const want = t.missing.includes(SRC(k)) ? null : t.cur[k];
      assert.equal(m.value, want, `${k} this week`);
      assert.equal(m.prev, t.missing.includes(SRC(k)) ? null : t.prev[k], `${k} last week (a down source gives no data for either week)`);
    }
    assert.deepEqual(rep.missing, sc.expected_missing);
  });
  test(`${sc.week} (${sc.label}): anomalies are exactly the planted ones`, () => {
    assert.deepEqual(reportFor(sc.week).anomalies.map((a) => a.code).sort(), [...sc.expected_anomalies].sort());
  });
}

test('a missing source is null and "missing", never 0', () => {
  const rep = reportFor('2026-W42');
  for (const k of ['tickets', 'sla_breaches', 'sla_breach_rate_pct', 'csat_pct']) { assert.equal(rep.metrics[k].value, null); assert.equal(rep.metrics[k].display, 'missing'); }
  assert.equal(rep.sources.zendesk, 'HTTP 500');
  assert.equal(reportFor('2026-W43').sources.linear, 'empty response');
});

test('the naive regression turns a missing source into zeros (the bug the gate catches)', () => {
  const rep = reportFor('2026-W42', { naive: true });
  assert.equal(rep.metrics.tickets.value, 0);
  assert.deepEqual(rep.missing, []);
});

test('sourceStatus: network error, non-2xx, empty body, no data for the week', () => {
  assert.equal(sourceStatus({ error: { message: 'ECONNREFUSED' } }, '2026-W41').ok, false);
  assert.equal(sourceStatus({ statusCode: 503, body: {} }, '2026-W41').reason, 'HTTP 503');
  assert.equal(sourceStatus({ statusCode: 200, body: {} }, '2026-W41').reason, 'empty response');
  assert.equal(sourceStatus({ statusCode: 200, body: '' }, '2026-W41').reason, 'empty response');
  assert.equal(sourceStatus({ statusCode: 200, body: { data: {} } }, '2026-W41').reason, 'no data for 2026-W41');
  assert.equal(sourceStatus({ statusCode: 200, body: { data: { '2026-W41': {} } } }, '2026-W41').ok, true);
});

test('every source down: five missing, no anomalies, no crash', () => {
  const w = resolveWeek('2026-W41', new Date());
  const rep = computeReport(w, Object.fromEntries(['stripe', 'hubspot', 'zendesk', 'linear', 'github'].map((s) => [s, { error: 'timeout' }])));
  assert.equal(rep.missing.length, 5); assert.equal(rep.anomalies.length, 0); assert.equal(rep.sources_ok, 0);
});

test('noise is filtered: trials, open deals, staging deploys, feature issues, unrated tickets', () => {
  const { resp } = responsesFor('2026-W41');
  const raw = resp.github.body.data['2026-W41'].deployments;
  assert.ok(raw.length > 30); // includes staging
  assert.equal(reportFor('2026-W41').metrics.deploys.value, 30);
});

test('deltas and display formats', () => {
  const m = reportFor('2026-W39').metrics;
  assert.equal(m.net_new_mrr.display, '-$1,450');
  assert.equal(m.mrr_end.display, '$403.4K');
  assert.equal(m.mrr_end.growth_pct, -0.4);
  assert.equal(m.win_rate_pct.change_display, '-6.9 pts');
  assert.equal(fmtUsd(123456), '$123.5K'); assert.equal(fmtUsd(99999), '$99,999'); assert.equal(fmtUsd(null), 'missing');
});

test('ISO weeks: labels, previous week across a year boundary, Monday run covers last week', () => {
  assert.equal(prevWeek('2026-W01'), '2025-W52');
  assert.equal(weekLabel(new Date('2027-01-01T12:00:00Z')), '2026-W53');
  for (const w of ['2026-W01', '2026-W27', '2026-W53', '2020-W53']) assert.equal(weekLabel(weekStart(w)), w);
  assert.equal(lastFullWeek(new Date('2026-11-02T12:00:00Z')), '2026-W44');
  assert.equal(resolveWeek('nonsense', new Date('2026-11-02T12:00:00Z')).week, '2026-W44');
  assert.equal(resolveWeek('2026-W41', new Date()).week_range, 'Oct 5 to Oct 11, 2026');
});
