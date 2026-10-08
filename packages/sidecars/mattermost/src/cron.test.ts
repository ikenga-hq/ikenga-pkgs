import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cronMatches, nextRun, occurrencesBetween, parseCron } from './cron.js';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const iso = (ms: number | undefined) => (ms === undefined ? 'none' : new Date(ms).toISOString());

// 2026-10-12 is a Monday.
describe('cron: parsing', () => {
  it('rejects anything that is not exactly 5 fields', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '0 0 * * * 2026']) {
      assert.throws(() => parseCron(bad), /exactly 5 fields/, bad);
    }
  });

  it('rejects out-of-range, backwards, empty and malformed terms, naming the field', () => {
    assert.throws(() => parseCron('60 * * * *'), /minute: 60 is outside 0-59/);
    assert.throws(() => parseCron('* 24 * * *'), /hour: 24 is outside/);
    assert.throws(() => parseCron('* * 0 * *'), /day-of-month: 0 is outside 1-31/);
    assert.throws(() => parseCron('* * * 13 *'), /month: 13 is outside/);
    assert.throws(() => parseCron('* * * * 8'), /day-of-week: 8 is outside/);
    assert.throws(() => parseCron('30-10 * * * *'), /runs backwards/);
    assert.throws(() => parseCron('*/0 * * * *'), /step/);
    assert.throws(() => parseCron('*/ * * * *'), /step/);
    assert.throws(() => parseCron('1,,2 * * * *'), /empty list item/);
    assert.throws(() => parseCron('1-2-3 * * * *'), /bad range/);
    assert.throws(() => parseCron('1/2/3 * * * *'), /bad term/);
    assert.throws(() => parseCron('abc * * * *'), /not a number/);
    assert.throws(() => parseCron('* * * foo *'), /not a number or a name/);
    assert.throws(() => parseCron('@daily'), /exactly 5 fields/);
  });

  it('expands ranges, steps, lists and names', () => {
    const s = parseCron('0,30 9-11 1-5 jan,mar */4 ');
    assert.deepEqual([...s.minutes], [0, 30]);
    assert.deepEqual([...s.hours], [9, 10, 11]);
    assert.deepEqual([...s.doms], [1, 2, 3, 4, 5]);
    assert.deepEqual([...s.months], [1, 3]);
    assert.deepEqual([...s.dows], [0, 4]);
    assert.deepEqual([...parseCron('*/15 * * * *').minutes], [0, 15, 30, 45]);
    assert.deepEqual([...parseCron('10-40/10 * * * *').minutes], [10, 20, 30, 40]);
    assert.deepEqual([...parseCron('5/20 * * * *').minutes], [5, 25, 45]);
    assert.deepEqual([...parseCron('0 0 * * mon-fri').dows], [1, 2, 3, 4, 5]);
    assert.deepEqual([...parseCron('0 0 * * 5-7').dows].sort(), [0, 5, 6]);
    assert.deepEqual([...parseCron('0 0 * * 7').dows], [0], '7 is Sunday');
    assert.deepEqual([...parseCron('0 0 * * SUN').dows], [0]);
  });
});

