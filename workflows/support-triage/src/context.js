// Builds the model input from the fetched Zendesk + Stripe records. Plain JS; build.mjs inlines it
// together with policy.js and guardrail.js.

export function prepareContext({ ticket, user, organization, customer, articles }) {
  const tier = normalizeTier(customer?.metadata?.plan);
  const mrrCents = Number(customer?.metadata?.mrr_cents ?? 0);
  const name = String(user?.name ?? '').trim();
  const list = (articles ?? []).map((a) => ({ id: a.id, title: a.title, body: a.body }));
  const text = customerText(ticket);
  const articleText = list.map((a) => `[${a.id}] ${a.title}\n${a.body}`).join('\n\n');
  // The ticket is wrapped as data. Angle brackets are escaped so a ticket can't close the tag early.
  const esc = (s) => String(s ?? '').replace(/</g, '‹').replace(/>/g, '›');
  const modelInput = [
    `<account>\nCompany: ${organization?.name ?? 'unknown'}\nPlan: ${tier}\nRequester: ${name || 'unknown'}\n</account>`,
    `<help_center_articles>\n${articleText}\n</help_center_articles>`,
    `<ticket id="${ticket?.id}">\nSubject: ${esc(ticket?.subject)}\n\n${esc(ticket?.description)}\n</ticket>`,
  ].join('\n\n');
  return {
    ticket_id: ticket?.id, subject: ticket?.subject ?? '', created_at: ticket?.created_at,
    requester_name: name, requester_first: name.split(/\s+/)[0] ?? '', org_name: organization?.name ?? '',
    tier, mrr_cents: mrrCents, article_ids: list.map((a) => a.id), article_text: Object.fromEntries(list.map((a) => [a.id, a.body])), text,
    injection: detectInjection(text), model_input: modelInput,
  };
}
