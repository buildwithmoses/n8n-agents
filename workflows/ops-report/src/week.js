// ISO week helpers. Plain JS, no imports (inlined into the "Resolve week" Code node).
// Labels look like "2026-W42". Weeks start Monday.

export function weekStart(label) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(label));
  if (!m) throw new Error(`bad week label: ${label}`);
  const year = Number(m[1]); const wk = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000);
  return new Date(monday1.getTime() + (wk - 1) * 7 * 86400000);
}

export function weekLabel(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  const thursday = new Date(d.getTime() + (3 - dow) * 86400000);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const wk = 1 + Math.floor((thursday.getTime() - jan1) / 86400000 / 7);
  return `${year}-W${String(wk).padStart(2, '0')}`;
}

export const prevWeek = (label) => weekLabel(new Date(weekStart(label).getTime() - 7 * 86400000));

// The report that runs Monday morning covers the previous full week.
export const lastFullWeek = (now) => weekLabel(new Date(now.getTime() - 7 * 86400000));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function weekRange(label) {
  const s = weekStart(label); const e = new Date(s.getTime() + 6 * 86400000);
  const f = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `${f(s)} to ${f(e)}, ${e.getUTCFullYear()}`;
}

export function resolveWeek(requested, now) {
  const week = requested && /^\d{4}-W\d{2}$/.test(requested) ? requested : lastFullWeek(now);
  return { week, prev_week: prevWeek(week), week_range: weekRange(week), requested: Boolean(requested) };
}
