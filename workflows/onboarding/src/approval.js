// Inlined into the "Apply approvals" Code node. Turns the approvers' answers into the final plan.
// Fails safe: a timeout, an empty body, the wrong approver or anything but "approve" means NOT approved.

// resume: what the Wait node outputs after its webhook is called ({ headers, params, query, body }),
// or the original item when the wait timed out (no body).
export function parseDecision(resume, expectedApprover) {
  const body = resume && typeof resume === 'object' ? resume.body : undefined;
  if (!body || typeof body !== 'object') return { approved: false, approver: null, reason: 'no response (timed out or empty)' };
  const approver = String(body.approver ?? '').toLowerCase().replace(/^@/, '');
  if (approver !== expectedApprover) return { approved: false, approver, reason: `answer came from "${approver || 'nobody'}", not @${expectedApprover}` };
  if (String(body.decision ?? '').toLowerCase() !== 'approve') return { approved: false, approver, reason: `@${approver} said ${body.decision ?? 'nothing'}`, comment: body.comment ?? '' };
  return { approved: true, approver, reason: 'approved', comment: body.comment ?? '' };
}

export function stripPrivileged(plan) {
  const dropped = [...plan.privileged];
  return {
    plan: {
      ...plan,
      google: { ...plan.google, admin_role: null },
      github: { teams: plan.github.teams.filter((t) => !t.privileged) },
      seats: plan.seats.filter((s) => !s.privileged),
      privileged: [],
      needs_admin_approval: false,
    },
    dropped,
  };
}

// opts.requireSecond: privileged items need @sam as well as @lena. The regression variant turns this off.
export function finalize(plan, lena, sam, opts = { requireSecond: true }) {
  if (!lena?.approved) return { proceed: false, plan: null, dropped: [], reason: `@lena did not approve: ${lena?.reason ?? 'no answer'}` };
  if (!plan.needs_admin_approval || opts.requireSecond === false) return { proceed: true, plan, dropped: [], reason: 'approved' };
  if (sam?.approved) return { proceed: true, plan, dropped: [], reason: 'approved by @lena and @sam' };
  const s = stripPrivileged(plan);
  return { proceed: true, plan: s.plan, dropped: s.dropped, reason: `@sam did not approve privileged access (${sam?.reason ?? 'no answer'}); provisioning everything else` };
}
