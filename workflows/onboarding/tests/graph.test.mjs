// Graph tests on the built workflow JSON: no trigger can reach anything that creates an account
// without passing @lena's approval, and privileged access sits behind @sam in the baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'onb-'));
const build = (variant) => {
  const out = join(dir, `${variant}.json`);
  execFileSync(process.execPath, [join(HERE, '../build.mjs'), '--variant', variant, '--out', out], { stdio: 'ignore' });
  return JSON.parse(readFileSync(out, 'utf8'));
};

const CREATES = ['Provision (create / reactivate / invite)', 'Google Admin: create user (live)', 'Slack: invite to channels (live)', 'GitHub: add to team (live)'];
const isTrigger = (n) => /trigger|webhook$/i.test(n.type) && !n.type.endsWith('respondToWebhook');

function pathsAvoid(wf, start, target, blocked) {
  // true if every path start -> target passes through a node in `blocked`
  const next = (name) => Object.values(wf.connections[name] ?? {}).flat(2).filter((c) => c.type === 'main').map((c) => c.node);
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const n = stack.pop();
    if (n === target) return false;
    if (seen.has(n) || blocked.includes(n)) continue;
    seen.add(n);
    stack.push(...next(n));
  }
  return true;
}

for (const variant of ['baseline', 'single-approval', 'model-plan']) {
  const wf = build(variant);
  test(`${variant}: every trigger reaches account creation only through @lena's Wait`, () => {
    const triggers = wf.nodes.filter(isTrigger);
    assert.ok(triggers.length >= 1);
    for (const t of triggers) for (const c of CREATES) assert.ok(pathsAvoid(wf, t.name, c, ['Wait: @lena approves plan']), `${t.name} -> ${c}`);
  });
  test(`${variant}: live provisioning nodes ship disabled; no secrets in the JSON`, () => {
    for (const name of CREATES.slice(1)) assert.equal(wf.nodes.find((n) => n.name === name).disabled, true, name);
    const s = JSON.stringify(wf);
    assert.ok(!/sk-or-|lsv2_|xox[bp]-/.test(s));
  });
}

test('baseline: the @sam wait sits between @lena and Apply approvals; single-approval variant skips it', () => {
  const base = build('baseline');
  assert.ok(base.connections['Admin or prod access?'].main[0].some((c) => c.node === 'Slack: ask @sam (admin/prod)'));
  assert.match(base.nodes.find((n) => n.name === 'Apply approvals').parameters.jsCode, /requireSecond: true/);
  assert.match(build('single-approval').nodes.find((n) => n.name === 'Apply approvals').parameters.jsCode, /requireSecond: false/);
});

test('baseline: the model never sees manager notes', () => {
  const base = build('baseline');
  const chain = base.nodes.find((n) => n.name === 'Write welcome + first week (model)');
  assert.match(chain.parameters.text, /model_input/);
  assert.doesNotMatch(chain.parameters.text, /notes/);
});
