# Employee onboarding: one BambooHR event, least-privilege access, two approvals

Part of [n8n-agents](../../README.md). Fernhill Software is fictional (see [`fixtures/COMPANY.md`](../../fixtures/COMPANY.md)).
So are all 22 hires in [`fixtures/hires.json`](fixtures/hires.json): `.example` domains only.

## The customer problem

Fernhill hires 3–5 people a month, all remote. Today Lena (People Ops) copies each new hire from BambooHR into
a checklist. Then Sam (IT) clicks through Google Admin, Slack, GitHub, HubSpot, Zendesk and Linear by hand.
Three things keep going wrong:

1. **Access creep.** Hiring managers write "give her admin on prod" in the onboarding notes, and it gets done.
2. **Duplicates.** A re-sent BambooHR webhook or a retried run creates a second HubSpot seat or laptop ticket.
3. **Contractors get employee groups.** A finance contractor ended up in `finance@` and `benefits@`.

Their rule: **"Access comes from the role matrix. The model writes words, not permissions.
@lena approves every plan, and @sam also approves anything admin or production."**

## What the workflow does (35 nodes)

| Step | Node(s) | What decides |
|---|---|---|
| 1. Event | **Webhook** `POST /webhook/onboarding/new-hire` (the BambooHR webhook) → `Read event` | |
| 2. Record | **HTTP** BambooHR: get employee → `Normalize hire` | Email is derived in code (accents stripped). Rehires keep their old address. |
| 3. Existing account | **HTTP** Google: look up account | |
| 4. Plan | **Code** `Build access plan (code)` reads [`matrix/access-matrix.json`](matrix/access-matrix.json) | **Code.** Holds instead of guessing: unknown title, past start date, title/department conflict, no manager, contractor end date missing or over 12 months, email collision, suspended account that isn't this person's. Duplicate event for an onboarded person: no-op. |
| 5. Held | `Explain hold` → Slack @lena → Respond | Nothing is created. |
| 6. Words | **Basic LLM Chain** + OpenRouter (Claude Haiku 5.5) + Structured Output Parser | **Model**, from a plan summary with **no manager notes**. |
| 7. Word check | **Code** `Check welcome message` | Rejects text naming channels outside the plan, admin or prod access, or pay. Falls back to a template on any failure. |
| 8. Approve | Respond (plan + approve URL) → Slack @lena → **Wait** (resume webhook, header auth, 72h) | Manager notes are shown to Lena, marked "NOT applied". |
| 9. Second approval | `Admin or prod access?` → Slack @sam → **Wait** | Only if the plan has privileged items. A @sam reject strips them, and everything else is still created. |
| 10. Decide | **Code** `Apply approvals` | Fails safe: a timeout, the wrong approver or anything but "approve" means not approved. |
| 11. Provision | `Build provisioning calls` → `Live mode?` → **HTTP** check each → `Keep only what is missing` → **HTTP** create/reactivate/invite | Check-then-create on every system, so re-runs never duplicate. A failed check creates nothing. |
| 12. Close | `Summarize` → Slack manager + #it-onboarding | Manager tasks go to BambooHR. The welcome email is scheduled for 08:00 on the start date. |

Production path: **Google Admin: create user**, **Slack: invite to channels** and **GitHub: add to team** ship as
disabled nodes on the `Live mode?` branch. Attach credentials, enable them, and point the HTTP nodes at the real APIs.
Locally, every system is the mock SaaS server.

## Access matrix (summary)

Everyone gets `all@`, #general and #announcements. Employees also get `benefits@` and #people-news.
Contractors get `contractors@`, an account expiry date, and never `finance@`, `hr-confidential@` or `benefits@`.

| Role | Extra groups | GitHub | Seats | Privileged (needs @sam) |
|---|---|---|---|---|
| Account Executive / SDR | sales@ | | HubSpot | |
| Customer Support Specialist | support@ | | Zendesk agent, Linear guest | |
| Support Team Lead | support@, support-leads@ | | Zendesk **admin**, Linear | Zendesk admin |
| Software Engineer | engineering@ | engineers | Linear | |
| Site Reliability Engineer | engineering@, oncall@ | engineers, **prod-deploy** | Linear | prod-deploy |
| IT Administrator | it@ | it | Linear | Google **user-management admin** |
| Product Designer, Staff Accountant, People Ops Coordinator, Marketing Manager | role group | | role seat | |

## Results (real runs, 22 hires, 7 re-sent webhooks)

| Metric | Floor | Baseline | Regression: single approval | Regression: model builds the plan |
|---|---|---|---|---|
| No access beyond the matrix | 1.0 | **1.0** | 0.909 | 0.955 |
| Admin/prod never without both approvals | 1.0 | **1.0** | 0.909 | 1.0 |
| No duplicate accounts, seats or tickets | 1.0 | **1.0** | 1.0 | 1.0 |
| Re-sent webhooks are no-ops | 1.0 | **1.0** | 1.0 | 1.0 |
| Manager notes never change the plan | 1.0 | **1.0** | 1.0 | 0.5 |
| Unknown titles held | 1.0 | **1.0** | 1.0 | 1.0 |
| Held hires create nothing | 1.0 | **1.0** | 1.0 | 1.0 |
| Access plan exact match | 1.0 | **1.0** | 1.0 | 0.318 |
| Provisioned exactly what was approved | 1.0 | **1.0** | 0.909 | 0.682 |
| Gate | | **PASSED** | **BLOCKED** | **BLOCKED** |
| Model spend (whole suite) | | $0.013 | | $0.032 |

What the regressions did:
- **Single approval.** Prod-deploy went to an SRE, and Zendesk admin to a support lead, after @sam had said no.
- **Model builds the plan.** It put a finance contractor in `finance@`. It dropped `benefits@` from most employees.
  It also held the wrong hires for the wrong reasons.

Welcome-message fallback ran on 1 of 14 drafts in the clean run, from an OpenRouter timeout. In one run while
other workflows shared the key, 9 of 14 timed out. The template took over each time, and no gate metric moved.
Dated results are in [`evals/results/`](evals/results/).

## Run it

```bash
# repo root, with n8n running and .env filled in (see ../../README.md)
node scripts/setup-shared.mjs                                         # shared credentials, once
MOCK_ONLY=onboarding MOCK_PORT=4615 node mock/server.mjs &            # or the shared mock on :4610
MOCK_URL=http://host.docker.internal:4615 node workflows/onboarding/setup.mjs
node --test workflows/onboarding/tests/*.test.mjs                     # 38 tests, offline
MOCK_PORT=4615 node workflows/onboarding/evals/run.mjs --label baseline
node workflows/onboarding/evals/gate.mjs workflows/onboarding/evals/results/latest-baseline.json

# regressions (same workflow id), then put the baseline back
MOCK_URL=http://host.docker.internal:4615 node workflows/onboarding/setup.mjs --variant single-approval
MOCK_URL=http://host.docker.internal:4615 node workflows/onboarding/setup.mjs --variant model-plan
```

Approve by hand: POST `{"approver":"lena","decision":"approve"}` to the `approve_url` from the webhook reply, with the
`X-Approval-Token` header. Send a second POST from `"sam"` if `needs_admin_approval` is true.
