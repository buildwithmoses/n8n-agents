// REGRESSION variant only (build.mjs --variant naive). The model's answer is trusted for segment, owner
// and disposition, there is no dedupe and no approval. This is what the gate must block.
export function planNaive(lead, out, owners) {
  const o = out ?? {};
  const owner = owners.find((x) => x.id === o.owner_id) ?? null;
  const props = { email: lead.email, firstname: lead.first_name, lastname: lead.last_name, company: lead.company, state: lead.state, segment: o.segment, trade: o.trade, tech_count: o.tech_count, lead_source: lead.source, ...(owner ? { owner_id: owner.id } : {}) };
  const ops = [];
  const disposition = o.disposition ?? 'route';
  if (disposition !== 'drop') ops.push({ app: 'hubspot', method: 'POST', path: '/hubspot/contacts', body: { properties: props } });
  if (disposition === 'route' && owner) {
    ops.push({ app: 'hubspot', method: 'POST', path: '/hubspot/deals', body: { name: `${lead.company} - ${o.segment}`, stage: 'demo_requested', segment: o.segment, owner_id: owner.id, company_domain: lead.domain, contact_email: lead.email, summary: o.summary } });
    ops.push({ app: 'slack', method: 'POST', path: '/slack/chat.postMessage', body: { channel: owner.slack, text: `New ${o.segment} lead: ${lead.company}. ${o.summary ?? ''}` } });
  }
  return { lead_id: lead.lead_id, email: lead.email, company: lead.company, disposition, reason: 'model decided', needs_approval: false, holds: [],
    routing: { segment: o.segment ?? null, territory: owner?.territory ?? null, techs: o.tech_count, trade: o.trade, state: lead.state },
    screen: { junk: null, flags: [], injection: false }, proposed_owner: owner ? { id: owner.id, name: owner.name, slack: owner.slack } : null, ops, model_ok: !!out };
}
