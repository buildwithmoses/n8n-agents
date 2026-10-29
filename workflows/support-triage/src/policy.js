// Fernhill support policy in code (POLICY.md sections 1-4). Plain JS, no imports, no Node APIs:
// build.mjs inlines this file into n8n Code nodes and the tests import it directly.

export const CATEGORIES = ['billing', 'bug', 'how_to', 'outage', 'cancellation', 'feature_request', 'other'];
export const LEVELS = ['low', 'normal', 'high', 'urgent'];
export const BASE_PRIORITY = { outage: 'urgent', cancellation: 'high', bug: 'normal', billing: 'normal', how_to: 'low', feature_request: 'low', other: 'low' };
export const SLA_HOURS = {
  urgent: { starter: 2, pro: 1, enterprise: 0.5 },
  high: { starter: 8, pro: 4, enterprise: 2 },
  normal: { starter: 24, pro: 12, enterprise: 8 },
  low: { starter: 48, pro: 24, enterprise: 24 },
};
export const GROUPS = { general: 200, billing: 201, technical: 202, success: 203, enterprise_success: 204 };
export const CHURN_MRR_CENTS = 100000; // alert above $1,000 MRR

// Customer's own words that mean "we are down". Matched on the customer's text only.
export const URGENT_PATTERNS = [
  /\b(can'?t|cannot|can ?not|unable to) dispatch\b/i,
  /\bdispatch board\b[^.\n]{0,40}\b(down|blank|won'?t load|not loading|empty)\b/i,
  /\b(nobody|no one|no tech\w*|none of (us|our \w+)) (can|is able to) (log ?in|sign ?in|access)\b/i,
  /\b(locked out|can'?t log ?in)\b[^.\n]{0,30}\b(whole|entire|all)\b|\b(whole|entire) (team|company|office)\b[^.\n]{0,30}\b(locked out|can'?t log ?in|down)\b/i,
  /\b(app|site|system|fernhill|platform)\b[^.\n]{0,25}\bdown for (all|every|our whole|the whole)\b/i,
  /\b(is|are|'s) down for (all|every)/i,
  /\b(lost|lose|losing|deleted) (all|our|every)\b[^.\n]{0,30}\b(data|jobs|notes|customers|records|invoices)\b|\bdata loss\b/i,
  /\b(502|503)\b|\bbad gateway\b|\bservice unavailable\b/i,
];
// Subset that also makes a ticket count toward an outage (whole-service language, not single-user bugs).
export const OUTAGE_PATTERNS = [URGENT_PATTERNS[1], URGENT_PATTERNS[2], URGENT_PATTERNS[3], URGENT_PATTERNS[4], URGENT_PATTERNS[5], URGENT_PATTERNS[7]];

export function normalizeTier(plan) {
  const p = String(plan ?? '').toLowerCase();
  return p === 'enterprise' || p === 'pro' || p === 'starter' ? p : 'starter';
}

export function customerText(ticket) {
  return `${ticket?.subject ?? ''}\n${ticket?.description ?? ''}`;
}

export function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

export function decidePriority({ category, tier, text }) {
  const cat = CATEGORIES.includes(category) ? category : 'other';
  let level = BASE_PRIORITY[cat];
  if (tier === 'enterprise' && (level === 'low' || level === 'normal')) level = LEVELS[LEVELS.indexOf(level) + 1];
  const keyword = matchesAny(text, URGENT_PATTERNS);
  if (keyword) level = 'urgent';
  return { priority: level, reason: keyword ? 'customer text matched an urgent pattern' : `base ${BASE_PRIORITY[cat]} for ${cat}${tier === 'enterprise' && BASE_PRIORITY[cat] !== level ? ', Enterprise bump' : ''}` };
}

export function slaHours(priority, tier) {
  return SLA_HOURS[priority]?.[tier] ?? SLA_HOURS.low.starter;
}

export function routeGroup(category, tier) {
  if (category === 'billing' || category === 'cancellation') return GROUPS.billing;
  if (category === 'bug' || category === 'outage') return GROUPS.technical;
  if (category === 'how_to' || category === 'feature_request') return tier === 'enterprise' ? GROUPS.enterprise_success : GROUPS.success;
  return GROUPS.general;
}

export function isOutage(category, text) {
  return category === 'outage' || matchesAny(text, OUTAGE_PATTERNS);
}

export function isChurnRisk(category, mrrCents) {
  return category === 'cancellation' && Number(mrrCents ?? 0) > CHURN_MRR_CENTS;
}

const LANG_OK = /^[a-z]{2}$/;
const SENTIMENTS = ['positive', 'neutral', 'negative', 'angry'];

export function buildTags({ category, tier, language, sentiment, outage, churn, injection, draftWithheld }) {
  const tags = ['ai_triaged', `cat_${category}`, `plan_${tier}`];
  tags.push(`lang_${LANG_OK.test(String(language ?? '')) ? language : 'unknown'}`);
  tags.push(`sentiment_${SENTIMENTS.includes(sentiment) ? sentiment : 'neutral'}`);
  if (outage) tags.push('outage');
  if (churn) tags.push('churn_risk');
  if (injection) tags.push('injection_suspected');
  if (draftWithheld) tags.push('draft_withheld');
  return tags;
}
