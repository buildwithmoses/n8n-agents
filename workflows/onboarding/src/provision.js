// Inlined into "Build provisioning calls" and "Keep only what's missing". Check-then-create on every system,
// so a duplicate webhook or a re-run never creates a second account, seat or ticket.

export const githubLogin = (email) => `fh-${email.split('@')[0].replace(/\./g, '-')}`;

export function buildCalls(plan, extras = {}) {
  const email = plan.google.email;
  const id = plan.employee_id;
  const enc = encodeURIComponent;
  const calls = [];
  const add = (key, app, check, act, privileged = false) => calls.push({ key, app, check_path: check, method: act.method, path: act.path, body: act.body, privileged, employee_id: id, email });

  if (plan.google.action === 'reactivate') add('google:user', 'google', `/google/users/${enc(email)}`, { method: 'PATCH', path: `/google/users/${enc(email)}`, body: { suspended: false, employeeId: id, expiresOn: plan.google.expires_on } });
  else add('google:user', 'google', `/google/users/${enc(email)}`, { method: 'POST', path: '/google/users', body: { primaryEmail: email, name: plan.name, employeeId: id, orgUnitPath: `/${plan.department}`, expiresOn: plan.google.expires_on } });
  for (const g of plan.google.groups) add(`google:group:${g}`, 'google', `/google/groups/${enc(g)}/members/${enc(email)}`, { method: 'POST', path: `/google/groups/${enc(g)}/members`, body: { email, role: 'MEMBER' } });
  if (plan.google.admin_role) add(`google:admin:${plan.google.admin_role}`, 'google', `/google/roleassignments/${enc(email)}/${enc(plan.google.admin_role)}`, { method: 'POST', path: '/google/roleassignments', body: { assignedTo: email, role: plan.google.admin_role } }, true);
  for (const c of plan.slack.channels) add(`slack:${c}`, 'slack', `/slack/conversations/${enc(c)}/members/${enc(email)}`, { method: 'POST', path: '/slack/conversations.invite', body: { channel: c, email } });
  for (const t of plan.github.teams) add(`github:${t.team}`, 'github', `/github/teams/${enc(t.team)}/memberships/${githubLogin(email)}`, { method: 'PUT', path: `/github/teams/${enc(t.team)}/memberships/${githubLogin(email)}`, body: { role: t.role, email } }, t.privileged);
  for (const s of plan.seats) add(`${s.app}:${s.role}`, s.app, `/${s.app}/users/${enc(email)}`, { method: 'POST', path: `/${s.app}/users`, body: { email, name: plan.name, role: s.role } }, s.privileged);
  add('linear:laptop', 'linear', `/linear/issues/laptop-${id}`, { method: 'POST', path: '/linear/issues', body: { external_id: `laptop-${id}`, team: 'IT', title: `Ship ${plan.laptop} to ${plan.name} before ${plan.start_date}` } });
  if (extras.tasks) add('bamboohr:tasks', 'bamboohr', `/bamboohr/employees/${id}/tasks/n8n-onboarding`, { method: 'POST', path: `/bamboohr/employees/${id}/tasks`, body: { source: 'n8n-onboarding', assignee: plan.manager, tasks: extras.tasks } });
  if (extras.welcome) add('google:welcome-email', 'google', `/google/gmail/scheduled/welcome-${id}`, { method: 'POST', path: '/google/gmail/scheduled', body: { external_id: `welcome-${id}`, to: extras.personal_email, cc: email, subject: `Welcome to Fernhill, ${plan.name.split(' ')[0]}`, body: extras.welcome, send_at: `${plan.start_date}T08:00:00`, timezone: extras.timezone ?? 'America/New_York' } });
  return calls;
}

// checks[i] is the parsed response of GET check_path for calls[i]: { exists, suspended? } or anything else on error.
export function keepMissing(calls, checks) {
  const todo = [], skipped = [], failed = [];
  calls.forEach((c, i) => {
    const r = checks[i];
    if (!r || typeof r.exists !== 'boolean') { failed.push({ key: c.key, reason: 'existence check failed; not creating (fail safe)' }); return; }
    if (c.key === 'google:user' && c.method === 'PATCH') { if (r.exists && r.suspended) todo.push(c); else skipped.push(c.key); return; }
    if (r.exists) skipped.push(c.key); else todo.push(c);
  });
  return { todo, skipped, failed };
}

export function summarize(todo, responses) {
  const created = [], errors = [];
  todo.forEach((c, i) => { const r = responses[i] ?? {}; (r.statusCode >= 200 && r.statusCode < 300 ? created : errors).push(c.key + (r.statusCode >= 300 ? ` (HTTP ${r.statusCode})` : '')); });
  return { created, errors };
}
