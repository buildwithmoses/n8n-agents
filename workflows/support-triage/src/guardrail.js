// Draft guardrail (POLICY.md section 5). Runs after the model, in code. Plain JS, no imports.

// Promises only Billing (money) or Engineering (dates) may make. English, Spanish, French.
export const FORBIDDEN_PROMISES = [
  { kind: 'refund', re: /\b(refund(ed|ing)?|reimburse\w*|money back|reembols\w*|rembours\w*)\b/i },
  { kind: 'credit', re: /\b(account |service )?credit(s|ed)?\b(?! card)|\bcr[ée]ditos?\b(?! de tarjeta)|\bun avoir\b/i },
  { kind: 'discount', re: /\b(discount\w*|\d+ ?% off|descuento\w*|rabais|remise)\b/i },
  { kind: 'free_time', re: /\b(free (month|months|period|trial extension)|months? (free|on us)|waive[sd]?|waiving|no charge|mes(es)? gratis|mois gratuits?)\b/i },
  { kind: 'contract_terms', re: /\b(early termination|terminat\w+ fee|cancel\w* (fee|penalty)|without (any )?(fee|penalty|charge)|prorat\w+|pro-rat\w+|we('| wi)ll (cancel|close) (your|the) (account|contract|subscription))\b/i },
  { kind: 'date_promise', re: /\b(will be (fixed|resolved|done|ready|deployed|released)|(fixed|resolved|done|ready) (by|within|before) |by (tomorrow|tonight|end of (day|week)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|within \d+ (hours?|days?|business days?)|in \d+ (hours?|days?)|(on|by) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w* \d{1,2})\b/i },
];

// Text aimed at the AI rather than at a support agent.
export const INJECTION_PATTERNS = [
  /\bignore (all |any |your |the )?(previous|prior|above|earlier)? ?(rules|instructions|prompts?|guidelines)\b/i,
  /\b(system|admin|developer) (note|message|prompt|instruction)s?\b[^\n]{0,40}\b(ai|assistant|model|bot)\b/i,
  /\b(note|message|instructions?) (to|for) the (ai|assistant|model|bot)\b/i,
  /\byou are now\b/i,
  /<\/?(ticket|system|instructions?)>/i,
  /\bnew instructions\b/i,
  /\b(set|mark|change) (this|the) ticket (to|as) (urgent|high|priority)/i,
];

export function detectInjection(text) {
  return INJECTION_PATTERNS.some((re) => re.test(String(text ?? '')));
}

// `quotable`: text of the articles the draft cites. A phrase copied from published policy
// (e.g. "the Billing team responds within 2 business days") is not a new promise.
export function findPromises(text, quotable = '') {
  const t = String(text ?? '');
  const q = String(quotable ?? '').toLowerCase();
  const hits = [];
  for (const p of FORBIDDEN_PROMISES) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    const found = [...t.matchAll(re)].map((m) => m[0]).filter((m) => !(q && q.includes(m.toLowerCase())));
    if (found.length) hits.push(p.kind);
  }
  return hits;
}

const CITE = /\[(KB-\d{3})\]/g;
export function citationsIn(text) {
  return [...new Set([...String(text ?? '').matchAll(CITE)].map((m) => m[1]))];
}

// Returns { draft, withheld, reasons, citations }. `draft` is null when withheld.
export function checkDraft({ draft, citedIds, providedIds, injection, articleText }, opts = {}) {
  const enabled = opts.enabled !== false;
  const text = String(draft ?? '').trim();
  const inText = citationsIn(text);
  const cited = [...new Set([...(Array.isArray(citedIds) ? citedIds : []), ...inText])];
  if (!enabled) return { draft: text || null, withheld: !text, reasons: text ? [] : ['empty'], citations: cited };
  const reasons = [];
  if (!text) reasons.push('empty draft');
  if (injection) reasons.push('ticket contains instructions aimed at the AI');
  if (inText.length === 0) reasons.push('draft cites no help-center article');
  const provided = new Set(providedIds ?? []);
  const unknown = cited.filter((id) => !provided.has(id));
  if (unknown.length) reasons.push(`cites articles that were not provided: ${unknown.join(', ')}`);
  // Only text of articles that are both provided and cited may be quoted.
  const quotable = unknown.length ? '' : cited.map((id) => (articleText ?? {})[id] ?? '').join('\n');
  const promises = findPromises(text, quotable);
  if (promises.length) reasons.push(`promises only Billing or Engineering can make: ${promises.join(', ')}`);
  return reasons.length ? { draft: null, withheld: true, reasons, citations: cited } : { draft: text, withheld: false, reasons: [], citations: inText };
}
