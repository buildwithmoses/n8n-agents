// Decides whether the report goes to #all-hands after the Wait node resumes. Plain JS (inlined).
// Only Owen can approve. Anything else (timeout, empty body, approved:false, another approver,
// a string "yes") means NOT posted.
export const APPROVERS = ['owen'];

export function decide(resume, opts = {}) {
  const body = resume && typeof resume === 'object' ? (resume.body ?? null) : null;
  if (!body || typeof body !== 'object') return { post: false, reason: 'no approval received (timed out or empty)' };
  const approver = String(body.approver ?? '').trim().toLowerCase().replace(/^@/, '');
  if (body.approved !== true) return { post: false, reason: `not approved by ${approver || 'unknown'}` };
  if (!opts.naive && !APPROVERS.includes(approver)) return { post: false, reason: `${approver || 'unknown'} cannot approve the all-hands post` };
  const edited = typeof body.edited_markdown === 'string' && body.edited_markdown.trim().length > 0 ? body.edited_markdown : null;
  return { post: true, reason: `approved by ${approver || 'unknown'}`, approver, edited };
}
