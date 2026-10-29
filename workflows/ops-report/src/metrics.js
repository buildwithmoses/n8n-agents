// Every metric in the weekly ops report is computed HERE, in code, from raw source payloads.
// The model never computes a number; it only writes about this object.
// Plain JS, no imports (inlined into the "Compute metrics" Code node; tests import it directly).
//
// A source that errors, times out, returns a non-2xx status, or returns no data for a week is MISSING:
// its metrics are null (never 0), it is listed in `missing`, and no anomaly is computed from it.

export const SOURCES = ['stripe', 'hubspot', 'zendesk', 'linear', 'github'];
export const SOURCE_NAMES = { stripe: 'Stripe', hubspot: 'HubSpot', zendesk: 'Zendesk', linear: 'Linear', github: 'GitHub' };
export const SLA_FIRST_REPLY_MINUTES = { urgent: 60, high: 240, normal: 480, low: 1440 };

// Anomaly thresholds (written definitions; README mirrors these).
export const THRESHOLDS = {
  churn_spike: { ratio: 2, min_usd: 1500 },      // churned MRR > 2x last week AND > $1,500
  mrr_contraction: { below: 0 },                // net new MRR < 0
  sla_spike: { rate_pct: 10, ratio: 2, min: 10 }, // breach rate > 10%, OR breaches >= 2x last week and >= 10
  csat_drop: { below_pct: 85 },                 // CSAT < 85%
  deploy_failures: { count: 3, rate_pct: 15 },  // failed prod deploys >= 3 OR failure rate > 15%
  p0_bugs: { count: 2 },                        // urgent (P0) bugs opened >= 2
  win_rate_drop: { points: 15 },                // win rate down more than 15 points
  pipeline_drop: { pct: 25 },                   // new pipeline down more than 25%
};

export const METRIC_DEFS = {
  mrr_end: { source: 'stripe', label: 'MRR (end of week)', unit: 'usd' },
  new_mrr: { source: 'stripe', label: 'New MRR', unit: 'usd' },
  expansion_mrr: { source: 'stripe', label: 'Expansion MRR', unit: 'usd' },
  contraction_mrr: { source: 'stripe', label: 'Contraction MRR', unit: 'usd' },
  churned_mrr: { source: 'stripe', label: 'Churned MRR', unit: 'usd' },
  net_new_mrr: { source: 'stripe', label: 'Net new MRR', unit: 'usd' },
  new_customers: { source: 'stripe', label: 'New customers', unit: 'count' },
  churned_customers: { source: 'stripe', label: 'Churned customers', unit: 'count' },
  deals_created: { source: 'hubspot', label: 'Deals created', unit: 'count' },
  pipeline_created_usd: { source: 'hubspot', label: 'New pipeline', unit: 'usd' },
  won_count: { source: 'hubspot', label: 'Deals won', unit: 'count' },
  won_usd: { source: 'hubspot', label: 'Won value', unit: 'usd' },
  lost_count: { source: 'hubspot', label: 'Deals lost', unit: 'count' },
  win_rate_pct: { source: 'hubspot', label: 'Win rate', unit: 'pct' },
  tickets: { source: 'zendesk', label: 'Tickets', unit: 'count' },
  sla_breaches: { source: 'zendesk', label: 'First-reply SLA breaches', unit: 'count' },
  sla_breach_rate_pct: { source: 'zendesk', label: 'SLA breach rate', unit: 'pct' },
  csat_pct: { source: 'zendesk', label: 'CSAT', unit: 'pct' },
  bugs_opened: { source: 'linear', label: 'Bugs opened', unit: 'count' },
  bugs_closed: { source: 'linear', label: 'Bugs closed', unit: 'count' },
  p0_bugs_opened: { source: 'linear', label: 'P0 bugs opened', unit: 'count' },
  deploys: { source: 'github', label: 'Production deploys', unit: 'count' },
  failed_deploys: { source: 'github', label: 'Failed deploys', unit: 'count' },
  deploy_failure_rate_pct: { source: 'github', label: 'Deploy failure rate', unit: 'pct' },
};

const r1 = (x) => Math.round(x * 10) / 10;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pct = (num, den) => (den > 0 ? r1((num / den) * 100) : null);

export function fmtUsd(v) {
  if (v === null || v === undefined) return 'missing';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 100000) return `${sign}$${r1(a / 1000).toFixed(1)}K`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}
export function fmtValue(v, unit) {
  if (v === null || v === undefined) return 'missing';
  if (unit === 'usd') return fmtUsd(v);
  if (unit === 'pct') return `${v.toFixed(1)}%`;
  return String(v);
}