describe('cron: matching', () => {
  it('Monday 08:00 (day-of-week)', () => {
    const s = parseCron('0 8 * * 1');
    assert.equal(cronMatches(s, at(2026, 10, 12, 8, 0)), true);
    assert.equal(cronMatches(s, at(2026, 10, 12, 8, 1)), false);
    assert.equal(cronMatches(s, at(2026, 10, 12, 9, 0)), false);
    assert.equal(cronMatches(s, at(2026, 10, 13, 8, 0)), false, 'Tuesday');
    assert.equal(cronMatches(s, at(2026, 10, 19, 8, 0)), true, 'next Monday');
  });

  it('weekday ranges and Sunday as 0 or 7', () => {
    const wk = parseCron('0 9-17 * * 1-5');
    assert.equal(cronMatches(wk, at(2026, 10, 12, 9, 0)), true);
    assert.equal(cronMatches(wk, at(2026, 10, 12, 17, 0)), true);
    assert.equal(cronMatches(wk, at(2026, 10, 12, 18, 0)), false);
    assert.equal(cronMatches(wk, at(2026, 10, 17, 10, 0)), false, 'Saturday');
    assert.equal(cronMatches(wk, at(2026, 10, 18, 10, 0)), false, 'Sunday');
    for (const sun of ['0 0 * * 0', '0 0 * * 7', '0 0 * * sun']) {
      assert.equal(cronMatches(parseCron(sun), at(2026, 10, 18)), true, sun);
      assert.equal(cronMatches(parseCron(sun), at(2026, 10, 12)), false, sun);
    }
  });

  it('steps and lists', () => {
    const s = parseCron('*/15 8,20 * * *');
    assert.equal(cronMatches(s, at(2026, 10, 12, 8, 45)), true);
    assert.equal(cronMatches(s, at(2026, 10, 12, 20, 15)), true);
    assert.equal(cronMatches(s, at(2026, 10, 12, 8, 10)), false);
    assert.equal(cronMatches(s, at(2026, 10, 12, 9, 0)), false);
  });

  it('day-of-month and day-of-week are ORed when both are restricted (Vixie), ANDed otherwise', () => {
    const either = parseCron('0 0 13 * 5'); // the 13th OR any Friday
    assert.equal(cronMatches(either, at(2026, 10, 13)), true, 'the 13th (a Tuesday)');
    assert.equal(cronMatches(either, at(2026, 10, 16)), true, 'a Friday that is not the 13th');
    assert.equal(cronMatches(either, at(2026, 10, 14)), false);
    const onlyDom = parseCron('0 0 13 * *');
    assert.equal(cronMatches(onlyDom, at(2026, 10, 16)), false);
    const starStep = parseCron('0 0 */2 * 5'); // a starred dom is not "restricted": both must match
    assert.equal(cronMatches(starStep, at(2026, 10, 9)), true, 'Friday the 9th (dom */2 = 1,3,5..)');
    assert.equal(cronMatches(starStep, at(2026, 10, 16)), false, 'Friday the 16th: even, so AND fails');
    assert.equal(cronMatches(starStep, at(2026, 10, 11)), false, 'the 11th is odd but a Sunday');
  });

  it('months by number and name', () => {
    const s = parseCron('0 0 1 jan,jul *');
    assert.equal(cronMatches(s, at(2027, 1, 1)), true);
    assert.equal(cronMatches(s, at(2027, 7, 1)), true);
    assert.equal(cronMatches(s, at(2027, 2, 1)), false);
  });
});

describe('cron: next occurrence', () => {
  it('is strictly after the given time, minute-aligned', () => {
    const s = parseCron('0 8 * * 1');
    assert.equal(iso(nextRun(s, at(2026, 10, 12, 7, 59))), '2026-10-12T08:00:00.000Z');
    assert.equal(iso(nextRun(s, at(2026, 10, 12, 7, 59) + 59_000)), '2026-10-12T08:00:00.000Z');
    assert.equal(iso(nextRun(s, at(2026, 10, 12, 8, 0))), '2026-10-19T08:00:00.000Z', 'strictly after');
    assert.equal(iso(nextRun(s, at(2026, 10, 12, 8, 0) + 1)), '2026-10-19T08:00:00.000Z');
  });

  it('daily at 07:00 rolls over day, month and year', () => {
    const s = parseCron('0 7 * * *');
    assert.equal(iso(nextRun(s, at(2026, 10, 12, 7, 0))), '2026-10-13T07:00:00.000Z');
    assert.equal(iso(nextRun(s, at(2026, 10, 31, 8, 0))), '2026-11-01T07:00:00.000Z');
    assert.equal(iso(nextRun(s, at(2026, 12, 31, 23, 59))), '2027-01-01T07:00:00.000Z');
  });

  it('finds Feb 29 and reports an impossible date as never', () => {
    assert.equal(iso(nextRun(parseCron('0 0 29 2 *'), at(2026, 10, 1))), '2028-02-29T00:00:00.000Z');
    assert.equal(nextRun(parseCron('0 0 30 2 *'), at(2026, 10, 1)), undefined);
  });

  it('counts the occurrences in a window and finds the latest', () => {
    const s = parseCron('0 7 * * *');
    const r = occurrencesBetween(s, at(2026, 10, 7, 7, 0), at(2026, 10, 12, 12, 0));
    assert.equal(r.count, 5, 'the 8th..12th (the 7th is excluded: strictly after)');
    assert.equal(iso(r.latest), '2026-10-12T07:00:00.000Z');
    assert.deepEqual(occurrencesBetween(s, at(2026, 10, 12, 7, 0), at(2026, 10, 12, 12, 0)), { count: 0, latest: undefined });
    assert.equal(occurrencesBetween(s, at(2026, 10, 12, 6, 0), at(2026, 10, 12, 7, 0)).count, 1, 'now is inclusive');
  });

  it('a state file from years ago does not loop for long', () => {
    const s = parseCron('* * * * *');
    const t0 = Date.now();
    const r = occurrencesBetween(s, 0, at(2026, 10, 12));
    assert.ok(r.count > 500_000 && r.count < 600_000, `bounded look-back, got ${r.count}`);
    assert.ok(Date.now() - t0 < 5_000);
  });
});
