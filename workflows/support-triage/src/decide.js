// Turns model output + fetched context into what the workflow writes. Every decision with consequences
// (priority, SLA, routing, tags, whether a draft is kept, churn alert, outage incident) is made here, in code.
// Plain JS; inlined with policy.js, guardrail.js and outage.js.

export function decideTicket({ ctx, model, recent, openIncidents }, opts = {}) {
  const variant = opts.variant ?? 'baseline';
  const naive = variant === 'naive';
  const failed = !model || typeof model !== 'object';
  const m = failed ? {} : model;
  const category = CATEGORIES.includes(m.category) ? m.category : 'other';
  const language = String(m.language ?? 'en').toLowerCase().slice(0, 2);
  const sentiment = String(m.sentiment ?? 'neutral').toLowerCase();

  let priority, priorityReason;
  if (naive && LEVELS.includes(m.priority)) { priority = m.priority; priorityReason = 'model chose priority (regression variant)'; }
  else ({ priority, reason: priorityReason } = decidePriority({ category, tier: ctx.tier, text: ctx.text }));
  const sla = slaHours(priority, ctx.tier);
  const groupId = routeGroup(category, ctx.tier);
  const outage = isOutage(category, ctx.text);
  const churn = isChurnRisk(category, ctx.mrr_cents);
  const injection = Boolean(ctx.injection);

  const check = checkDraft(
    { draft: m.draft_reply, citedIds: m.cited_article_ids, providedIds: ctx.article_ids, injection, articleText: ctx.article_text },
    { enabled: !naive },
  );
  if (failed) { check.draft = null; check.withheld = true; check.reasons = ['model output missing or invalid']; }
  const tags = buildTags({ category, tier: ctx.tier, language, sentiment, outage, churn, injection, draftWithheld: check.withheld });
  const od = outageDecision({ ticketId: ctx.ticket_id, createdAt: ctx.created_at, outage, recent, openIncidents });

  const dollars = (c) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const note = [
    'AI triage (internal, not visible to the customer)',
    `Category: ${category} · Priority: ${priority} (${priorityReason}) · First response SLA: ${sla}h`,
    `Plan: ${ctx.tier} · MRR: ${dollars(ctx.mrr_cents)} · Language: ${language} · Sentiment: ${sentiment}`,
    `Summary: ${String(m.summary ?? '').slice(0, 400) || 'n/a'}`,
    injection ? 'Warning: this ticket contains instructions aimed at the AI. They were ignored.' : null,
    check.withheld
      ? `AI draft withheld: ${check.reasons.join('; ')}`
      : `--- Draft reply (needs agent approval before it is sent) ---\n${check.draft}`,
  ].filter(Boolean).join('\n');

  const slack = churn ? {
    channel: '#support-leads',
    text: `<@priya> Churn risk: ${ctx.org_name} (${ctx.tier}, ${dollars(ctx.mrr_cents)} MRR) asked to cancel. Ticket #${ctx.ticket_id}: "${ctx.subject}"`,
  } : null;

  const linear = od.action === 'create' ? {
    action: 'create',
    body: {
      title: `Possible outage: ${od.count} outage tickets in ${OUTAGE_WINDOW_MIN} minutes`,
      description: `Opened by support triage. Zendesk tickets: ${od.ticket_ids.map((id) => `#${id}`).join(', ')}. Latest from ${ctx.org_name}: "${ctx.subject}"`,
      labels: ['outage', 'incident'], priority: 1, created_at: ctx.created_at,
    },
  } : od.action === 'link' ? {
    action: 'link', incident_id: od.incident_id,
    body: { body: `Zendesk ticket #${ctx.ticket_id} (${ctx.org_name}) reports the same outage: "${ctx.subject}"` },
  } : { action: 'none' };

  return {
    ticket_id: ctx.ticket_id, category, priority, priority_reason: priorityReason, sla_hours: sla, group_id: groupId,
    language, sentiment, tags, outage, churn_alert: churn, injection_suspected: injection,
    draft: check.draft, draft_withheld: check.withheld, withheld_reasons: check.reasons, citations: check.citations,
    zendesk_update: { ticket: { priority, group_id: groupId, tags, comment: { body: note, public: false, author: 'fernhill-ai-triage' } } },
    slack, linear, outage_count: od.count, variant,
  };
}