// ---- per-source computations: one week's raw payload -> numbers (definitions) ----
export const COMPUTE = {
  stripe(p) {
    const ev = p.events ?? [];
    const created = ev.filter((e) => e.type === 'customer.subscription.created');
    const deleted = ev.filter((e) => e.type === 'customer.subscription.deleted');
    const updated = ev.filter((e) => e.type === 'customer.subscription.updated');
    const new_mrr = sum(created.map((e) => e.mrr_change));
    const churned_mrr = -sum(deleted.map((e) => e.mrr_change));
    const expansion_mrr = sum(updated.filter((e) => e.mrr_change > 0).map((e) => e.mrr_change));
    const contraction_mrr = -sum(updated.filter((e) => e.mrr_change < 0).map((e) => e.mrr_change));
    return {
      mrr_end: p.mrr_at_week_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
      net_new_mrr: new_mrr + expansion_mrr - contraction_mrr - churned_mrr,
      new_customers: created.length, churned_customers: deleted.length,
    };
  },
  hubspot(p) {
    const created = p.deals_created ?? []; const closed = p.deals_closed ?? [];
    const won = closed.filter((d) => d.dealstage === 'closedwon'); const lost = closed.filter((d) => d.dealstage === 'closedlost');
    return {
      deals_created: created.length, pipeline_created_usd: sum(created.map((d) => d.amount)),
      won_count: won.length, won_usd: sum(won.map((d) => d.amount)), lost_count: lost.length,
      win_rate_pct: pct(won.length, won.length + lost.length),
    };
  },
  zendesk(p) {
    const t = p.tickets ?? [];
    const breached = t.filter((x) => x.first_reply_time_minutes === null || x.first_reply_time_minutes === undefined
      || x.first_reply_time_minutes > (SLA_FIRST_REPLY_MINUTES[x.priority] ?? SLA_FIRST_REPLY_MINUTES.normal));
    const good = t.filter((x) => x.satisfaction_rating?.score === 'good').length;
    const bad = t.filter((x) => x.satisfaction_rating?.score === 'bad').length;
    return { tickets: t.length, sla_breaches: breached.length, sla_breach_rate_pct: pct(breached.length, t.length), csat_pct: pct(good, good + bad) };
  },
  linear(p) {
    const bug = (i) => (i.labels ?? []).includes('bug');
    const opened = (p.issues_created ?? []).filter(bug); const closed = (p.issues_completed ?? []).filter(bug);
    return { bugs_opened: opened.length, bugs_closed: closed.length, p0_bugs_opened: opened.filter((i) => i.priority === 1).length };
  },
  github(p) {
    const prod = (p.deployments ?? []).filter((d) => d.environment === 'production');
    const failed = prod.filter((d) => d.state === 'failure' || d.state === 'error').length;
    return { deploys: prod.length, failed_deploys: failed, deploy_failure_rate_pct: pct(failed, prod.length) };
  },
};

// Decide whether a source response (from an HTTP Request node with fullResponse + neverError) is usable.
export function sourceStatus(resp, week) {
  if (!resp || resp.error) return { ok: false, reason: `request failed: ${String(resp?.error?.message ?? resp?.error ?? 'no response').slice(0, 120)}` };
  const code = resp.statusCode ?? 200;
  if (code < 200 || code >= 300) return { ok: false, reason: `HTTP ${code}` };
  const body = resp.body ?? resp;
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') return { ok: false, reason: 'empty response' };
  if (!body.data[week]) return { ok: false, reason: `no data for ${week}` };
  return { ok: true, body };
}

function anomalies(cur, prev) {
  const out = []; const T = THRESHOLDS; const has = (k) => cur[k] !== null && cur[k] !== undefined; const hp = (k) => prev[k] !== null && prev[k] !== undefined;
  if (has('churned_mrr') && hp('churned_mrr') && cur.churned_mrr > T.churn_spike.ratio * prev.churned_mrr && cur.churned_mrr > T.churn_spike.min_usd)
    out.push({ code: 'churn_spike', message: `Churned MRR ${fmtUsd(cur.churned_mrr)} vs ${fmtUsd(prev.churned_mrr)} last week (${r1(cur.churned_mrr / prev.churned_mrr).toFixed(1)}x), ${cur.churned_customers} customers lost` });
  if (has('net_new_mrr') && cur.net_new_mrr < T.mrr_contraction.below)
    out.push({ code: 'mrr_contraction', message: `Net new MRR was negative: ${fmtUsd(cur.net_new_mrr)}` });
  if (has('sla_breaches') && (cur.sla_breach_rate_pct > T.sla_spike.rate_pct || (hp('sla_breaches') && cur.sla_breaches >= T.sla_spike.ratio * prev.sla_breaches && cur.sla_breaches >= T.sla_spike.min)))
    out.push({ code: 'sla_spike', message: `${cur.sla_breaches} first-reply SLA breaches (${fmtValue(cur.sla_breach_rate_pct, 'pct')} of tickets) vs ${prev.sla_breaches ?? 'missing'} last week` });
  if (has('csat_pct') && cur.csat_pct < T.csat_drop.below_pct)
    out.push({ code: 'csat_drop', message: `CSAT fell to ${fmtValue(cur.csat_pct, 'pct')}${hp('csat_pct') ? ` from ${fmtValue(prev.csat_pct, 'pct')}` : ''}` });
  if (has('failed_deploys') && (cur.failed_deploys >= T.deploy_failures.count || cur.deploy_failure_rate_pct > T.deploy_failures.rate_pct))
    out.push({ code: 'deploy_failures', message: `${cur.failed_deploys} of ${cur.deploys} production deploys failed (${fmtValue(cur.deploy_failure_rate_pct, 'pct')})` });
  if (has('p0_bugs_opened') && cur.p0_bugs_opened >= T.p0_bugs.count)
    out.push({ code: 'p0_bugs', message: `${cur.p0_bugs_opened} P0 bugs opened` });
  if (has('win_rate_pct') && hp('win_rate_pct') && prev.win_rate_pct - cur.win_rate_pct > T.win_rate_drop.points)
    out.push({ code: 'win_rate_drop', message: `Win rate fell to ${fmtValue(cur.win_rate_pct, 'pct')} from ${fmtValue(prev.win_rate_pct, 'pct')}` });
  if (has('pipeline_created_usd') && hp('pipeline_created_usd') && prev.pipeline_created_usd > 0 && (prev.pipeline_created_usd - cur.pipeline_created_usd) / prev.pipeline_created_usd * 100 > T.pipeline_drop.pct)
    out.push({ code: 'pipeline_drop', message: `New pipeline fell to ${fmtUsd(cur.pipeline_created_usd)} from ${fmtUsd(prev.pipeline_created_usd)}` });
  return out;
}

