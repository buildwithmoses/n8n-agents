// Inlined into the "Apply Marcus decision" / "Apply Owen decision" Code nodes.
// Fail safe: only an explicit {"decision":"approve","approver":"<the right person>"} approves.
// Timeout, empty body, a different approver, or anything unexpected means NOT approved.

export function applyDecision(resumed, expectedApprover, { live = false } = {}) {
  const r = resumed ?? {};
  // Live path: Slack "send and wait" (approval type) resumes with { data: { approved: true|false } }.
  if (live && r.data && typeof r.data.approved === 'boolean') {
    return { approved: r.data.approved === true, approver: expectedApprover, via: 'slack', note: '', reason: r.data.approved ? 'approved in Slack' : 'declined in Slack' };
  }
  const body = r.body && typeof r.body === 'object' ? r.body : {};
  const decision = String(body.decision ?? '').toLowerCase();
  const approver = String(body.approver ?? '').toLowerCase().replace(/^@/, '');
  const note = String(body.note ?? '').slice(0, 500);
  if (!r.body) return { approved: false, approver: '', via: 'none', note, reason: 'no response (timed out or empty)' };
  if (approver !== expectedApprover) return { approved: false, approver, via: 'webhook', note, reason: `needs @${expectedApprover}, got "${approver || 'nobody'}"` };
  if (decision !== 'approve') return { approved: false, approver, via: 'webhook', note, reason: decision === 'reject' ? 'rejected' : `unknown decision "${decision}"` };
  return { approved: true, approver, via: 'webhook', note, reason: 'approved' };
}
