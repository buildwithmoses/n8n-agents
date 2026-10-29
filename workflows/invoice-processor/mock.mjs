// Mock QuickBooks Online + Slack routes for the invoice processor (loaded by mock/server.mjs).
// State lives in memory per app; POST /_reset?app=quickbooks restores the seed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const seed = () => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/quickbooks-seed.json'), 'utf8'));
const qb = (store) => { if (!store.vendors) Object.assign(store, seed(), { nextBill: 6001 }); return store; };

export const routes = {
  'GET /quickbooks/vendors': (_req, { store }) => ({ vendors: qb(store).vendors }),
  'GET /quickbooks/purchaseorders': (_req, { store }) => ({ purchase_orders: qb(store).purchase_orders }),
  'GET /quickbooks/bills': (req, { store }) => {
    const s = qb(store);
    return { bills: s.bills.filter((b) => !req.query.vendor_id || b.vendor_id === req.query.vendor_id) };
  },
  'POST /quickbooks/bills': (req, { store }) => {
    const s = qb(store);
    const b = req.body ?? {};
    if (!b.vendor_id || !b.doc_number || typeof b.total !== 'number') return { __status: 400, body: { error: 'vendor_id, doc_number and numeric total are required' } };
    const bill = { id: `B-${s.nextBill++}`, status: 'open', ...b };
    s.bills.push(bill);
    return { bill };
  },
  // Exists so an eval can prove nothing ever calls it. Paying is a separate, human step in QuickBooks.
  'POST /quickbooks/bills/:id/pay': (req) => ({ __status: 403, body: { error: `refusing to pay ${req.params.id} from automation` } }),
  'POST /slack/chat.postMessage': (req) => ({ ok: true, channel: req.body?.channel ?? '', ts: String(Date.now() / 1000) }),
};
