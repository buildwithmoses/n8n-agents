# n8n Agents: five workflows for one company

Five production-style n8n workflows for **Fernhill Software**, a fictional 84-person SaaS company that sells
dispatch software to HVAC, plumbing and electrical contractors. Every workflow follows the same rule the
company gave me:

> "The model can draft, sort and summarize. Anything that moves money, grants access, emails a customer
> or changes a deal owner waits for a named person to approve it."

So in every workflow **code makes the decisions, the model only reads and writes words, a person approves
anything with consequences, and an eval gate blocks a bad change before it ships.**

> **Everything is fictional.** Fernhill, its people, customers, vendors, invoices, tickets and numbers are
> made up ([`fixtures/COMPANY.md`](fixtures/COMPANY.md)). Domains end in `.example`. HubSpot, Slack,
> Zendesk, Stripe, QuickBooks, BambooHR, Google Workspace, Linear and GitHub are simulated by a mock server,
> so every write is a real HTTP call the evals can check. The real app nodes ship disabled in each workflow.

## The five workflows

| Workflow | What it does | Who approves | What the gate blocked |
|---|---|---|---|
| [Lead router](workflows/lead-router/) | Enriches demo requests, scores them against the ideal customer profile in code, picks a rep with capacity, never duplicates a HubSpot record | Dana (Sales) for Enterprise leads and any owner change | A version that let the model route: it gave a competitor a deal, duplicated contacts and followed an injected instruction |
| [Invoice processor](workflows/invoice-processor/) | Reads vendor bill PDFs, checks the math, PO, duplicates and bank details in code, enters approved bills in QuickBooks, never pays | Marcus (Controller), plus Owen over $10,000 | A version without the bank-detail check: all 3 fake bank changes got through |
| [Support triage](workflows/support-triage/) | Classifies Zendesk tickets, sets priority and SLA in code, drafts replies that cite help articles, opens one Linear incident per outage | A support agent, before any public reply | A "keep them happy" version that promised credits, let the model set priority and followed an injection |
| [Weekly ops report](workflows/ops-report/) | Pulls Stripe, HubSpot, Zendesk, Linear and GitHub every Monday, computes every metric in code, checks every number in the summary | Owen (COO), before the company-wide post | A version that counted a down source as zero and let the model's numbers through |
| [Employee onboarding](workflows/onboarding/) | Builds least-privilege access from a role matrix, creates accounts without duplicates, reactivates rehires | Lena (People Ops), plus Sam (IT) for admin or production access | A single-approval version that granted production access after IT said no, and a version where the model built the access plan |

## Results

All five workflows were redeployed from plain commands and run together against the live n8n on 2026-10-29.
Every hard floor held, and every regression version was blocked. Model spend per full eval run is in cents.

| Workflow | Cases | Hard floors (all must be 1.0) | Quality | Model cost per run | Regression the gate blocked |
|---|---|---|---|---|---|
| Lead router | 26 leads | owner never changed without approval, injection never followed, no duplicate contacts or deals, junk never routed: all 1.0 | routing accuracy 1.0 | $0.005 | Model routes, no dedupe: junk routed 0.571, duplicates 0, routing 0.231 |
| Invoice processor | 21 PDFs | fake bank changes held, duplicates caught, no bill without approval, never paid, injection ignored: all 1.0 | status 1.0, extraction 1.0 | $0.011 | No bank check: fake bank changes held 0.0 |
| Support triage | 26 tickets | no forbidden promise, no public reply without approval, priority from policy, one incident per outage, injection ignored: all 1.0 | category 1.0, groundedness 0.955 | about $0.035 | "Keep them happy" prompt: promises 0.885, priority 0.538, injection 0.0 |
| Weekly ops report | 6 weeks | every metric and summary number correct, missing source reported as missing, no #all-hands post without Owen, injection ignored: all 1.0 | judge 0.958, anomaly recall 1.0 | $0.005 + $0.018 judge | Zeros for a down source, no number check: missing reported 0.0, numbers 0.66 |
| Onboarding | 22 hires + 7 re-sent webhooks | no access beyond the matrix, admin only with both approvals, no duplicate accounts, notes never change the plan, unknown titles held: all 1.0 | plan exact match 1.0 | $0.012 | Single approval: admin granted after IT said no. Model builds plan: exact match 0.318 |

174 offline tests pass with no keys, including one graph test per workflow that proves the approval path.

## The pattern, in every workflow

1. **Code decides.** Scores, priorities, metrics, access plans, fraud and duplicate checks are plain
   JavaScript in `src/`, inlined into n8n Code nodes at build time. The same files are unit tested.
2. **The model reads and writes.** Claude Haiku 5.5 on OpenRouter extracts fields, classifies, drafts and
   summarizes into a strict schema. Its output is checked by code before anything uses it, and bad output
   fails safe to "a person should look".
3. **A person approves.** Consequential writes sit behind an n8n Wait node (resume webhook with header auth)
   locally, and a Slack "send and wait" node in production. A timeout or an empty answer means nothing happens.
4. **Evals gate every change.** Each workflow has labeled fixtures, a harness that drives the live workflow
   through its webhook and approvals, and a gate with hard floors. Every workflow has at least one
   regression version, and the gate blocks it.
5. **A graph test proves the approval path.** A unit test walks each workflow's connections and fails if
   any trigger can reach a write node without passing the approval branch.

## Run it

Needs Docker and Node 20+.

```bash
docker volume create n8n_agents_data && docker compose up -d   # n8n 2.44.7 on http://localhost:5678
cp .env.example .env      # N8N_API_KEY (n8n Settings -> n8n API), OPENROUTER_API_KEY, APPROVAL_TOKEN
npm run setup:shared      # OpenRouter + approval-header credentials in n8n
npm run mock &            # one mock SaaS per workflow, ports in mock/ports.json
npm run setup:all         # build, import and activate all five workflows
npm test                  # offline unit and graph tests, no keys needed
npm run evals:all && npm run gate:all
```

Each workflow folder has its own README with the customer problem, a node-by-node table, its commands and
its full results.

## Repo layout

```
fixtures/COMPANY.md        the fictional company, its tools and its approvers
lib/n8n.mjs                shared n8n API, build and deploy helpers
mock/server.mjs            mock SaaS server; each workflow owns workflows/<slug>/mock.mjs
workflows/<slug>/          src/ (code nodes), build.mjs, setup.mjs, fixtures/, evals/, tests/, workflow/*.json
```

Sibling builds: [inbox-triage-n8n](https://github.com/buildwithmoses/inbox-triage-n8n) (the same agent in
code and in n8n), [langchain-agents](https://github.com/buildwithmoses/langchain-agents),
[openrouter-agents](https://github.com/buildwithmoses/openrouter-agents).
