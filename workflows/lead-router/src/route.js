// Inlined into the "Screen + score + route (code)" Code node. Plain JS, no imports.
// Everything that decides where a lead goes lives here, in code, reading rules.json.
// The model's only inputs are the fields it extracted from the free-text box, and those are
// thrown away entirely when the screen found instructions aimed at the AI.

export function territoryFor(state, rules) {
  for (const [name, states] of Object.entries(rules.territories)) if (states.includes(state)) return name;
  return null;
}

export function segmentFor(techs, rules) {
  return (rules.segments.find((s) => techs >= s.min_techs && techs <= s.max_techs) ?? rules.segments[0]).name;
}

const TRADE_ALIASES = {
  hvac: 'hvac', heating: 'hvac', cooling: 'hvac', 'air conditioning': 'hvac', plumbing: 'plumbing', plumber: 'plumbing',
  electrical: 'electrical', electrician: 'electrical', roofing: 'roofing', 'garage door': 'garage_door', garage_door: 'garage_door',
  'pest control': 'pest_control', pest_control: 'pest_control', 'appliance repair': 'appliance_repair', appliance_repair: 'appliance_repair',
  landscaping: 'landscaping', solar: 'solar',
};
export const normTrade = (t) => TRADE_ALIASES[String(t ?? '').toLowerCase().trim()] ?? (t ? 'other' : 'unknown');

export function scoreLead(lead, screen, extraction, enrichment, rules) {
  const ex = screen.injection || !extraction ? {} : extraction; // injection => ignore the model entirely
  const enr = enrichment && enrichment.found ? enrichment : {};
  let techs = Number.isFinite(ex.tech_count) && ex.tech_count > 0 ? Math.round(ex.tech_count) : null;
  let techSource = techs ? 'message' : null;
  if (!techs && rules.team_size_dropdown[lead.team_size]) { techs = rules.team_size_dropdown[lead.team_size]; techSource = 'form_dropdown'; }
  if (!techs && enr.field_techs) { techs = enr.field_techs; techSource = 'enrichment'; }
  if (!techs) { techs = 3; techSource = 'default'; }

  const trade = normTrade(ex.trade && ex.trade !== 'unknown' ? ex.trade : enr.industry);
  const state = lead.state || enr.state || '';
  const territory = territoryFor(state, rules);
  const segment = segmentFor(techs, rules);
  const P = rules.icp.points;
  const breakdown = {};
  if (rules.icp.core_trades.includes(trade)) breakdown.core_trade = P.core_trade;
  else if (rules.icp.adjacent_trades.includes(trade)) breakdown.adjacent_trade = P.adjacent_trade;
  if (techs >= rules.icp.tech_fit.min && techs <= rules.icp.tech_fit.max) breakdown.tech_fit = P.tech_fit;
  const tl = ex.timeline ?? 'unknown';
  if (tl === 'now') breakdown.timeline_now = P.timeline_now;
  else if (tl === 'within_30_days') breakdown.timeline_30 = P.timeline_30;
  else if (tl === '1_3_months') breakdown.timeline_90 = P.timeline_90;
  const sw = String(ex.current_software ?? '').toLowerCase();
  if (sw && rules.competitors.names.some((n) => sw.includes(n))) breakdown.switching_from_competitor = P.switching_from_competitor;
  if (territory) breakdown.us_state = P.us_state;
  if (!screen.free_mail) breakdown.business_email = P.business_email;
  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const tier = score >= rules.icp.tiers.A ? 'A' : score >= rules.icp.tiers.B ? 'B' : 'C';
  return { techs, tech_source: techSource, trade, state, territory, segment, score, tier, breakdown,
    current_software: ex.current_software ?? '', timeline: tl, summary: screen.injection ? '' : String(ex.summary ?? '').slice(0, 600) };
}

// Least-loaded owner with spare capacity in the right territory and segment. Ties break by id, so the
// same inputs always give the same owner (round robin falls out of the load counter going up).
export function pickOwner(segment, territory, owners) {
  const pool = owners.filter((o) => o.segments.includes(segment) && (o.territory === 'Any' || o.territory === territory) && o.open_leads < o.capacity);
  pool.sort((a, b) => a.open_leads / a.capacity - b.open_leads / b.capacity || a.id.localeCompare(b.id));
  return pool[0] ?? null;
}

