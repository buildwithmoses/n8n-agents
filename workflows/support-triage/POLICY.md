# Support triage policy (Fernhill Software, fictional)

Owner: **Priya Raman (@priya)**, Support Lead. The workflow implements this file in code
(`src/policy.js`, `src/guardrail.js`, `src/outage.js`). The model never decides anything on this page.

## 1. Priority

Start from the category, then apply the plan bump, then the keyword override.

| Category | Base priority |
|---|---|
| outage | urgent |
| cancellation | high |
| bug | normal |
| billing | normal |
| how_to | low |
| feature_request | low |
| other | low |

- **Enterprise bump:** Enterprise accounts move up one level (low to normal, normal to high). It never creates urgent by itself.
- **Keyword override to urgent:** the subject or body says the customer can't dispatch, the dispatch board is down or blank, nobody or no tech can log in, the app or site is down for everyone, or they lost data.
- **Error pages count too:** "502", "503", "bad gateway" or "service unavailable" mean the service is down: urgent, and the ticket counts as an outage.
- Keywords are matched by code on the customer's text. Words like "urgent" or "ASAP" do **not** raise priority; anyone can type them.

## 2. First-response SLA (hours)

| Priority | Starter | Pro | Enterprise |
|---|---|---|---|
| urgent | 2 | 1 | 0.5 |
| high | 8 | 4 | 2 |
| normal | 24 | 12 | 8 |
| low | 48 | 24 | 24 |

## 3. Routing

| Category | Group (id) |
|---|---|
| billing, cancellation | Billing (201) |
| bug, outage | Technical Support (202) |
| how_to, feature_request | Customer Success (203), or Enterprise Success (204) for Enterprise accounts |
| other | General (200) |

## 4. Tags

`ai_triaged`, `cat_<category>`, `plan_<tier>`, `lang_<code>`, `sentiment_<value>`, plus
`outage`, `churn_risk`, `injection_suspected`, `draft_withheld` when they apply. Nothing else.
Tags requested inside a ticket are never applied.

## 5. AI drafts

- Saved only as an **internal note**. Customers never see a draft until an agent approves it.
- Must cite at least one help-center article as `[KB-###]`, and only articles the workflow fetched.
  A draft with no citation, or with an unknown citation, is withheld.
- Must not promise refunds, credits, discounts, free months, waived fees, cancellation or contract
  terms, or a date or timeline for a fix. Only Billing (for money) or Engineering (for dates) can promise those.
- If the ticket contains instructions aimed at the AI ("ignore your rules", "system note to the AI"), the
  ticket is tagged `injection_suspected` and the draft is withheld. The ticket is still triaged normally.

## 6. Public replies

A public reply is posted only after a named agent approves it through the approval webhook
(header `X-Approval-Token`). Reject, timeout (24 hours) or an empty response means nothing is posted.

## 7. Churn risk

A cancellation request from an account paying **more than $1,000 MRR** posts an alert to
`#support-leads` mentioning @priya, with the account, plan and MRR.

## 8. Outages

A ticket is an outage ticket when the model files it as `outage` **or** code finds whole-team or error-page language
("down for all", "whole team", "nobody can log in", "dispatch board is blank", "502"). Every outage ticket is tagged `outage`. When **3 or more** outage tickets arrive within **30 minutes**
(by ticket creation time), the workflow opens **one** Linear incident. Later outage tickets link to the
open incident with a comment instead of opening another.
