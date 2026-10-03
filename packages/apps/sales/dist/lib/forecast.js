// Forecast maths for the Forecast view. Pure functions over the open-deal rows:
// no imports and no host access, so they can be exercised on their own.
//
// Nothing here invents a number. A deal with no win probability is not given a
// default one, and a deal with no expected close date is left out of the
// month-by-month chart instead of being placed in a made-up month.

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A finite number, or null for null / '' / non-numeric text. */
export function toNumber(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** The deal's value as a number; an unvalued deal counts as 0 in totals. */
export function dealValue(deal) {
  return toNumber(deal.value) ?? 0;
}

/** Win probability on a 0..1 scale, or null when the deal has none. */
export function winProbability(deal) {
  const p = toNumber(deal.win_probability);
  return p == null ? null : Math.min(1, Math.max(0, p));
}

/**
 * Weighted pipeline over the deals that carry a win probability.
 * `withProbability` says how many of them did, so the view can say so when
 * some deals were left out.
 */
export function weightedTotals(deals) {
  let weighted = 0;
  let withProbability = 0;
  for (const d of deals) {
    const p = winProbability(d);
    if (p == null) continue;
    weighted += dealValue(d) * p;
    withProbability += 1;
  }
  return { weighted, withProbability };
}

/** Year and month of an expected close date ('YYYY-MM-DD' or a datetime), else null. */
export function closeMonth(dateText) {
  if (typeof dateText !== 'string') return null;
  const m = /^(\d{4})-(\d{2})/.exec(dateText.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * Open deals grouped by expected close month, oldest month first. Each deal
 * counts at value x win probability when it has a probability, and at its full
 * value when it has none. Deals without a usable expected close date are
 * skipped. Returns an empty array when no deal has a date.
 *
 * @returns {{ key: string, year: number, month: number, value: number, count: number }[]}
 */
export function monthlyForecast(deals) {
  const buckets = new Map();
  for (const d of deals) {
    const when = closeMonth(d.expected_close_date);
    if (!when) continue;
    const key = `${when.year}-${String(when.month).padStart(2, '0')}`;
    const p = winProbability(d);
    const counted = dealValue(d) * (p ?? 1);
    const bucket = buckets.get(key) ?? { key, year: when.year, month: when.month, value: 0, count: 0 };
    bucket.value += counted;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** "Jun", or "Jun 27" when the forecast spans more than one calendar year. */
export function monthLabel(bucket, spansYears) {
  const name = MONTH_NAMES[bucket.month - 1];
  return spansYears ? `${name} ${String(bucket.year).slice(-2)}` : name;
}
