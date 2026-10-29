// Mock routes for support-triage: Zendesk (tickets, users, orgs, search, Help Center), Stripe customers,
// Linear incidents, Slack messages. Shapes follow the real APIs closely enough that going live means
// swapping the base URL and attaching credentials (Linear's real API is GraphQL; see README).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'zendesk.json'), 'utf8'));

function seed(store) {
  if (store.tickets) return store;
  store.tickets = {};
  for (const t of FIX.tickets) {
    const org = FIX.organizations[t.org - 1];
    const user = FIX.users.find((u) => u.organization_id === org.id);
    store.tickets[t.ticket_id] = {
      id: t.ticket_id, subject: t.subject, description: t.description, requester_id: user.id, organization_id: org.id,
      created_at: t.created_at, status: 'new', priority: null, group_id: null, tags: [], comments: [],
    };
  }
  return store;
}
const notFound = (what) => ({ __status: 404, body: { error: 'RecordNotFound', description: `${what} not found` } });

export const routes = {
  'GET /zendesk/api/v2/tickets/:id.json': ({ params }, { store }) => {
    const t = seed(store).tickets[params.id];
    return t ? { ticket: { ...t, comments: undefined } } : notFound('ticket');
  },
  'PUT /zendesk/api/v2/tickets/:id.json': ({ params, body }, { store }) => {
    const t = seed(store).tickets[params.id];
    if (!t) return notFound('ticket');
    const u = body?.ticket ?? {};
    for (const k of ['priority', 'group_id', 'status', 'type']) if (u[k] !== undefined) t[k] = u[k];
    if (Array.isArray(u.tags)) t.tags = [...u.tags];
    if (Array.isArray(u.additional_tags)) t.tags = [...new Set([...t.tags, ...u.additional_tags])];
    if (u.comment?.body) t.comments.push({ body: u.comment.body, public: u.comment.public !== false, author: u.comment.author ?? 'api', at: new Date().toISOString() });
    return { ticket: { ...t, comments: undefined }, audit: { comments: t.comments.length } };
  },
  'GET /zendesk/api/v2/users/:id.json': ({ params }) => {
    const u = FIX.users.find((x) => String(x.id) === params.id);
    return u ? { user: u } : notFound('user');
  },
  'GET /zendesk/api/v2/organizations/:id.json': ({ params }) => {
    const o = FIX.organizations.find((x) => String(x.id) === params.id);
    return o ? { organization: o } : notFound('organization');
  },
  // Zendesk Guide. The real endpoint is /api/v2/help_center/articles.json (paged); 12 articles fit one page.
  'GET /zendesk/api/v2/help_center/articles.json': () => ({ articles: FIX.articles, count: FIX.articles.length }),
  // Supports the subset of Zendesk search syntax the workflow uses: type:ticket tags:<tag> created><iso> created<<iso>
  'GET /zendesk/api/v2/search.json': ({ query }, { store }) => {
    const q = String(query.query ?? '');
    const tag = q.match(/tags:(\S+)/)?.[1];
    const after = q.match(/created>(\S+)/)?.[1];
    const before = q.match(/created<(\S+)/)?.[1];
    const results = Object.values(seed(store).tickets)
      .filter((t) => !tag || t.tags.includes(tag))
      .filter((t) => !after || t.created_at > after)
      .filter((t) => !before || t.created_at < before)
      .map((t) => ({ id: t.id, created_at: t.created_at, tags: t.tags, result_type: 'ticket' }));
    return { results, count: results.length };
  },
  'GET /stripe/v1/customers/:id': ({ params }) => {
    const c = FIX.stripe_customers.find((x) => x.id === params.id);
    if (!c) return { __status: 404, body: { error: { type: 'invalid_request_error', message: `No such customer: ${params.id}` } } };
    return { id: c.id, object: 'customer', name: c.name, currency: c.currency, metadata: { plan: c.plan, mrr_cents: String(c.mrr_cents) } };
  },
  'GET /linear/issues': ({ query }, { store }) => {
    const issues = (store.issues ?? []).filter((i) => (!query.label || i.labels.includes(query.label)) && (!query.state || i.state === query.state));
    return { issues };
  },
  'POST /linear/issues': ({ body }, { store }) => {
    store.issues ??= [];
    const n = store.issues.length + 1;
    const issue = { id: `lin_${n}`, identifier: `SUP-${100 + n}`, title: body.title, description: body.description, labels: body.labels ?? [], priority: body.priority ?? 0, state: 'open', created_at: body.created_at ?? new Date().toISOString(), comments: [] };
    store.issues.push(issue);
    return { issue };
  },
  'POST /linear/issues/:id/comments': ({ params, body }, { store }) => {
    const issue = (store.issues ?? []).find((i) => i.id === params.id);
    if (!issue) return { __status: 404, body: { error: 'issue not found' } };
    issue.comments.push({ body: body.body });
    return { comment: { id: `${issue.id}_c${issue.comments.length}`, body: body.body } };
  },
  'POST /slack/api/chat.postMessage': ({ body }) => ({ ok: true, channel: body.channel, ts: String(Date.now() / 1000), message: { text: body.text } }),
};
