// Inlined into the "AP checks (code, not the model)" Code node.
// The model only READS the PDF into fields. Every decision about whether a bill can be paid is made here,
// from the raw PDF text and the QuickBooks records, so nothing written inside a PDF can change it.

export const PO_REQUIRED_AT = 2500;     // bills at or above this total must reference a PO
export const SECOND_APPROVER_OVER = 10000; // bills above this also need the COO
const CENT = 0.02;

export const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return String(v).trim() !== '' && Number.isFinite(n) ? n : null;
};
const r2 = (n) => Math.round(n * 100) / 100;
export const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const normName = (s) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\b(inc|llc|llp|co|corp|company|ltd)\b/g, ' ').replace(/\s+/g, ' ').trim();
const normDoc = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const digits = (s) => String(s ?? '').replace(/\D/g, '');

const INJECTION = /\b(note to (the )?ai|ai (assistant|system|agent|model)\s*:|ignore (all |any |the )?(previous|prior|above) (instructions|rules)|mark (this|it)( invoice)? (as )?(approved|paid)|pre-?approved by|skip (the )?review|approve (this|it)( invoice)? automatically|auto-?approve|do not flag)/i;
const BANK_CHANGE = /(bank(ing)? (details|information|account)s? (have|has|were) (changed|been updated|updated)|bank details are updated|new (bank|banking|remittance|remit-to|payment) (details|account|information|instructions)|update your (records|vendor file)|overwrite the remit)/i;