// Customer text is UNTRUSTED. It is passed through as quotes only, never as instructions, and it never
// contributes numbers the narrative may use.
function customerVoice(zendeskPayload) {
  return (zendeskPayload?.tickets ?? []).filter((t) => t.priority === 'urgent' || t.priority === 'high').slice(0, 4)
    .map((t) => ({ ticket: t.id, priority: t.priority, subject: String(t.subject ?? '').slice(0, 120), excerpt: String(t.excerpt ?? '').slice(0, 300) }));
}

/**
 * @param {{week:string, prev_week:string, week_range:string}} w
 * @param {Record<string, any>} responses  source -> HTTP Request output ({statusCode, body} or {error})
 * @param {{naive?: boolean}} opts  naive = the regression: a failed source counts as zeros
 */
export function computeReport(w, responses, opts = {}) {
  const cur = {}; const prev = {}; const missing = []; const sources = {}; let voice = [];
  for (const s of SOURCES) {
    const st = sourceStatus(responses[s], w.week);
    sources[s] = st.ok ? 'ok' : st.reason;
    const keys = Object.keys(METRIC_DEFS).filter((k) => METRIC_DEFS[k].source === s);
    if (!st.ok) {
      if (!opts.naive) missing.push(s);
      for (const k of keys) { cur[k] = opts.naive ? 0 : null; prev[k] = opts.naive ? 0 : null; }
      continue;
    }
    Object.assign(cur, COMPUTE[s](st.body.data[w.week]));
    const pp = st.body.data[w.prev_week];
    if (pp) Object.assign(prev, COMPUTE[s](pp)); else for (const k of keys) prev[k] = null;
    if (s === 'zendesk') voice = customerVoice(st.body.data[w.week]);
  }
  const metrics = {};
  for (const [k, def] of Object.entries(METRIC_DEFS)) {
    const v = cur[k] ?? null; const p = prev[k] ?? null;
    const m = { label: def.label, source: SOURCE_NAMES[def.source], value: v, display: fmtValue(v, def.unit), prev: p, prev_display: fmtValue(p, def.unit) };
    if (v !== null && p !== null) {
      if (def.unit === 'pct') { m.change_pts = r1(v - p); m.change_display = `${m.change_pts >= 0 ? '+' : ''}${m.change_pts.toFixed(1)} pts`; }
      else {
        m.change = v - p; m.change_display = `${m.change >= 0 ? '+' : '-'}${def.unit === 'usd' ? fmtUsd(Math.abs(m.change)) : Math.abs(m.change)}`;
        if (p !== 0) { m.change_pct = r1(((v - p) / Math.abs(p)) * 100); m.change_display += ` (${m.change_pct >= 0 ? '+' : ''}${m.change_pct.toFixed(1)}%)`; }
      }
    }
    metrics[k] = m;
  }
  if (cur.mrr_end != null && prev.mrr_end != null && prev.mrr_end > 0) metrics.mrr_end.growth_pct = r1(((cur.mrr_end - prev.mrr_end) / prev.mrr_end) * 100);
  const an = anomalies(cur, prev);
  return {
    week: w.week, prev_week: w.prev_week, week_range: w.week_range,
    sources, missing, missing_names: missing.map((s) => SOURCE_NAMES[s]),
    sources_ok: SOURCES.length - missing.length, sources_total: SOURCES.length,
    metrics, anomalies: an, anomaly_count: an.length,
    customer_voice: voice,
  };
}
