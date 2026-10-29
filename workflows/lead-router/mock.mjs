// Mock HubSpot, Slack and enrichment for the lead router. Loaded by mock/server.mjs.
// State is in memory and re-seeded after POST /_reset?app=hubspot. Everything is fictional.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(HERE, 'rules.json'), 'utf8'));

export const ENRICH = {
  'bluebirdhvac.example': { name: 'Bluebird Heating & Air', industry: 'hvac', employees: 34, field_techs: 22, state: 'NC', city: 'Durham' },
  'copperline.example': { name: 'Copperline Plumbing', industry: 'plumbing', employees: 18, field_techs: 11, state: 'OH', city: 'Dayton' },
  'summitelectric.example': { name: 'Summit Electric Co', industry: 'electrical', employees: 21, field_techs: 14, state: 'CO', city: 'Boulder' },
  'ridgewayplumbing.example': { name: 'Ridgeway Plumbing', industry: 'plumbing', employees: 9, field_techs: 6, state: 'PA', city: 'Allentown' },
  'oakmontair.example': { name: 'Oakmont Air', industry: 'hvac', employees: 12, field_techs: 8, state: 'GA', city: 'Macon' },
  'brightwire.example': { name: 'Brightwire Electric', industry: 'electrical', employees: 6, field_techs: 4, state: 'TX', city: 'Waco' },
  'pinecrestmech.example': { name: 'Pinecrest Mechanical', industry: 'hvac', employees: 140, field_techs: 95, state: 'IL', city: 'Naperville' },
  'harborflow.example': { name: 'Harbor Flow Plumbing', industry: 'plumbing', employees: 15, field_techs: 10, state: 'WA', city: 'Tacoma' },
  'lonestarcomfort.example': { name: 'Lone Star Comfort Systems', industry: 'hvac', employees: 260, field_techs: 180, state: 'TX', city: 'Austin' },
  'greenleafpest.example': { name: 'Greenleaf Pest Control', industry: 'pest_control', employees: 11, field_techs: 7, state: 'FL', city: 'Ocala' },
  'mesaroofing.example': { name: 'Mesa Roofing', industry: 'roofing', employees: 25, field_techs: 16, state: 'AZ', city: 'Mesa' },
  'keystonevolt.example': { name: 'Keystone Volt', industry: 'electrical', employees: 30, field_techs: 19, state: 'MN', city: 'Rochester' },
  'tidewaterhvac.example': { name: 'Tidewater HVAC', industry: 'hvac', employees: 8, field_techs: 5, state: 'VA', city: 'Norfolk' },
  'wrenchly.example': { name: 'Wrenchly', industry: 'software', employees: 220, state: 'CA', city: 'San Jose' },
  'northpinecafe.example': { name: 'North Pine Cafe', industry: 'restaurant', employees: 9, state: 'OR', city: 'Bend' },
  'cascadeplumbing.example': { name: 'Cascade Plumbing & Drain', industry: 'plumbing', employees: 48, field_techs: 31, state: 'OR', city: 'Salem' },
  'prairiefire.example': { name: 'Prairie Fire Heating', industry: 'hvac', employees: 14, field_techs: 9, state: 'KS', city: 'Wichita' },
  'maplegarage.example': { name: 'Maple Garage Doors', industry: 'garage_door', employees: 7, field_techs: 4, state: 'MI', city: 'Lansing' },
};

