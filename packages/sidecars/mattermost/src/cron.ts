/**
 * A small 5-field cron matcher (UTC), no dependency. Fields:
 *
 *   minute 0-59 | hour 0-23 | day-of-month 1-31 | month 1-12 (or jan-dec) | day-of-week 0-7 (or sun-sat; 0 and 7 are Sunday)
 *
 * Each field is a comma list of terms; a term is `*`, `a`, `a-b`, `*` or `a-b` with `/step`, or `a/step` (= a to the field's
 * maximum). Day-of-month and day-of-week follow Vixie cron: when BOTH are restricted (neither begins with `*`) a day matches if
 * EITHER does; otherwise both must (and the starred one matches everything).
 *
 * No `@daily` style aliases, no `L`/`W`/`#`, no seconds, and no time zones: everything is UTC.
 */

export interface CronSpec {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly doms: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0-6, Sunday = 0 (7 is folded into 0). */
  readonly dows: ReadonlySet<number>;
  readonly domStar: boolean;
  readonly dowStar: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Value of the first name (months start at 1, weekdays at 0). */
  nameBase?: number;
}

const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES, nameBase: 0 },
];

function parseValue(raw: string, f: FieldDef): number {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n < f.min || n > f.max) throw new Error(`${f.name}: ${n} is outside ${f.min}-${f.max}`);
    return n;
  }
  const idx = f.names ? f.names.indexOf(raw.toLowerCase()) : -1;
  if (idx >= 0) return idx + (f.nameBase ?? 0);
  throw new Error(`${f.name}: '${raw}' is not a number${f.names ? ' or a name' : ''}`);
}

function parseField(text: string, f: FieldDef): Set<number> {
  if (text === '') throw new Error(`${f.name}: empty`);
  const out = new Set<number>();
  for (const term of text.split(',')) {
    if (term === '') throw new Error(`${f.name}: empty list item in '${text}'`);
    const [rangePart, stepPart, ...extra] = term.split('/');
    if (extra.length > 0 || rangePart === undefined) throw new Error(`${f.name}: bad term '${term}'`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new Error(`${f.name}: step in '${term}' must be a whole number of at least 1`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = f.min;
      hi = f.max;
    } else if (rangePart.includes('-')) {
      const [a, b, ...more] = rangePart.split('-');
      if (more.length > 0 || a === undefined || b === undefined || a === '' || b === '') throw new Error(`${f.name}: bad range '${rangePart}'`);
      lo = parseValue(a, f);
      hi = parseValue(b, f);
      if (lo > hi) throw new Error(`${f.name}: range '${rangePart}' runs backwards`);
    } else {
      lo = parseValue(rangePart, f);
      hi = stepPart !== undefined ? f.max : lo; // `5/15` means 5-max/15
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field cron expression. Throws an Error that names the field. */
export function parseCron(expr: string): CronSpec {
  if (typeof expr !== 'string') throw new Error('cron must be a string');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === '') {
    throw new Error(`cron '${expr}' must have exactly 5 fields (minute hour day-of-month month day-of-week)`);
  }
  const sets = parts.map((p, i) => parseField(p, FIELDS[i] as FieldDef));
  const dows = new Set([...(sets[4] as Set<number>)].map((d) => (d === 7 ? 0 : d)));
  return {
    source: expr.trim(),
    minutes: sets[0] as Set<number>,
    hours: sets[1] as Set<number>,
    doms: sets[2] as Set<number>,
    months: sets[3] as Set<number>,
    dows,
    domStar: (parts[2] as string).startsWith('*'),
    dowStar: (parts[4] as string).startsWith('*'),
  };
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  const dom = spec.doms.has(d.getUTCDate());
  const dow = spec.dows.has(d.getUTCDay());
  if (!spec.domStar && !spec.dowStar) return dom || dow;
  return dom && dow;
}

/** Does the minute containing `ms` (UTC) match? */
export function cronMatches(spec: CronSpec, ms: number): boolean {
  const d = new Date(ms);
  return (
    spec.minutes.has(d.getUTCMinutes()) &&
    spec.hours.has(d.getUTCHours()) &&
    spec.months.has(d.getUTCMonth() + 1) &&
    dayMatches(spec, d)
  );
}

/**
 * The first matching minute strictly after `afterMs`, as epoch ms (minute-aligned), or
 * `undefined` when none exists within 8 years (an expression like `0 0 30 2 *`).
 */
export function nextRun(spec: CronSpec, afterMs: number): number | undefined {
  let t = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = t + 8 * 366 * DAY_MS;
  while (t <= limit) {
    const d = new Date(t);
    if (!spec.months.has(d.getUTCMonth() + 1)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    } else if (!dayMatches(spec, d)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    } else if (!spec.hours.has(d.getUTCHours())) {
      t = Math.floor(t / HOUR_MS) * HOUR_MS + HOUR_MS;
    } else if (!spec.minutes.has(d.getUTCMinutes())) {
      t += MINUTE_MS;
    } else {
      return t;
    }
  }
  return undefined;
}

/** Longest look-back when working out what was missed while the bridge was down. */
export const MAX_LOOKBACK_MS = 400 * DAY_MS;

/**
 * The occurrences in `(afterMs, nowMs]`: how many there are and the latest one. Looks back at most
 * `MAX_LOOKBACK_MS`, so a state file from years ago cannot make this loop for long.
 */
export function occurrencesBetween(spec: CronSpec, afterMs: number, nowMs: number): { count: number; latest?: number } {
  let cursor = Math.max(afterMs, nowMs - MAX_LOOKBACK_MS);
  let count = 0;
  let latest: number | undefined;
  for (;;) {
    const n = nextRun(spec, cursor);
    if (n === undefined || n > nowMs) break;
    count += 1;
    latest = n;
    cursor = n;
  }
  return { count, latest };
}

export function minuteFloor(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}
