// Inlined into the "Normalize hire" Code node. BambooHR employee record -> the fields the plan needs.
// Plain JS, no imports: n8n Code nodes can't import local files, so build.mjs inlines this text.

export function emailLocalPart(first, last) {
  const clean = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return `${clean(first)}.${clean(last)}`;
}

export function normalizeHire(rec, domain) {
  const r = rec ?? {};
  const rehire = r.rehire === true || r.rehire === 'yes';
  const derived = `${emailLocalPart(r.firstName, r.lastName)}@${domain}`;
  return {
    employee_id: String(r.id ?? ''),
    first_name: r.firstName ?? '',
    last_name: r.lastName ?? '',
    preferred_name: r.preferredName || r.firstName || '',
    email: rehire && r.priorWorkEmail ? String(r.priorWorkEmail).toLowerCase() : derived,
    personal_email: r.homeEmail ?? '',
    title: String(r.jobTitle ?? '').trim(),
    department: String(r.department ?? '').trim(),
    manager: r.supervisorEmail ?? '',
    manager_name: r.supervisor ?? '',
    start_date: r.hireDate ?? '',
    end_date: r.contractEndDate || '',
    employment_type: String(r.employmentStatus ?? '').toLowerCase().includes('contract') ? 'contractor' : 'employee',
    location: r.location ?? '',
    timezone: r.timezone ?? 'America/New_York',
    rehire,
    // Free text from the hiring manager. Shown to the approver; never parsed into access.
    notes: String(r.onboardingNotes ?? ''),
  };
}
