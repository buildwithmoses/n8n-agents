// Inlined into the "Screen + score + route (code)" Code node. Plain JS, no imports.
// Deterministic screening that the model cannot argue with: spam, students, job seekers, competitors,
// and prompt injection in the free-text box. Patterns come from rules.json.
export function screenLead(lead, rules) {
  const text = `${lead.company}\n${lead.message}`.toLowerCase();
  const any = (list) => (list ?? []).some((p) => new RegExp(p, 'i').test(text));
  const urls = (lead.message.match(/https?:\/\/|www\./gi) ?? []).length;
  const flags = [];
  if (any(rules.patterns.injection)) flags.push('injection');
  const domain = (lead.domain || '').toLowerCase();
  const competitor = rules.competitors.domains.includes(lead.email_domain) || rules.competitors.domains.includes(domain)
    || rules.competitors.names.some((n) => lead.company.toLowerCase().includes(n));
  let junk = null;
  if (any(rules.patterns.spam) || urls >= 3 || (!lead.email.includes('@'))) junk = 'spam';
  else if (competitor) junk = 'competitor';
  else if (rules.student_domains_suffix.some((suf) => lead.email_domain.endsWith(suf)) || any(rules.patterns.student)) junk = 'student';
  else if (any(rules.patterns.job_seeker)) junk = 'job_seeker';
  return { junk, flags, injection: flags.includes('injection'), free_mail: rules.free_mail_domains.includes(lead.email_domain) };
}
