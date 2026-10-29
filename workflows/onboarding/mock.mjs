// Mock routes for the onboarding workflow (loaded by mock/server.mjs).
// BambooHR serves the fictional hire records; Google/Slack/GitHub/HubSpot/Zendesk/Linear keep in-memory state
// seeded from fixtures/hires.json. Google refuses a second account for the same email (409), like the real API.
// The seat APIs and Linear deliberately ACCEPT duplicates, the way many SaaS invite APIs do, so the workflow's
// own check-then-create is what keeps re-runs clean. GET /<app>/_dump returns that app's state for evals.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hires.json'), 'utf8'));
const records = Object.fromEntries(FX.hires.map((h) => [String(h.record.id), h.record]));
const lc = (s) => String(s ?? '').toLowerCase();

function S(ctx, app) {
  const st = ctx.store;
  if (st.__seeded) return st;
  st.__seeded = true;
  if (app === 'google') {
    st.users = FX.seed.google_users.map((u) => ({ ...u })); st.groups = {}; st.roles = []; st.scheduled = [];
  } else if (app === 'slack') {
    st.members = Object.fromEntries(Object.entries(FX.seed.slack_members).map(([c, xs]) => [c, [...xs]])); st.messages = [];
  } else if (app === 'github') st.teams = {};
  else if (['hubspot', 'zendesk', 'linear'].includes(app)) { st.users = [...(FX.seed.seats[app] ?? []).map((s) => ({ ...s }))]; st.issues = []; }
  else if (app === 'bamboohr') st.tasks = [];
  return st;
}

const seatRoutes = (app) => ({
  [`GET /${app}/users/:email`]: ({ params }, ctx) => ({ exists: S(ctx, app).users.some((u) => lc(u.email) === lc(params.email)) }),
  [`POST /${app}/users`]: ({ body }, ctx) => { const u = { id: `${app}-${S(ctx, app).users.length + 1}`, ...body }; S(ctx, app).users.push(u); return u; },
  [`GET /${app}/_dump`]: (_r, ctx) => S(ctx, app),
});

export const routes = {
  'GET /bamboohr/employees/:id': ({ params }) => records[params.id] ?? { __status: 404, body: { error: 'employee not found' } },
  'GET /bamboohr/employees/:id/tasks/:source': ({ params }, ctx) => ({ exists: S(ctx, 'bamboohr').tasks.some((t) => t.employee_id === params.id && t.source === params.source) }),
  'POST /bamboohr/employees/:id/tasks': ({ params, body }, ctx) => { S(ctx, 'bamboohr').tasks.push({ employee_id: params.id, ...body }); return { ok: true }; },
  'GET /bamboohr/_dump': (_r, ctx) => S(ctx, 'bamboohr'),

  'GET /google/users/:email': ({ params }, ctx) => {
    const u = S(ctx, 'google').users.find((x) => lc(x.primaryEmail) === lc(params.email));
    return u ? { exists: true, suspended: u.suspended === true, employee_id: u.employeeId ?? null } : { exists: false };
  },
  'POST /google/users': ({ body }, ctx) => {
    const g = S(ctx, 'google');
    if (g.users.some((x) => lc(x.primaryEmail) === lc(body.primaryEmail))) return { __status: 409, body: { error: 'Entity already exists.' } };
    const u = { ...body, suspended: false, createdAt: new Date().toISOString() }; g.users.push(u); return u;
  },
  'PATCH /google/users/:email': ({ params, body }, ctx) => {
    const u = S(ctx, 'google').users.find((x) => lc(x.primaryEmail) === lc(params.email));
    if (!u) return { __status: 404, body: { error: 'not found' } };
    Object.assign(u, body); return u;
  },
  'GET /google/groups/:group/members/:email': ({ params }, ctx) => ({ exists: (S(ctx, 'google').groups[params.group] ?? []).includes(lc(params.email)) }),
  'POST /google/groups/:group/members': ({ params, body }, ctx) => {
    const g = S(ctx, 'google'); const m = (g.groups[params.group] ??= []);
    if (m.includes(lc(body.email))) return { __status: 409, body: { error: 'Member already exists.' } };
    m.push(lc(body.email)); return { ok: true };
  },
  'GET /google/roleassignments/:email/:role': ({ params }, ctx) => ({ exists: S(ctx, 'google').roles.some((r) => lc(r.assignedTo) === lc(params.email) && r.role === params.role) }),
  'POST /google/roleassignments': ({ body }, ctx) => { S(ctx, 'google').roles.push(body); return { ok: true }; },
  'GET /google/gmail/scheduled/:ext': ({ params }, ctx) => ({ exists: S(ctx, 'google').scheduled.some((m) => m.external_id === params.ext) }),
  'POST /google/gmail/scheduled': ({ body }, ctx) => { S(ctx, 'google').scheduled.push(body); return { ok: true, scheduled_for: body.send_at }; },
  'GET /google/_dump': (_r, ctx) => S(ctx, 'google'),

  'GET /slack/conversations/:channel/members/:email': ({ params }, ctx) => ({ exists: (S(ctx, 'slack').members[params.channel] ?? []).includes(lc(params.email)) }),
  'POST /slack/conversations.invite': ({ body }, ctx) => { const m = (S(ctx, 'slack').members[body.channel] ??= []); m.push(lc(body.email)); return { ok: true }; },
  'POST /slack/chat.postMessage': ({ body }, ctx) => { S(ctx, 'slack').messages.push(body); return { ok: true, ts: String(Date.now() / 1000) }; },
  'GET /slack/_dump': (_r, ctx) => S(ctx, 'slack'),

  'GET /github/teams/:team/memberships/:login': ({ params }, ctx) => ({ exists: (S(ctx, 'github').teams[params.team] ?? []).some((m) => m.login === params.login) }),
  'PUT /github/teams/:team/memberships/:login': ({ params, body }, ctx) => { const t = (S(ctx, 'github').teams[params.team] ??= []); t.push({ login: params.login, role: body.role, email: lc(body.email) }); return { state: 'pending', role: body.role }; },
  'GET /github/_dump': (_r, ctx) => S(ctx, 'github'),

  ...seatRoutes('hubspot'),
  ...seatRoutes('zendesk'),
  ...seatRoutes('linear'),
  'GET /linear/issues/:ext': ({ params }, ctx) => ({ exists: S(ctx, 'linear').issues.some((i) => i.external_id === params.ext) }),
  'POST /linear/issues': ({ body }, ctx) => { const l = S(ctx, 'linear'); const i = { id: `IT-${l.issues.length + 1}`, ...body }; l.issues.push(i); return i; },
};
