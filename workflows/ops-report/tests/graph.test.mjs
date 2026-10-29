// Builds the real workflow JSON and checks its shape: no path from a trigger reaches #all-hands without the
// Wait node AND the "Approved by Owen?" true branch; every narrative passes the number check before delivery;
// Code nodes compile; no secrets are embedded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const build = (variant) => {
  const out = join(mkdtempSync(join(tmpdir(), 'opsr-')), 'wf.json');
  execFileSync(process.execPath, [join(HERE, '..', 'build.mjs'), '--variant', variant, '--out', out], { stdio: 'pipe' });
  return JSON.parse(readFileSync(out, 'utf8'));
};

// edges: node -> [{to, output}] over main connections
function edges(wf) {
  const e = {};
  for (const [from, c] of Object.entries(wf.connections)) for (const [i, outs] of (c.main ?? []).entries()) for (const t of outs) (e[from] ??= []).push({ to: t.node, output: i });
  return e;
}
function allPaths(wf, from, isTarget) {
  const e = edges(wf); const paths = [];
  const walk = (n, path) => { if (path.length > 60) return; if (isTarget(n)) { paths.push(path); return; } for (const x of e[n] ?? []) if (!path.some((p) => p.node === x.to)) walk(x.to, [...path, { node: x.to, via: n, output: x.output }]); };
  walk(from, [{ node: from }]);
  return paths;
}
const TRIGGERS = (wf) => wf.nodes.filter((n) => /trigger|webhook/i.test(n.type) && !/respondToWebhook/.test(n.type)).map((n) => n.name);

for (const variant of ['baseline', 'naive']) {
  const wf = build(variant);
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const allHands = wf.nodes.filter((n) => n.parameters.channelId?.value === '#all-hands' || String(n.parameters.jsonBody ?? '').includes("'#all-hands'")).map((n) => n.name);

  test(`${variant}: every path from every trigger to an #all-hands post goes through the Wait node and the approved branch`, () => {
    assert.equal(allHands.length, 2);
    assert.deepEqual(TRIGGERS(wf).sort(), ['Every Monday 7am (ET)', 'Webhook: POST /ops-report']);
    let n = 0;
    for (const t of TRIGGERS(wf)) for (const p of allPaths(wf, t, (x) => allHands.includes(x))) {
      n++;
      assert.ok(p.some((s) => byName[s.node].type === 'n8n-nodes-base.wait'), `no Wait on ${p.map((s) => s.node).join(' > ')}`);
      const ifStep = p.find((s) => s.via === 'Approved by Owen?');
      assert.ok(ifStep && ifStep.output === 0, 'must leave "Approved by Owen?" on its TRUE output');
    }
    assert.ok(n >= 2);
  });

  test(`${variant}: the Wait node requires the approval header credential`, () => {
    const w = wf.nodes.find((n) => n.type === 'n8n-nodes-base.wait');
    assert.equal(w.parameters.incomingAuthentication, 'headerAuth');
    assert.ok(w.credentials?.httpHeaderAuth?.id);
    assert.equal(w.parameters.limitWaitTime, true);
  });

  test(`${variant}: Code nodes compile and no secrets are embedded`, () => {
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(() => new Function('$', '$input', '$now', '$execution', `return (async () => {\n${n.parameters.jsCode}\n})`), n.name);
    }
    const raw = JSON.stringify(wf);
    assert.doesNotMatch(raw, /sk-or-|lsv2_|xox[bp]-/);
  });

  test(`${variant}: live production nodes are present and disabled`, () => {
    const live = wf.nodes.filter((n) => n.name.endsWith('(live)'));
    assert.equal(live.length, 7);
    assert.ok(live.every((n) => n.disabled === true));
  });
}

test('baseline: every path to the Slack DM passes the number check; the retry path checks again', () => {
  const wf = build('baseline');
  for (const p of allPaths(wf, 'Webhook: POST /ops-report', (x) => x === 'Slack: DM @owen')) {
    const names = p.map((s) => s.node);
    assert.ok(names.includes('Check numbers'));
    if (names.includes('Rewrite narrative (one retry)')) assert.ok(names.includes('Check rewrite (else table)'));
  }
});

test('naive variant really removes the number check (so the gate has something to catch)', () => {
  const code = build('naive').nodes.find((n) => n.name === 'Check numbers').parameters.jsCode;
  assert.doesNotMatch(code, /const res = checkNarrative/);
});
