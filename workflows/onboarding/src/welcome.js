// Inlined into the "Check welcome message" Code node. The model only writes words; this checks them.
// The model sees the APPROVED-SHAPE plan (no manager notes), and its text may not promise access the plan doesn't grant.

export function modelInput(plan) {
  return {
    name: plan.name, title: plan.title, department: plan.department, start_date: plan.start_date,
    employment_type: plan.employment_type, end_date: plan.end_date, manager: plan.manager,
    email: plan.google.email, slack_channels: plan.slack.channels, tools: plan.seats.map((s) => s.app),
    github_teams: plan.github.teams.filter((t) => !t.privileged).map((t) => t.team), laptop: plan.laptop,
  };
}

export function fallbackWelcome(plan) {
  return {
    welcome_message: `Welcome to Fernhill, ${plan.name.split(' ')[0]}! Your account is ${plan.google.email}. ` +
      `On ${plan.start_date} you'll find invites to ${plan.slack.channels.join(', ')} waiting, and your ${plan.laptop} ships before day one. ` +
      `Your manager (${plan.manager}) will reach out with your first-week plan.`,
    first_week_plan: ['Day 1: laptop setup, accounts and a 1:1 with your manager', 'Day 2: product walkthrough of Fernhill Dispatch',
      'Day 3: shadow a teammate', 'Day 4: first small task', 'Day 5: week-one check-in with your manager'],
  };
}

export function checkWelcome(plan, out) {
  const problems = [];
  const msg = String(out?.welcome_message ?? '').trim();
  const steps = Array.isArray(out?.first_week_plan) ? out.first_week_plan.map(String).filter(Boolean) : [];
  if (!msg) problems.push('empty welcome message');
  if (steps.length < 3) problems.push('first-week plan has fewer than 3 items');
  const text = `${msg}\n${steps.join('\n')}`;
  const mentioned = [...new Set(text.match(/#[a-z0-9][a-z0-9-]*/g) ?? [])];
  const extra = mentioned.filter((c) => !plan.slack.channels.includes(c));
  if (extra.length) problems.push(`mentions channels not in the plan: ${extra.join(', ')}`);
  if (/\b(admin|administrator|production access|prod access|superuser|root)\b/i.test(text)) problems.push('mentions admin or production access');
  if (/\$\s?\d|salary|compensation|equity|bonus/i.test(text)) problems.push('mentions compensation');
  if (problems.length) return { ...fallbackWelcome(plan), used_fallback: true, problems };
  return { welcome_message: msg, first_week_plan: steps.slice(0, 7), used_fallback: false, problems: [] };
}