// The plan: what to write, and whether a person must approve first. Nothing here calls an API.
export function planLead(lead, screen, routing, dedupe, owners, rules) {
  const byId = Object.fromEntries(owners.map((o) => [o.id, o]));
  const contact = dedupe?.contact ?? null;
  const company = dedupe?.company ?? null;
  const openDeal = (dedupe?.open_deals ?? [])[0] ?? null;
  const base = { lead_id: lead.lead_id, email: lead.email, company: lead.company, screen, routing, existing: { contact_id: contact?.id ?? null, contact_owner: contact?.owner_id ?? null, company_id: company?.id ?? null, is_customer: !!company?.is_customer, account_owner: company?.owner_id ?? null, open_deal_id: openDeal?.id ?? null, open_deal_owner: openDeal?.owner_id ?? null } };
  const props = { email: lead.email, firstname: lead.first_name, lastname: lead.last_name, company: lead.company, phone: lead.phone, state: routing.state, trade: routing.trade, tech_count: routing.techs, segment: routing.segment, lead_score: routing.score, lead_tier: routing.tier, lead_source: lead.source };
  const contactOp = (extra) => contact
    ? { app: 'hubspot', method: 'PATCH', path: `/hubspot/contacts/${contact.id}`, body: { properties: { ...props, ...extra } } }
    : { app: 'hubspot', method: 'POST', path: '/hubspot/contacts', body: { properties: { ...props, ...extra } } };

  if (screen.junk === 'spam') return { ...base, disposition: 'drop', reason: 'spam', needs_approval: false, ops: [] };
  if (screen.junk) {
    // Tagged, never routed: no owner, no deal, no rep DM. Existing owner on a known contact is left alone.
    return { ...base, disposition: 'tag', reason: screen.junk, needs_approval: false, ops: [contactOp({ lifecycle: 'other', tags: [screen.junk] })] };
  }
  const tags = screen.injection ? ['injection_ignored'] : [];

  if (routing.tier === 'C') {
    return { ...base, disposition: 'nurture', reason: `score ${routing.score} below tier B`, needs_approval: false,
      ops: [contactOp({ lifecycle: 'lead', nurture: true, ...(tags.length ? { tags } : {}) })] };
  }

  // Who would the rules pick? Sticky ownership: a known contact keeps its owner.
  const picked = pickOwner(routing.segment, routing.territory, owners);
  let proposed = contact?.owner_id && byId[contact.owner_id] ? byId[contact.owner_id] : picked;
  const holds = [];
  if (contact?.owner_id && !byId[contact.owner_id]) holds.push('contact_owner_inactive'); // reassigning would be an owner change
  if (company?.is_customer) { holds.push('existing_customer'); proposed = byId[company.owner_id] ?? proposed; }
  if (openDeal) {
    if (openDeal.owner_id !== proposed?.id) holds.push('open_deal_owned_by_other');
    proposed = byId[openDeal.owner_id] ?? proposed; // default proposal keeps the deal where it is
  }
  if (routing.segment === 'Enterprise') holds.push('enterprise');
  if (!routing.territory) holds.push('no_territory');
  if (!proposed) holds.push('no_owner_capacity');

  const ops = buildOps(lead, routing, proposed, openDeal, contactOp, tags);
  const plan = { ...base, disposition: holds.length ? 'hold' : 'route', reason: holds.join(', ') || `tier ${routing.tier}`, needs_approval: holds.length > 0,
    holds, proposed_owner: proposed ? { id: proposed.id, name: proposed.name, slack: proposed.slack } : null,
    rules_pick: picked ? { id: picked.id, name: picked.name } : null, ops };
  return plan;
}

export function buildOps(lead, routing, owner, openDeal, contactOp, tags = []) {
  const ownerId = owner?.id ?? null;
  const ops = [contactOp({ lifecycle: 'sales_qualified_lead', ...(ownerId ? { owner_id: ownerId } : {}), ...(tags.length ? { tags } : {}) })];
  const summary = routing.summary || `${lead.company}: ${routing.trade}, about ${routing.techs} techs, ${routing.state || 'no state'}.`;
  if (openDeal) {
    ops.push({ app: 'hubspot', method: 'POST', path: `/hubspot/deals/${openDeal.id}/notes`, body: { note: `New demo request from ${lead.email}. ${summary}` } });
  } else if (ownerId) {
    ops.push({ app: 'hubspot', method: 'POST', path: '/hubspot/deals', body: { name: `${lead.company} - ${routing.segment}`, stage: 'demo_requested', segment: routing.segment, owner_id: ownerId, company_domain: lead.domain, contact_email: lead.email, lead_score: routing.score, summary } });
  }
  if (owner) ops.push({ app: 'slack', method: 'POST', path: '/slack/chat.postMessage', body: { channel: owner.slack, text: `New ${routing.tier}-tier ${routing.segment} lead: ${lead.first_name} ${lead.last_name} at ${lead.company} (${routing.state || '??'}). ${summary}` } });
  return ops;
}

// After Dana responds. Only an explicit approve from the named approver applies anything. An owner
// different from the proposal is applied only when she names it.
export function applyApproval(plan, response, owners, rules) {
  const r = response ?? {};
  const byId = Object.fromEntries(owners.map((o) => [o.id, o]));
  if (r.approver !== rules.approver.id) return { ...plan, approved: false, decision: 'ignored', reason: `approver "${r.approver ?? ''}" is not ${rules.approver.id}`, ops: [] };
  if (r.decision !== 'approve') return { ...plan, approved: false, decision: 'rejected', reason: r.note ?? 'rejected or timed out', ops: [] };
  let owner = plan.proposed_owner ? byId[plan.proposed_owner.id] : null;
  if (r.owner_id) {
    if (!byId[r.owner_id]) return { ...plan, approved: false, decision: 'invalid_owner', reason: `unknown owner ${r.owner_id}`, ops: [] };
    owner = byId[r.owner_id];
  }
  if (!owner) return { ...plan, approved: false, decision: 'no_owner', reason: 'approved but no owner to assign', ops: [] };
  const ops = (plan.ops ?? []).map((op) => rewriteOwner(op, owner, plan));
  // Approving a different owner on an existing open deal is an explicit owner change.
  if (plan.existing.open_deal_id && owner.id !== plan.existing.open_deal_owner) {
    ops.push({ app: 'hubspot', method: 'PATCH', path: `/hubspot/deals/${plan.existing.open_deal_id}`, body: { owner_id: owner.id, approved_by: rules.approver.id } });
  }
  return { ...plan, approved: true, decision: 'approved', approved_by: r.approver, final_owner: { id: owner.id, name: owner.name }, ops };
}

function rewriteOwner(op, owner, plan) {
  const o = JSON.parse(JSON.stringify(op));
  if (o.path.startsWith('/hubspot/contacts') && o.body.properties?.owner_id !== undefined) { o.body.properties.owner_id = owner.id; o.body.properties.approved_by = 'dana'; }
  if (o.path === '/hubspot/deals') { o.body.owner_id = owner.id; o.body.approved_by = 'dana'; }
  if (o.path === '/slack/chat.postMessage') o.body.channel = owner.slack;
  return o;
}
