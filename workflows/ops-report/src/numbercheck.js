// The narrative check. Runs after the model, in code. A narrative passes only if:
//   1. every number in it can be found in the computed report (with formatting/rounding allowed:
//      "$404.8K", "$405K", "404,800", "3.9%", "+1.6 pts", "7.0x", "two"),
//   2. it makes no "record / best ever / all-time" claims (the report never establishes a record),
//   3. it never gives a number for a source that is missing, and names every missing source.
// Numbers from customer text (customer_voice) are NOT allowed: that text is untrusted.
// Plain JS, no imports (inlined into the "Check numbers" Code nodes; tests import it directly).

const WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

export function extractNumbers(text) {
  const out = [];
  const re = /(?<![\w.$-])(-|−)?(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?([KkMm])(?![a-zA-Z]))?(\s?%|\s?pts?\b|\s?points?\b|x\b)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const intPart = m[3].replace(/,/g, ''); const dec = m[4] ?? '';
    let value = Number(`${intPart}${dec ? '.' + dec : ''}`);
    let precision = dec ? 10 ** -dec.length : 1;
    const mult = m[5] ? (m[5].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
    value *= mult; precision *= mult;
    out.push({ raw: m[0].trim(), value, precision, unit: (m[6] ?? '').trim(), money: Boolean(m[2]) });
  }
  const wre = new RegExp(`\\b(${Object.keys(WORDS).join('|')})\\b`, 'gi');
  while ((m = wre.exec(text)) !== null) out.push({ raw: m[0], value: WORDS[m[0].toLowerCase()], precision: 1, unit: '', word: true });
  return out;
}

// Every number that appears anywhere in the trusted part of the report (values, deltas, displays, anomaly
// messages, week labels and dates). Absolute values, so "down $1,450" matches net_new_mrr -1450.
export function allowedNumbers(report) {
  const { customer_voice, ...trusted } = report;
  const vals = new Set();
  const walk = (x) => {
    if (x === null || x === undefined) return;
    if (typeof x === 'number') { vals.add(Math.abs(x)); return; }
    if (typeof x === 'string') { for (const n of extractNumbers(x)) if (!n.word) vals.add(Math.abs(n.value)); return; }
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x === 'object') return Object.values(x).forEach(walk);
  };
  walk(trusted);
  return [...vals];
}

// A bare integer ("37 techs") must match exactly: rounding tolerance applies only to numbers written with a
// decimal, a unit (%, pts, x) or as money/K/M, so "37" can't sneak through on a 36.8% somewhere else.
const isBareInt = (n) => !n.money && !n.unit && n.precision === 1 && Number.isInteger(n.value);
const isSupported = (n, allowed) => allowed.some((a) => (isBareInt(n) ? a === Math.abs(n.value) : Math.abs(a - Math.abs(n.value)) <= n.precision / 2 + 1e-9));

const SUPERLATIVE = /\b(record(?:[- ]breaking)?|all[- ]time|best (?:week|ever|month)|highest ever|lowest ever|ever recorded|zero problems|no follow-up (?:is )?needed)\b/i;
export const SOURCE_KEYWORDS = {
  stripe: /\b(mrr|revenue|churn\w*|expansion|contraction|new customers?|arr)\b/i,
  hubspot: /\b(pipeline|deals?|win rate|won|lost|bookings)\b/i,
  zendesk: /\b(tickets?|sla|csat|support|first[- ]reply|satisfaction)\b/i,
  linear: /\b(bugs?|p0s?|issues?)\b/i,
  github: /\b(deploy\w*|releases?|ships?)\b/i,
};
const MISSING_WORDS = /\b(missing|unavailable|no data|didn't (?:return|load)|did not (?:return|load)|could not|couldn't|down|failed to load|not available|gap)\b/i;
const NAMES = { stripe: 'Stripe', hubspot: 'HubSpot', zendesk: 'Zendesk', linear: 'Linear', github: 'GitHub' };

export function checkNarrative(text, report) {
  const problems = [];
  if (typeof text !== 'string' || text.trim().length < 40) return { ok: false, problems: ['narrative is empty or too short'], numbers: 0 };
  const allowed = allowedNumbers(report);
  const nums = extractNumbers(text);
  for (const n of nums) if (!isSupported(n, allowed)) problems.push(`unsupported number "${n.raw}"`);
  const sup = SUPERLATIVE.exec(text);
  if (sup) problems.push(`unsupported claim "${sup[0]}" (the report does not establish records or rule out follow-up)`);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
  for (const s of report.missing ?? []) {
    const kw = SOURCE_KEYWORDS[s];
    for (const sent of sentences) {
      if (kw.test(sent) && extractNumbers(sent).some((n) => !n.word) && !MISSING_WORDS.test(sent))
        problems.push(`gives a number for ${NAMES[s]} data, which is missing: "${sent.trim().slice(0, 100)}"`);
    }
    if (!new RegExp(`\\b${NAMES[s]}\\b`, 'i').test(text)) problems.push(`does not say that ${NAMES[s]} data is missing`);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 12), numbers: nums.length };
}
