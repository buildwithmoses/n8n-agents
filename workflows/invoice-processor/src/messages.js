// Inlined into the "AP checks" Code node: Slack text for each outcome (mock Slack locally, real Slack live).

const usd = (n) => (typeof n === 'number' ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'unknown amount');

export function slackMessages(r, meta) {
  const inv = r.invoice ?? {};
  const head = `${inv.vendor_name || meta.from} - invoice ${inv.invoice_number || '(no number)'} - ${usd(inv.total)}`;
  const issues = r.issues.length ? r.issues.map((i) => `- ${i}`).join('\n') : '- none';
  return {
    alert: r.status === 'fraud_hold'
      ? `:rotating_light: FRAUD HOLD, do not pay. ${head}\nThe remit-to bank details do not match the vendor on file, or the invoice asks to change them. Call the vendor on the number already in QuickBooks before doing anything.\nIssues:\n${issues}`
      : `:warning: Duplicate, not entered. ${head}\nQuickBooks already has this bill.\nIssues:\n${issues}`,
    ask_marcus: `@marcus please review: ${head}\nStatus: ${r.status}${r.status === 'needs_review' ? ' (look at the issues before approving)' : ''}\nIssues:\n${issues}\nApprovers needed: ${r.required_approvers.map((p) => '@' + p).join(', ')}`,
    ask_owen: `@owen second approval needed (over $10,000): ${head}\n@marcus has approved.`,
  };
}
