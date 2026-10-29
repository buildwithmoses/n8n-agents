// Outage dedupe (POLICY.md section 8). Plain JS, no imports.
// recent: tickets already tagged `outage` (from Zendesk search), each { id, created_at }.
// openIncidents: open Linear outage incidents, each { id, identifier, created_at }.
export const OUTAGE_WINDOW_MIN = 30;
export const OUTAGE_THRESHOLD = 3;

export function windowStart(createdAt, minutes = OUTAGE_WINDOW_MIN) {
  return new Date(new Date(createdAt).getTime() - minutes * 60000).toISOString();
}

export function outageDecision({ ticketId, createdAt, outage, recent, openIncidents }) {
  if (!outage) return { action: 'none', count: 0 };
  const t = new Date(createdAt).getTime();
  const from = t - OUTAGE_WINDOW_MIN * 60000;
  const inWindow = (recent ?? []).filter((r) => String(r.id) !== String(ticketId))
    .filter((r) => { const x = new Date(r.created_at).getTime(); return x >= from && x <= t; });
  const ids = [...inWindow.map((r) => r.id), ticketId];
  const open = (openIncidents ?? []).filter((i) => i && i.id);
  if (open.length) {
    const incident = open.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    return { action: 'link', incident_id: incident.id, incident_identifier: incident.identifier, count: ids.length, ticket_ids: [ticketId] };
  }
  if (ids.length >= OUTAGE_THRESHOLD) return { action: 'create', count: ids.length, ticket_ids: ids };
  return { action: 'none', count: ids.length };
}