function seed(store) {
  if (store.seeded) return;
  store.seeded = true;
  const load = { 'own-ava': 12, 'own-jules': 9, 'own-tariq': 14, 'own-mei': 11, 'own-rhys': 7, 'own-noor': 10, 'own-gideon': 6, 'own-celia': 8 };
  store.owners = rules.owners.map((o) => ({ ...o, open_leads: load[o.id] ?? 0 }));
  store.companies = [
    { id: 'co-1', name: 'Bluebird Heating & Air', domain: 'bluebirdhvac.example', is_customer: true, plan: 'Pro', owner_id: 'own-ava' },
    { id: 'co-2', name: 'Copperline Plumbing', domain: 'copperline.example', is_customer: false, owner_id: 'own-tariq' },
    { id: 'co-3', name: 'Summit Electric Co', domain: 'summitelectric.example', is_customer: false, owner_id: 'own-gideon' },
    { id: 'co-4', name: 'Ridgeway Plumbing', domain: 'ridgewayplumbing.example', is_customer: false, owner_id: 'own-jules' },
    { id: 'co-5', name: 'Prairie Fire Heating', domain: 'prairiefire.example', is_customer: false, owner_id: 'own-former' },
  ];
  store.contacts = [
    { id: 'c-1', email: 'wes@bluebirdhvac.example', company_domain: 'bluebirdhvac.example', owner_id: 'own-ava', lifecycle: 'customer' },
    { id: 'c-2', email: 'maria@copperline.example', company_domain: 'copperline.example', owner_id: 'own-tariq', lifecycle: 'opportunity' },
    { id: 'c-3', email: 'tom@ridgewayplumbing.example', company_domain: 'ridgewayplumbing.example', owner_id: 'own-jules', lifecycle: 'lead' },
    { id: 'c-4', email: 'hank@prairiefire.example', company_domain: 'prairiefire.example', owner_id: 'own-former', lifecycle: 'lead' },
  ];
  store.deals = [
    { id: 'd-100', name: 'Copperline Plumbing - Pro', company_domain: 'copperline.example', owner_id: 'own-tariq', stage: 'demo_scheduled', open: true },
    { id: 'd-101', name: 'Summit Electric Co - Pro', company_domain: 'summitelectric.example', owner_id: 'own-gideon', stage: 'proposal', open: true },
  ];
  store.notes = []; store.owner_changes = []; store.messages = []; store.next = 1000;
}

const hub = (fn) => (req, ctx) => { seed(ctx.store); return fn(req, ctx.store); };

export const routes = {
  'GET /enrich/company': (req) => {
    const d = ENRICH[String(req.query.domain ?? '').toLowerCase()];
    return d ? { found: true, domain: req.query.domain, ...d } : { found: false, domain: req.query.domain ?? '' };
  },
  'GET /hubspot/owners': hub((req, s) => ({ owners: s.owners })),
  'GET /hubspot/lookup': hub((req, s) => {
    const email = String(req.query.email ?? '').toLowerCase();
    const domain = String(req.query.domain ?? '').toLowerCase();
    const contact = s.contacts.find((c) => c.email === email) ?? null;
    const company = domain ? s.companies.find((c) => c.domain === domain) ?? null : null;
    const open_deals = domain ? s.deals.filter((d) => d.company_domain === domain && d.open) : [];
    return { contact, company, open_deals };
  }),
  'POST /hubspot/contacts': hub((req, s) => {
    const p = req.body.properties ?? {};
    const c = { id: `c-${++s.next}`, email: String(p.email ?? '').toLowerCase(), company_domain: String(p.email ?? '').split('@')[1] ?? '', owner_id: p.owner_id ?? null, ...p };
    s.contacts.push(c);
    return { id: c.id, created: true };
  }),
  'PATCH /hubspot/contacts/:id': hub((req, s) => {
    const c = s.contacts.find((x) => x.id === req.params.id);
    if (!c) return { __status: 404, body: { error: 'contact not found' } };
    const p = req.body.properties ?? {};
    if (p.owner_id !== undefined && p.owner_id !== c.owner_id) s.owner_changes.push({ object: 'contact', id: c.id, from: c.owner_id, to: p.owner_id, approved_by: p.approved_by ?? null, email: c.email });
    Object.assign(c, p);
    return { id: c.id, updated: true };
  }),
  'POST /hubspot/deals': hub((req, s) => {
    const d = { id: `d-${++s.next}`, open: true, ...req.body };
    s.deals.push(d);
    const o = s.owners.find((x) => x.id === d.owner_id); if (o) o.open_leads += 1;
    return { id: d.id, created: true };
  }),
  'PATCH /hubspot/deals/:id': hub((req, s) => {
    const d = s.deals.find((x) => x.id === req.params.id);
    if (!d) return { __status: 404, body: { error: 'deal not found' } };
    if (req.body.owner_id !== undefined && req.body.owner_id !== d.owner_id) s.owner_changes.push({ object: 'deal', id: d.id, from: d.owner_id, to: req.body.owner_id, approved_by: req.body.approved_by ?? null, domain: d.company_domain });
    Object.assign(d, req.body);
    return { id: d.id, updated: true };
  }),
  'POST /hubspot/deals/:id/notes': hub((req, s) => { s.notes.push({ deal_id: req.params.id, ...req.body }); return { ok: true }; }),
  'POST /slack/chat.postMessage': (req, ctx) => { (ctx.store.messages ??= []).push(req.body); return { ok: true, channel: req.body.channel, ts: String(Date.now() / 1000) }; },
  'GET /hubspot/_audit': hub((req, s) => ({ contacts: s.contacts, deals: s.deals, notes: s.notes, owner_changes: s.owner_changes, owners: s.owners })),
};
