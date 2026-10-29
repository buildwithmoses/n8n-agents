// Runs after the agent responds to the approval webhook (or the 24h wait runs out).
// Only an explicit { approved: true, agent: "<name>" } posts a public reply. Plain JS, no imports.
export function applyDecision({ decision, draft, ticketId }) {
  const d = decision && typeof decision === 'object' ? decision : {};
  const agent = String(d.agent ?? '').trim();
  if (d.approved !== true) return { post: false, reason: d.approved === false ? 'rejected by agent' : 'no approval (timeout or empty response)' };
  if (!agent) return { post: false, reason: 'approval must name the agent' };
  const body = String(typeof d.reply === 'string' && d.reply.trim() ? d.reply : draft ?? '').trim();
  if (!body) return { post: false, reason: 'nothing to send' };
  return {
    post: true, agent, edited: typeof d.reply === 'string' && d.reply.trim() !== String(draft ?? '').trim(),
    zendesk_update: { ticket: { status: 'pending', comment: { body, public: true, author: agent } } }, ticket_id: ticketId,
  };
}
