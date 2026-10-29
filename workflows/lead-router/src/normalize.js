// Inlined into the "Normalize lead" Code node. Plain JS, no imports.
// Cleans the demo-request form: trims, lowercases email, pulls the email domain and website domain,
// uppercases the state, caps the free text (head + tail kept so a long message keeps its ending).
export function normalizeLead(raw, opts = {}) {
  const s = (v) => (v === undefined || v === null ? '' : String(v)).trim();
  const email = s(raw.email).toLowerCase();
  const emailDomain = email.includes('@') ? email.split('@').pop() : '';
  const website = s(raw.website).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const max = opts.maxChars ?? 2000;
  let message = s(raw.message).replace(/\r/g, '');
  if (message.length > max) message = message.slice(0, Math.floor(max * 0.7)) + '\n[...]\n' + message.slice(-Math.floor(max * 0.3));
  return {
    lead_id: s(raw.lead_id) || s(raw.id) || `lead-${Date.now()}`,
    first_name: s(raw.first_name), last_name: s(raw.last_name),
    email, email_domain: emailDomain,
    company: s(raw.company), website, domain: website || emailDomain,
    phone: s(raw.phone), state: s(raw.state).toUpperCase().slice(0, 2),
    team_size: s(raw.team_size), message,
    submitted_at: s(raw.submitted_at) || new Date().toISOString(),
    source: s(raw.source) || 'website_demo_form',
  };
}
