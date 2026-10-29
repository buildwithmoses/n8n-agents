import { routes, _test } from '../mock.mjs';
import { computeReport } from '../src/metrics.js';
import { resolveWeek } from '../src/week.js';
export const FX = _test.FX;
export const KEYS = { stripe: 'GET /stripe/v1/weekly', hubspot: 'GET /hubspot/crm/v3/weekly', zendesk: 'GET /zendesk/api/v2/weekly', linear: 'GET /linear/weekly', github: 'GET /github/repos/fernhill/dispatch/deployments/weekly' };
// What the HTTP Request nodes hand to "Compute metrics" (fullResponse + neverError).
export function responsesFor(week) {
  const w = resolveWeek(week, new Date());
  const q = { query: { weeks: `${w.week},${w.prev_week}` } };
  const resp = {};
  for (const [s, k] of Object.entries(KEYS)) { const r = routes[k](q); resp[s] = r.__status ? { statusCode: r.__status, body: r.body } : { statusCode: 200, body: r }; }
  return { w, resp };
}
export function reportFor(week, opts) { const { w, resp } = responsesFor(week); return computeReport(w, resp, opts); }
