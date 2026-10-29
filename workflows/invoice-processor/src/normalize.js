// Inlined into the "Normalize invoice email" Code node. Plain JS: n8n Code nodes can't import files.
// One shape for both entry points: the local webhook ({ invoice: {...pdf_base64} }) and the live Gmail Trigger.

export function domainOf(address) {
  const m = String(address ?? '').toLowerCase().match(/@([a-z0-9.-]+)/);
  return m ? m[1].replace(/>$/, '') : '';
}

export function normalizeInvoiceEmail(raw, source) {
  const r = raw ?? {};
  const from = String(r.from?.value?.[0]?.address ?? r.from?.text ?? r.from ?? '').trim();
  return {
    invoice_id: String(r.id ?? r.invoice_id ?? r.messageId ?? '').slice(0, 80),
    from,
    sender_domain: domainOf(from),
    subject: String(r.subject ?? '').slice(0, 300),
    received_at: String(r.received_at ?? r.date ?? ''),
    filename: String(r.filename ?? 'invoice.pdf').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120),
    source,
  };
}
