// Inlined into the "Build access plan (code)" Code node. The access plan comes from the matrix, never the model.
// Anything the matrix can't answer cleanly is HELD for a person instead of guessed.

const uniqSorted = (xs) => [...new Set(xs)].sort();

function addMonths(isoDate, months) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));

// existing: { exists, suspended, employee_id } from the Google lookup on hire.email
export function buildPlan(hire, existing, matrix, today) {
  const hold = [];
  const role = matrix.roles[hire.title];
  const ex = existing ?? { exists: false };

  if (!hire.employee_id) hold.push('employee_not_found: BambooHR returned no record');
  if (!role) hold.push(`unknown_title: "${hire.title}" is not in the access matrix`);
  if (role && hire.department && role.department !== hire.department)
    hold.push(`department_conflict: title "${hire.title}" belongs to ${role.department}, record says ${hire.department}`);
  if (!isIsoDate(hire.start_date)) hold.push('start_date_missing');
  else if (hire.start_date < today) hold.push(`start_date_in_past: ${hire.start_date} is before ${today}`);
  if (!hire.manager) hold.push('no_manager: record has no supervisor email');
  if (hire.employment_type === 'contractor') {
    if (!isIsoDate(hire.end_date)) hold.push('contractor_end_date_missing');
    else if (hire.end_date <= hire.start_date) hold.push('contractor_end_date_before_start');
    else if (hire.end_date > addMonths(hire.start_date, matrix.contractor.max_months)) hold.push(`contractor_term_over_${matrix.contractor.max_months}_months`);
  }

  let googleAction = 'create';
  if (ex.exists && !ex.suspended) {
    if (String(ex.employee_id ?? '') === hire.employee_id && hire.employee_id) {
      return { status: 'already_onboarded', hold_reasons: [], plan: null, notes_for_approver: hire.notes, hire };
    }
    hold.push(`email_collision: ${hire.email} already belongs to an active account`);
  } else if (ex.exists && ex.suspended) {
    if (hire.rehire && String(ex.employee_id ?? '') === hire.employee_id) googleAction = 'reactivate';
    else hold.push(`suspended_account_conflict: ${hire.email} is a suspended account that is not this person's`);
  }

  if (hold.length) return { status: 'hold', hold_reasons: hold, plan: null, notes_for_approver: hire.notes, hire };

  const contractor = hire.employment_type === 'contractor';
  let groups = [...matrix.baseline.google_groups, ...role.google_groups];
  let channels = [...matrix.baseline.slack_channels, ...role.slack_channels];
  const removed = [];
  if (contractor) {
    groups.push(...matrix.contractor.google_groups);
    for (const g of groups) if (matrix.restricted_groups.includes(g)) removed.push(g);
    groups = groups.filter((g) => !matrix.restricted_groups.includes(g));
  } else {
    groups.push(...matrix.employee_only.google_groups);
    channels.push(...matrix.employee_only.slack_channels);
  }

  const github = role.github_teams.map((t) => ({ team: t.team, role: t.role, privileged: t.privileged === true }));
  const seats = role.seats.map((s) => ({ app: s.app, role: s.role, privileged: s.privileged === true }));
  const adminRole = role.google_admin_role ?? null;
  const privileged = [
    ...github.filter((t) => t.privileged).map((t) => `github:${t.team}`),
    ...seats.filter((s) => s.privileged).map((s) => `${s.app}:${s.role}`),
    ...(adminRole ? [`google-admin:${adminRole}`] : []),
  ].sort();

  const plan = {
    employee_id: hire.employee_id,
    name: `${hire.preferred_name} ${hire.last_name}`.trim(),
    title: hire.title,
    department: role.department,
    manager: hire.manager,
    start_date: hire.start_date,
    employment_type: hire.employment_type,
    end_date: contractor ? hire.end_date : null,
    google: { action: googleAction, email: hire.email, groups: uniqSorted(groups), admin_role: adminRole, expires_on: contractor ? hire.end_date : null },
    slack: { channels: uniqSorted(channels) },
    github: { teams: github.sort((a, b) => a.team.localeCompare(b.team)) },
    seats: seats.sort((a, b) => a.app.localeCompare(b.app)),
    laptop: matrix.laptops[role.laptop],
    privileged,
    needs_admin_approval: privileged.length > 0,
    removed_for_contractor: removed.sort(),
  };
  return { status: 'ready', hold_reasons: [], plan, notes_for_approver: hire.notes, hire };
}

// The comparable shape evals and tests check against labels.
export function planKey(plan) {
  if (!plan) return null;
  return {
    google_action: plan.google.action,
    groups: plan.google.groups,
    admin_role: plan.google.admin_role,
    channels: plan.slack.channels,
    github: plan.github.teams.map((t) => `${t.team}:${t.role}`).sort(),
    seats: plan.seats.map((s) => `${s.app}:${s.role}`).sort(),
    laptop: plan.laptop,
    privileged: plan.privileged,
    expires_on: plan.google.expires_on,
  };
}
