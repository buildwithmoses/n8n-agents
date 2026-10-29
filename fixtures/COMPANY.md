# Fernhill Software (fictional)

Everything here is made up: the company, its people, customers, vendors and numbers. Domains end in
`.example`, phone numbers are 555-01xx, and no real person or business is described.

Fernhill sells **Fernhill Dispatch**, scheduling and dispatch software for HVAC, plumbing and electrical
contractors in the US. 84 employees, fully remote, HQ address in Raleigh NC for mail only.
Sells on three plans: Starter ($149/mo, up to 5 techs), Pro ($449/mo, up to 25 techs), Enterprise (custom, 25+ techs).

## Tools (all simulated by mock/server.mjs; swap MOCK_URL for the real APIs to go live)

| Job | Tool | Mock base path |
|---|---|---|
| CRM | HubSpot | /hubspot |
| Chat | Slack | /slack |
| Help desk | Zendesk | /zendesk |
| Billing | Stripe | /stripe |
| Accounting / AP | QuickBooks Online | /quickbooks |
| HR system | BambooHR | /bamboohr |
| Email, calendar, accounts | Google Workspace | /google |
| Product issues | Linear | /linear |
| Code | GitHub | /github |
| Lead enrichment | Clearbit-style enrichment API | /enrich |

## People who approve things (Slack handles)

- **Dana Whitlock** (@dana) Head of Sales. Owns lead routing rules.
- **Marcus Ibe** (@marcus) Controller. Approves every vendor bill before it is scheduled for payment.
- **Priya Raman** (@priya) Support Lead. Owns ticket priorities and macros.
- **Owen Castellano** (@owen) COO. Reads the weekly ops report every Monday.
- **Lena Hart** (@lena) People Ops. Approves every new hire's access before accounts are created.
- **Sam Okafor** (@sam) IT admin. Approves anything that grants admin or production access.

## Standing rule

Fernhill's rule for automation: **"The model can draft, sort and summarize. Anything that moves money,
grants access, emails a customer or changes a deal owner waits for a named person to approve it."**