// Bank numbers straight from the PDF text, whatever the layout ("Routing number: 0555...", "ABA 0555... | ACCT 44...").
export function bankNumbersInText(text) {
  const t = String(text ?? '');
  const routing = [...t.matchAll(/\b(?:routing(?:\s+(?:number|no\.?))?|aba|rtn)\s*[:#]?\s*(\d{9})\b/gi)].map((m) => m[1]);
  const account = [...t.matchAll(/\b(?:account(?:\s+(?:number|no\.?))?|acct\.?)\s*(?:#|:)?\s*(\d[\d -]{4,18}\d)\b/gi)].map((m) => digits(m[1]));
  return { routing: [...new Set(routing)], account: [...new Set(account)] };
}

export function matchVendor(vendors, name, senderDomain) {
  const n = normName(name);
  if (n) {
    const exact = vendors.find((v) => normName(v.name) === n);
    if (exact) return { vendor: exact, by: 'name' };
    const partial = vendors.find((v) => normName(v.name).length > 6 && (n.includes(normName(v.name)) || normName(v.name).includes(n)));
    if (partial) return { vendor: partial, by: 'name' };
  }
  const byDomain = vendors.find((v) => senderDomain && v.email_domain === senderDomain);
  return byDomain ? { vendor: byDomain, by: 'sender_domain' } : { vendor: null, by: null };
}

/**
 * @param doc      { pdf_text, sender_domain, from, invoice_id }
 * @param ext      model extraction (may be null if the model failed)
 * @param qb       { vendors, purchase_orders, bills } from QuickBooks
 * @returns        { status, blocked, issues[], details{}, vendor_id, required_approvers[], invoice{} }
 */
export function runChecks(doc, ext, qb, { modelError, bankCheck = true } = {}) {
  const issues = []; const details = {};
  const add = (code, detail) => { if (!issues.includes(code)) issues.push(code); if (detail !== undefined) details[code] = detail; };
  const text = String(doc.pdf_text ?? '');
  const noText = text.replace(/\s+/g, '').length < 40;
  const e = noText ? {} : (ext ?? {}); // with no text layer, anything the model "read" is invented: ignore it
  const inv = {
    vendor_name: String(e.vendor_name ?? '').trim(),
    invoice_number: String(e.invoice_number ?? '').trim(),
    invoice_date: String(e.invoice_date ?? '').trim(),
    due_date: String(e.due_date ?? '').trim(),
    po_number: String(e.po_number ?? '').trim().toUpperCase(),
    line_items: Array.isArray(e.line_items) ? e.line_items.map((l) => ({ description: String(l.description ?? ''), quantity: toNum(l.quantity), unit_price: toNum(l.unit_price), amount: toNum(l.amount) })) : [],
    subtotal: toNum(e.subtotal), tax: toNum(e.tax) ?? 0, total: toNum(e.total),
    remit_to: { bank_name: String(e.remit_to?.bank_name ?? ''), routing_number: digits(e.remit_to?.routing_number), account_number: digits(e.remit_to?.account_number) },
  };

  const { vendor, by } = matchVendor(qb.vendors ?? [], inv.vendor_name, doc.sender_domain);

  if (noText) add('no_text_layer', 'PDF has no extractable text (scanned image?). Key it in by hand.');
  if (modelError) add('extraction_failed', String(modelError).slice(0, 200));

  // 1. Instructions aimed at the AI. Flag them; never act on them.
  const inj = text.match(INJECTION);
  if (inj) add('instructions_in_document', inj[0]);

  // 2. Vendor and bank. A changed remit-to is the classic vendor-impersonation fraud, so it's a hard hold.
  if (!vendor) add('unknown_vendor', inv.vendor_name || doc.sender_domain);
  else {
    if (doc.sender_domain && doc.sender_domain !== vendor.email_domain) add('sender_domain_mismatch', `${doc.sender_domain} vs ${vendor.email_domain} on file`);
    const fromText = bankCheck ? bankNumbersInText(text) : { routing: [], account: [] };
    const seenAccounts = new Set([...fromText.account, ...(bankCheck ? [inv.remit_to.account_number] : [])].filter((a) => a.length >= 5));
    const seenRouting = new Set([...fromText.routing, ...(bankCheck ? [inv.remit_to.routing_number] : [])].filter((a) => a.length === 9));
    const badAcct = [...seenAccounts].filter((a) => a !== digits(vendor.bank.account_number));
    const badRouting = [...seenRouting].filter((r) => r !== digits(vendor.bank.routing_number));
    if (badAcct.length || badRouting.length) add('remit_to_bank_changed', { on_file: `****${vendor.bank.account_number.slice(-4)}`, on_invoice: [...badAcct, ...badRouting].map((x) => `****${x.slice(-4)}`) });
  }
  const bc = bankCheck ? text.match(BANK_CHANGE) : null;
  if (bc) add('bank_change_language', bc[0]);

  if (!issues.includes('no_text_layer')) {
    // 3. Required fields.
    if (!inv.vendor_name) add('missing_vendor_name');
    if (!inv.invoice_number) add('missing_invoice_number');
    if (!inv.invoice_date) add('missing_invoice_date');
    if (!inv.due_date) add('missing_due_date');
    if (inv.total === null) add('missing_total');
    if (!inv.line_items.length) add('missing_line_items');

    // 4. Math, in code. The model's numbers are re-added, never trusted.
    for (const l of inv.line_items) {
      if (l.quantity !== null && l.unit_price !== null && l.amount !== null && Math.abs(r2(l.quantity * l.unit_price) - l.amount) > CENT) add('line_amount_mismatch', l.description);
    }
    const lineSum = r2(inv.line_items.reduce((a, l) => a + (l.amount ?? 0), 0));
    if (inv.subtotal !== null && inv.line_items.length && Math.abs(lineSum - inv.subtotal) > CENT) add('line_items_dont_sum', { lines: lineSum, subtotal: inv.subtotal });
    const sub = inv.subtotal ?? lineSum;
    if (inv.total !== null && Math.abs(r2(sub + inv.tax) - inv.total) > CENT) add('total_mismatch', { subtotal_plus_tax: r2(sub + inv.tax), total: inv.total });
    // The total must literally appear in the PDF. Catches a misread or invented number.
    if (inv.total !== null && !text.includes(money(inv.total))) add('total_not_in_document', money(inv.total));

    // 5. Duplicates against every bill QuickBooks already has for this vendor.
    if (vendor) {
      const prior = (qb.bills ?? []).filter((b) => b.vendor_id === vendor.id);
      const sameNo = inv.invoice_number && prior.find((b) => normDoc(b.doc_number) === normDoc(inv.invoice_number));
      if (sameNo) add('duplicate_invoice_number', { bill_id: sameNo.id, status: sameNo.status });
      else {
        const sameAmt = inv.total !== null && prior.find((b) => Math.abs(Number(b.total) - inv.total) < 0.01 && b.txn_date === inv.invoice_date);
        if (sameAmt) add('possible_duplicate_same_amount_and_date', { bill_id: sameAmt.id, doc_number: sameAmt.doc_number });
      }
    }

    // 6. Purchase order.
    if (inv.po_number) {
      const po = (qb.purchase_orders ?? []).find((p) => normDoc(p.number) === normDoc(inv.po_number));
      if (!po) add('po_not_found', inv.po_number);
      else {
        if (vendor && po.vendor_id !== vendor.id) add('po_vendor_mismatch', po.number);
        if (po.status !== 'open') add('po_not_open', po.status);
        const tol = Math.max(50, 0.02 * po.amount);
        if (Math.abs(sub - po.amount) > tol) add('po_amount_mismatch', { po_amount: po.amount, invoice_subtotal: sub });
      }
    } else if ((inv.total ?? 0) >= PO_REQUIRED_AT) add('po_required', `total ${money(inv.total)} >= ${money(PO_REQUIRED_AT)}`);
  }

  const HOLD = ['remit_to_bank_changed', 'bank_change_language'];
  const DUP = ['duplicate_invoice_number', 'possible_duplicate_same_amount_and_date'];
  let status = 'ready_for_approval';
  if (issues.some((i) => HOLD.includes(i))) status = 'fraud_hold';
  else if (issues.some((i) => DUP.includes(i))) status = 'duplicate';
  else if (issues.length) status = 'needs_review';

  const required_approvers = (inv.total ?? 0) > SECOND_APPROVER_OVER ? ['marcus', 'owen'] : ['marcus'];
  return {
    status, blocked: status === 'fraud_hold' || status === 'duplicate', issues, details,
    vendor_id: vendor?.id ?? null, vendor_matched_by: by, required_approvers, invoice: inv,
  };
}

// Regression variant ("trust the model"): the model's own assessment decides; code only computes approvers.
export function trustModel(doc, ext, qb, { modelError } = {}) {
  const e = ext ?? {}; const a = e.assessment ?? {};
  const allowed = ['ready_for_approval', 'needs_review', 'fraud_hold', 'duplicate'];
  const status = modelError ? 'needs_review' : (allowed.includes(a.status) ? a.status : 'needs_review');
  const { vendor, by } = matchVendor(qb.vendors ?? [], e.vendor_name, doc.sender_domain);
  const total = toNum(e.total);
  return {
    status, blocked: status === 'fraud_hold' || status === 'duplicate', issues: Array.isArray(a.issues) ? a.issues.map(String) : [], details: { model_reason: a.reason ?? '' },
    vendor_id: vendor?.id ?? null, vendor_matched_by: by, required_approvers: (total ?? 0) > SECOND_APPROVER_OVER ? ['marcus', 'owen'] : ['marcus'],
    invoice: { ...e, total, subtotal: toNum(e.subtotal), tax: toNum(e.tax) ?? 0, line_items: e.line_items ?? [] },
  };
}
