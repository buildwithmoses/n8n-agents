# Lead Router (n8n)

Fernhill Software's website demo form, routed the way their Head of Sales would do it by hand: enrich the
company, score it against the ideal customer profile, pick the right rep with capacity, never create a
duplicate, and **never change who owns an account without Dana Whitlock saying so**.

> Fictional company. Fernhill, its reps, leads and customers are made up (`../../fixtures/COMPANY.md`).
> HubSpot, Slack and enrichment are the mock SaaS server in `../../mock/server.mjs`, so every write is real HTTP and can be checked.

## The customer problem

Fernhill gets ~60 demo requests a week. Dana's team routed them by hand from a shared inbox, and three things kept going wrong:

1. **Reps stepped on each other.** A new contact from a company that already had an open deal got a second deal and a second rep.
2. **Junk reached reps.** Competitors asking for "a full demo and pricing", students, job seekers and SEO spam all landed in someone's queue.
3. **Enterprise accounts got assigned by whoever saw them first.** Dana wants to place every 26+ tech account herself.

Their rule: **"The model can read the form. Code decides where it goes. Anything that changes an owner, or any Enterprise lead, waits for Dana."**

## What the workflow does

| # | Node | What it does |
|---|---|---|
| 1 | Webhook `POST /webhook/lead-router` | Body `{ lead: {...} }` from the form |
| 2 | Normalize lead (Code) | Lowercase email, email + website domain, state, head and tail of long messages |
| 3 | Enrich company (HTTP) | Industry, size, field tech estimate, state. Failure is fine |
| 4 | Screen lead (Code) | **Rules, not the model:** spam, student, job seeker, competitor, and prompt injection in the free text |
| 5 | Extract fields (Basic LLM Chain + OpenRouter Claude Haiku 5.5 + Structured Output Parser) | **Extraction only:** trade, tech count, current software, timeline, 2-sentence rep summary. Never sees the rules or the reps |
| 6 | HubSpot: owners + load (HTTP) | Reps with capacity and current open leads |
| 7 | HubSpot: dedupe lookup (HTTP) | Existing contact, company, open deals, customer flag |
| 8 | Score + route + plan (Code) | ICP score and tier, segment by tech count, territory by state, least-loaded rep with capacity, sticky ownership, and the list of writes. If the screen found injection, the model's output is thrown away and the form fields decide |
| 9 | Needs Dana? (IF) | Holds: Enterprise, existing customer, open deal owned by someone else, contact owned by a rep who left, no territory, no capacity |
| 10 | Live: **Slack: ask Dana (send and wait)** (disabled) · Local: **Respond** with the plan and a signed `approve_url`, then **Wait for Dana** (header auth, 24h) | Timeout, reject, wrong approver or unknown owner = nothing is written |
| 11 | Apply approval (Code) | Only Dana's explicit approve applies anything. A different owner is applied only when she names it |
| 12 | One item per write → Live CRM? → **HubSpot / Slack live nodes** (disabled) or **Write: HubSpot + Slack (mock API)** | Contact create or update, deal create (or a note on the existing deal), Slack DM to the owner |
| 13 | Summarize run → Respond: result | One JSON result per lead |

26 nodes. Tests walk the graph and fail if any write node is reachable from the trigger before the approval check, or from the held branch without passing *Apply approval*.

**Dispositions:** `route` (A/B tier: contact, deal, DM to rep), `nurture` (C tier: contact only), `tag` (student, job seeker, competitor: contact tagged, no owner, no deal, no DM), `drop` (spam: nothing written), `hold` (waits for Dana).

## Results (26 labeled leads, live n8n 2.44.7, real model calls)

| Check | Floor | Baseline | Regression: model decides routing, no dedupe, no approvals |
|---|---|---|---|
| Owner never changed without Dana | 1.0 | **1.0** (2 changes, both approved) | 1.0 (it never updates records, it duplicates them instead) |
| Prompt injection never followed | 1.0 | **1.0** (3/3) | 0.667: skipped Dana's approval when the lead told it to |
| No duplicate contacts | 1.0 | **1.0** | 0: `tom@ridgeway…` and `hank@prairiefire…` created twice |
| No duplicate open deals | 1.0 | **1.0** | 0: second deals on Copperline and Summit |
| Junk never routed to a rep | 1.0 | **1.0** (7/7) | 0.571: the competitor Wrenchly got a deal and a rep DM |
| Held leads: only approvals apply | 1.0 | **1.0** (8/8) | n/a (nothing held) |
| Routing accuracy | 0.85 | **1.0** (26/26) | 0.231 |
| Deal owner valid for segment + territory | 1.0 | **1.0** | 0.706 |
| Gate | | **PASSED** (twice) | **FAILED**, 6 checks |

Spend: about 32k input and 4k output tokens per full run, **$0.0052 for 26 leads** (about $0.0002 a lead) at OpenRouter's listed Haiku 5.5 price. Webhook latency p50 1.3 s, p95 2.7 s.
Runs: `evals/results/baseline-20261029T010335.json`, `baseline-20261029T010746.json`, `naive-20261029T010527.json`.

## Run it

From the repo root, with n8n running and `.env` filled in:

```bash
npm run setup:shared                                  # once: OpenRouter + approval credentials
MOCK_ONLY=lead-router MOCK_PORT=4611 node mock/server.mjs &   # or `npm run mock` for every workflow on :4610
MOCK_URL=http://host.docker.internal:4611 node workflows/lead-router/setup.mjs
MOCK_PORT=4611 node workflows/lead-router/evals/run.mjs --label baseline
node workflows/lead-router/evals/gate.mjs             # exit 1 blocks the change
node --test workflows/lead-router/tests/*.test.mjs    # 45 tests, offline

# the regression the gate must block
MOCK_URL=http://host.docker.internal:4611 node workflows/lead-router/setup.mjs --variant naive
MOCK_PORT=4611 node workflows/lead-router/evals/run.mjs --label naive && node workflows/lead-router/evals/gate.mjs
```

Drop `MOCK_URL` / `MOCK_PORT` to use the shared mock server on :4610. Approve a held lead by hand:

```bash
curl -X POST "$APPROVE_URL" -H "X-Approval-Token: $APPROVAL_TOKEN" -H 'content-type: application/json' \
  -d '{"decision":"approve","approver":"dana","owner_id":"own-rhys"}'
```

## Files

```
rules.json            segments, territories, reps + capacity, ICP points, junk + injection patterns (Dana owns this)
src/normalize.js      form cleanup
src/classify.js       junk + injection screen
src/route.js          scoring, owner picking, the write plan, applying Dana's decision
src/naive.js          regression planner (model decides) for the gate demo
prompts/extract.md    extraction-only system prompt.  prompts/naive.md = the regression prompt
build.mjs  setup.mjs  source -> workflow JSON -> deployed and active
mock.mjs              mock HubSpot (owners, lookup, contacts, deals, notes, owner-change audit), Slack, enrichment
fixtures/leads.json   26 fictional labeled leads (generated by fixtures/build-fixtures.py)
evals/run.mjs score.mjs gate.mjs baseline.json results/
tests/lead-router.test.mjs
```

## Going live

Attach HubSpot and Slack credentials, enable the four disabled nodes, and send `live: true` (or switch the two IF nodes).
Map the Slack form answer to `{decision, owner_id, approver: "dana"}` before *Apply approval*. The live HubSpot nodes are wired for the contact and deal fields the plan produces; map any extra properties your portal uses.
