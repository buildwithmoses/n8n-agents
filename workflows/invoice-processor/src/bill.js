// Inlined into the "Build QuickBooks bill" Code node. Runs only after every required approver said yes.
// Creates an OPEN bill (accounts payable). Paying it stays a separate human step in QuickBooks.

export function buildBill(check, approvals, meta) {
  const inv = check.invoice;
  const names = approvals.filter((a) => a.approved).map((a) => a.approver);
  const missing = check.required_approvers.filter((p) => !names.includes(p));
  if (check.blocked) throw new Error(`refusing to create a bill for a ${check.status} invoice`);
  if (missing.length) throw new Error(`refusing to create a bill without approval from: ${missing.join(', ')}`);
  return {
    vendor_id: check.vendor_id,
    doc_number: inv.invoice_number,
    txn_date: inv.invoice_date,
    due_date: inv.due_date,
    po_number: inv.po_number || null,
    subtotal: inv.subtotal, tax: inv.tax, total: inv.total,
    lines: inv.line_items.map((l, i) => ({ line_num: i + 1, description: l.description, amount: l.amount })),
    memo: `Approved by ${names.map((n) => '@' + n).join(' and ')} via n8n invoice-processor. From ${meta.from}.`,
    review_issues: check.issues,
    approvals: approvals.map(({ approver, note, via }) => ({ approver, note, via })),
    invoice_id: meta.invoice_id,
    source: 'n8n-invoice-processor',
  };
}
