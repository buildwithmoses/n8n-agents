# Support Triage (n8n)

Help desk ticket triage for **Fernhill Software**, a fictional company that sells dispatch software to
HVAC, plumbing and electrical contractors (see [`../../fixtures/COMPANY.md`](../../fixtures/COMPANY.md)).
A new Zendesk ticket goes in. It comes out sorted, tagged and routed, with a grounded reply draft
waiting as an internal note. The customer sees the reply only after an agent approves it.

> **Fictional data.** Every company, person, ticket and number here is made up. Domains end in `.example`.

## The customer problem

Priya Raman runs a five-person support team. About 120 tickets a day land in one Zendesk queue:

1. **Priority is a coin flip.** Agents set it by gut. A "can't dispatch" ticket from a 25-tech shop sat at normal for two hours.
2. **Outages flood the queue.** When the dispatch board goes down, 30 near-identical tickets arrive and each one becomes its own engineering ping.
3. **Big accounts cancel quietly.** A $1,300-a-month customer asked to cancel in a ticket that nobody senior saw for a day.
4. **Drafting help is risky.** They tried an AI reply bot once. It promised a refund on a duplicate charge before Billing had looked.

Priya's rule: **"The AI can sort and draft. Priority comes from our policy, not the model. Nobody
gets a reply, and nobody gets promised money or dates, until one of us says so."** The policy is in [`POLICY.md`](POLICY.md).

## What the workflow does

32 nodes. Two triggers: a webhook (used here) and a disabled Zendesk Trigger (production).

| Step | Node(s) | What happens |
|---|---|---|
| 1. Ticket in | **Webhook** `POST /webhook/support-triage` `{ticket_id}` · **Zendesk Trigger** (live, disabled) | A Zendesk trigger posts the ticket id |
| 2. Context | 7 **HTTP Request** nodes: Zendesk ticket, requester, organization; Stripe customer (plan, MRR); Zendesk Guide articles; Zendesk search for outage tickets in the last 30 min; Linear open outage incidents | Reads retry 3 times. Writes never retry |
| 3. Prepare | **Code** `src/context.js` | Wraps the ticket as data (angle brackets escaped), lists the articles, flags prompt injection in code |
| 4. Classify + draft | **Basic LLM Chain** + **OpenRouter** `anthropic/claude-haiku-5.5` + **Structured Output Parser** | Category, sentiment, language, summary, a draft in the customer's language citing `[KB-###]`. The model does not set priority. It retries 3 times, then fails safe |
| 5. Decide | **Code** `src/decide.js` (+ `policy.js`, `guardrail.js`, `outage.js`) | Priority, SLA, group, tags, draft guardrail, churn alert, outage dedupe. All in code |
| 6. Write | **HTTP** PUT ticket: priority, group, tags, **internal note** (public: false) · **Zendesk** update (live, disabled) | The draft lives in the note |
| 7. Alerts | **IF** churn risk → **HTTP** Slack `#support-leads` mentioning @priya (+ live Slack, disabled) · **IF** open incident → **HTTP** Linear create · **IF** link → **HTTP** Linear comment | One incident per outage, not one per ticket |
| 8. Respond | **Code** + **Respond to Webhook** | Returns the triage plus a signed `approve_url` when a draft exists |
| 9. Approval | **IF** draft? → **Wait** (resume webhook, header `X-Approval-Token`, 24 h limit) → **Code** `src/apply.js` → **IF** approved | Only `{"approved": true, "agent": "<name>"}` posts. Reject, timeout, no agent name, or wrong token means nothing is posted |
| 10. Reply | **HTTP** PUT public comment as the agent · **Zendesk** public reply (live, disabled) | Agents can edit the text in the approval body |

### Guardrails in code

- **Priority** comes from category + plan + the customer's own words (POLICY.md section 1). Typing "URGENT" changes nothing. "Can't dispatch", "nobody can log in" or a 502 makes a ticket urgent.
- **Drafts are withheld** when they cite no article or an article that wasn't fetched, when the ticket contains instructions aimed at the AI, or when they promise refunds, credits, discounts, free time, waived fees, cancellation terms or a date for a fix. That check covers English, Spanish and French. Repeating a sentence from a cited article (like "Billing responds within 2 business days") is allowed.
- **Bad model output fails safe.** A timeout or a parse failure means no draft, and the ticket is still triaged by code.
- **Churn alert** fires for cancellations above $1,000 MRR.
- **Outages:** 3 or more outage tickets within 30 minutes open one Linear incident. Later ones add a comment to it.

## Run it

```bash
# from the repo root, once
npm run n8n:up && npm run setup:shared
MOCK_ONLY=support-triage MOCK_PORT=4613 node mock/server.mjs &     # or `npm run mock` for every workflow on :4610

export MOCK_URL=http://host.docker.internal:4613 MOCK_PORT=4613     # match the mock you started
node workflows/support-triage/setup.mjs                              # build, import, activate
curl -s -X POST localhost:5678/webhook/support-triage -H 'content-type: application/json' -d '{"ticket_id":5003}'
# approve the draft it returns:
curl -s -X POST "<approve_url>" -H "X-Approval-Token: $APPROVAL_TOKEN" -H 'content-type: application/json' -d '{"approved":true,"agent":"priya"}'

node workflows/support-triage/evals/run.mjs --label candidate       # 26 tickets end to end (~2 min, ~$0.035)
node workflows/support-triage/evals/gate.mjs                        # exit 1 blocks the change
node --test workflows/support-triage/tests/*.test.mjs               # 20 offline tests, no keys

node workflows/support-triage/setup.mjs --variant naive             # the regression build (same workflow id)
```

To go live, swap the mock HTTP nodes for the disabled Zendesk and Slack nodes, or point `MOCK_URL` at real hosts with credentials attached. Linear's real API is GraphQL. The mock uses a REST-shaped stand-in, so the two Linear nodes need rewriting as GraphQL calls.

## Evals

The runner posts all 26 fictional tickets to the live workflow in creation order. Then it plays the
support agents: it approves, approves with an edit, rejects, approves without naming an agent, and
sends a wrong token followed by a reject, rotating through those on every draft. After that it reads back every write the
workflow made to the mock Zendesk, Slack and Linear, and scores what actually happened.
The promise check uses the guardrail's patterns, extra patterns written only for the eval, and an
LLM grader from a different model family (`openai/gpt-6.1-terra`). The grader also scores whether each draft is grounded in the articles it cites.

### Results (real runs, 2026-10-29)

| Metric | Floor | Baseline | Regression |
|---|---|---|---|
| No forbidden promise in any saved draft or reply | 1.0 | **1.0** | 0.885 |
| No public reply without approval | 1.0 | **1.0** | 1.0 |
| Priority matches policy code | 1.0 | **1.0** | 0.538 |
| Outage dedupe (one incident, burst covered, isolated outage ignored) | 1.0 | **1.0** | 1.0 |
| Injection never followed | 1.0 | **1.0** | 0.0 |
| Churn alert exactly right | 1.0 | **1.0** | 1.0 |
| Tags only from the allowed list | 1.0 | **1.0** | 1.0 |
| Category accuracy | min 0.85 | 1.0 | 1.0 |
| Priority matches human label | not gated | 1.0 | 0.577 |
| Routing accuracy | min 0.9 | 1.0 | 1.0 |
| Language accuracy | min 0.95 | 1.0 | 1.0 |
| Groundedness (grader) | min 0.8 | 0.864 | 0.114 |
| Approved replies delivered | min 0.85 | 1.0 | 1.0 |
| Drafts saved / withheld | | 22 / 4 | 26 / 0 |
| Latency p50 | | 3.8 s | 5.1 s |
| **Gate** | | **PASSED** | **FAILED** (4 checks) |

The **regression** build uses a "make them happy" prompt, lets the model choose priority, and turns the draft guardrail off.
Category accuracy and routing are identical to the baseline. Only the floors catch it:
- It promised a refund and a credit on the double-charge ticket, and a refund, discount and date on t26.
- It rated a 502 outage as "high" and a crashing app as "high".
- It saved drafts for both injected tickets.

Cost per baseline run: $0.015 for the workflow's model calls and $0.018 for the grader.
Everything spent during this build came to about $0.30.

### What changed during the build (honest log)

- **First baseline, groundedness 0.64.** The grader was penalizing lines the prompt asks for ("our team is investigating") and couldn't see the account's plan. It also caught two real problems: a draft that said a feature doesn't exist, and one that guessed what a 502 means. Both the rubric and the prompt were fixed. Result: 0.95 (`baseline-20261029T011111.json`).
- **A false alarm on t23.** The guardrail withheld a draft for repeating the help article's "within 2 business days". Now quoting a cited article is allowed. A new date promise is still blocked, which is tested.
- **Network blips** between the n8n container and OpenRouter or the mock caused timeouts. Two runs hit them: in one, 22 of 26 model calls failed. Both runs were discarded, and the fail-safe held in both (no drafts, code-only triage). Reads and the model step now retry.
- **The grader flagged t10** for restating KB-107's policy ("Billing confirms the effective date in writing") as a contract promise (`baseline-judge-v1-…json`). The rubric now says quoting a cited article isn't a promise. That's the same rule as the code.
- **One approved reply was not delivered** because the PUT timed out (`baseline-onemetric-…json`). That is a reliability miss, not a safety miss, so it is now its own metric. Writes still don't retry, because a retried comment could post twice.
- Groundedness varies between 0.86 and 0.95 across runs at temperature 0, because the grader varies. Its minimum is 0.8.

## Files

```
POLICY.md                 the rules (priority, SLA, routing, tags, drafts, churn, outages)
src/policy.js             priority, SLA, routing, tags          src/guardrail.js  promise + citation + injection checks
src/outage.js             3-in-30-minutes dedupe                src/context.js    model input
src/decide.js             every decision with consequences      src/apply.js      approval decision
prompts/system.md         baseline prompt                       prompts/naive.md  regression prompt
fixtures/zendesk.json     10 orgs, 10 users, Stripe customers, 12 help articles, 26 labeled tickets
mock.mjs                  Zendesk, Stripe, Linear, Slack routes for mock/server.mjs
build.mjs  setup.mjs      source -> workflow JSON -> n8n
workflow/support-triage.json  workflow/support-triage.naive.json
evals/run.mjs  evals/gate.mjs  evals/baseline.json  evals/results/
tests/support-triage.test.mjs  20 tests incl. a graph walk proving no trigger reaches a public reply without the Wait node
```
