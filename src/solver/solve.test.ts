import { describe, it, expect } from 'vitest';
import { solve, solveWithSpan, type Cue } from './solve';
import { parseCues, toCuesJson } from './cues';

/** Mulberry32 — deterministic randomness for exhaustive-style random checks. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TinyCase {
  n: number;
  durations: number[];
  base: number[];
  pins: Map<number, number>;
  U: number;
}

function makeCues(c: Pick<TinyCase, 'durations' | 'base'>): Cue[] {
  return c.durations.map((d, i) => ({ start: c.base[i], duration: d, text: `c${i}` }));
}

/**
 * Exact brute force over all feasible integer start vectors. Feasible
 * envelope in y-space:
 *   -P[i] <= y[i] <= U - (P[n-1] - P[i]), y non-decreasing, pins frozen.
 * Enumerates in ascending order, keeping the first minimum-cost vector, which
 * is the lexicographically smallest optimum.
 */
function bruteForce(c: TinyCase): { starts: number[]; cost: number } | null {
  const { n, durations, base, pins, U } = c;
  const P: number[] = new Array(n);
  P[0] = 0;
  for (let i = 1; i < n; i++) P[i] = P[i - 1] + durations[i - 1];
  const b = base.map((p, i) => p - P[i]);

  // Held in an object so TypeScript does not narrow across the DFS closure's
  // assignments.
  const state: { best: number[] | null; bestCost: number } = {
    best: null,
    bestCost: Infinity,
  };
  const y: number[] = new Array(n);

  // Full enumeration (no prefix-cost prune: a pricier prefix can still finish
  // cheaper; ties must be compared lexicographically, which ascending DFS
  // order handles by only accepting a strictly smaller cost).
  const dfs = (i: number, prev: number, cost: number): void => {
    if (i === n) {
      if (cost < state.bestCost) {
        state.best = y.slice();
        state.bestCost = cost;
      }
      return;
    }
    // Bounds: under isotonicity the feasible set is exactly the constant
    // box 0 <= y[i] <= C = U - P[n-1] (y[0] >= 0 forces every value >= 0;
    // y[n-1] <= C forces every value <= C).
    const C = U - P[n - 1];
    let lo = Math.max(0, prev);
    let hi = C;
    const pin = pins.get(i);
    if (pin !== undefined) {
      const v = pin - P[i];
      if (v < lo || v > hi) return;
      lo = hi = v;
    }
    if (lo > hi) return;
    for (let v = lo; v <= hi; v++) {
      y[i] = v;
      dfs(i + 1, v, cost + Math.abs(v - b[i]));
    }
  };
  dfs(0, -Infinity, 0);

  if (state.best === null) return null;
  return {
    starts: state.best.map((v, i) => v + P[i]),
    cost: state.bestCost,
  };
}

function runSolver(c: TinyCase) {
  return solveWithSpan(makeCues(c), c.base, c.pins, c.U);
}

describe('solver vs exhaustive brute force (tiny instances)', () => {
  it('matches target value and full vector on seeded random short cases', () => {
    const rand = rng(20260918);
    const cases = 500;
    for (let t = 0; t < cases; t++) {
      const n = 1 + Math.floor(rand() * 4); // 1..4
      const durations = Array.from({ length: n }, () => 1 + Math.floor(rand() * 3));
      const P: number[] = new Array(n).fill(0);
      for (let i = 1; i < n; i++) P[i] = P[i - 1] + durations[i - 1];
      const base: number[] = new Array(n);
      base[0] = Math.floor(rand() * 3);
      for (let i = 1; i < n; i++) {
        base[i] = base[i - 1] + 1 + Math.floor(rand() * 4);
      }
      const U = P[n - 1] + Math.floor(rand() * 7); // sometimes infeasible slack
      const pins = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        if (rand() < 0.45) {
          // pin around the baseline, frequently conflicting
          pins.set(i, Math.max(0, base[i] + Math.floor(rand() * 7) - 3));
        }
      }
      const c: TinyCase = { n, durations, base, pins, U };
      const expected = bruteForce(c);
      const actual = runSolver(c);
      if (expected === null) {
        expect(actual.ok, `case ${t}: expected INFEASIBLE`).toBe(false);
      } else {
        expect(actual.ok, `case ${t}: unexpected INFEASIBLE`).toBe(true);
        if (actual.ok) {
          expect(actual.cost, `case ${t}: cost`).toBe(expected.cost);
          expect(actual.starts, `case ${t}: vector`).toEqual(expected.starts);
        }
      }
    }
  });

  it('grid-exhaustively matches brute force for all short sequences and pin sets', () => {
    // Every n <= 3 sequence with durations in 1..2, bases in 0..3, tight or
    // slack day spans, every cue subset pinned to each grid value (plus one
    // out-of-range pin). Covers even-block ties and every critical pin
    // boundary; brute force is the reference for target value and full vector.
    const cart = <T>(sets: T[][]): T[][] =>
      sets.reduce<T[][]>(
        (acc, s) => acc.flatMap((prefix) => s.map((v) => [...prefix, v])),
        [[]],
      );
    const range = (m: number, start = 0): number[] =>
      Array.from({ length: m }, (_, i) => i + start);

    let checked = 0;
    let infeasible = 0;
    for (const n of [1, 2, 3]) {
      const durGrids = cart(range(n).map(() => [1, 2]));
      const baseGrids = cart(range(n).map(() => range(4)));
      for (const durations of durGrids) {
        const P: number[] = new Array(n).fill(0);
        for (let i = 1; i < n; i++) P[i] = P[i - 1] + durations[i - 1];
        for (const U of [P[n - 1], P[n - 1] + 2]) {
          for (const base of baseGrids) {
            for (let mask = 0; mask < 1 << n; mask++) {
              const basePins = range(n)
                .filter((i) => mask & (1 << i))
                .map((i) => [i, base[i]] as const);
              // Pin values: the baseline value, every envelope grid point on
              // the first pinned cue, and one value just past the span.
              const firstPinned = basePins[0]?.[0];
              const variants: number[] =
                firstPinned === undefined
                  ? [0]
                  : [base[firstPinned], ...range(U + 1), U + 1];
              for (const v of variants) {
                const pins = new Map(basePins);
                if (firstPinned !== undefined) pins.set(firstPinned, v);
                const c: TinyCase = { n, durations, base, pins, U };
                const expected = bruteForce(c);
                const actual = runSolver(c);
                if (expected === null) {
                  expect(actual.ok, `${JSON.stringify(c)}`).toBe(false);
                  infeasible++;
                } else {
                  expect(actual.ok, `${JSON.stringify(c)}`).toBe(true);
                  if (actual.ok) {
                    expect(actual.cost, `${JSON.stringify(c)}`).toBe(
                      expected.cost,
                    );
                    expect(actual.starts, `${JSON.stringify(c)}`).toEqual(
                      expected.starts,
                    );
                  }
                  checked++;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
    expect(infeasible).toBeGreaterThan(0);
  });

  it('even-block tie inside a longer chain (6 merged observations)', () => {
    // Six descending interior observations [6,5,4,3,2,1] between two pins;
    // the unique even-cardinality block accepts any value in [3,4] and the
    // lex-smallest solution is 3.
    const c: TinyCase = {
      n: 8,
      durations: new Array(8).fill(6),
      // b[i] = base[i] - P[i]; interior b = 6,5,4,3,2,1
      base: [
        0,
        6 + 6,
        12 + 5,
        18 + 4,
        24 + 3,
        30 + 2,
        36 + 1,
        42,
      ],
      pins: new Map([[0, 0], [7, 60]]),
      U: 60,
    };
    const expected = bruteForce(c);
    const actual = runSolver(c);
    expect(actual.ok).toBe(true);
    expect(expected).not.toBeNull();
    if (actual.ok && expected) {
      expect(actual.cost).toBe(expected.cost);
      expect(actual.starts).toEqual(expected.starts);
      // interior constant block at lower median y = 3 -> x = 6i + 3
      for (let i = 1; i <= 6; i++) expect(actual.starts[i]).toBe(6 * i + 3);
    }
  });

  it('handles even-block lower-median ties with lexicographic minimum (2 obs)', () => {
    // pin i=0 at y=0; interior observations b=[3,2] strictly descending,
    // every block value in [2,3] is optimal; lex-smallest is 2.
    const c: TinyCase = {
      n: 3,
      durations: [6, 6, 6],
      base: [0, 9, 14],
      pins: new Map([[0, 0]]),
      U: 30,
    };
    const expected = bruteForce(c);
    const actual = runSolver(c);
    expect(expected).not.toBeNull();
    expect(actual.ok).toBe(true);
    if (actual.ok) {
      expect(actual.cost).toBe(1);
      expect(actual.starts).toEqual([0, 8, 14]);
      expect(actual.starts).toEqual(expected!.starts);
    }
  });

  it('handles even-block lower-median ties with lexicographic minimum (4 obs)', () => {
    // Four descending observations [4,3,2,1] merge into one even block;
    // any median in [2,3] optimal; lex-smallest is 2.
    const c: TinyCase = {
      n: 5,
      durations: [6, 6, 6, 6, 6],
      base: [0, 10, 15, 20, 25],
      pins: new Map([[0, 0]]),
      U: 40,
    };
    const expected = bruteForce(c);
    const actual = runSolver(c);
    expect(actual.ok).toBe(true);
    if (actual.ok) {
      expect(actual.cost).toBe(4);
      expect(actual.starts).toEqual([0, 8, 14, 20, 26]);
      expect(actual.starts).toEqual(expected!.starts);
    }
  });
});

describe('pin critical conflicts -> INFEASIBLE', () => {
  const realDay = 86_400_000;

  it('leading pin before the prefix-duration envelope', () => {
    const cues = makeCues({ durations: [10, 10], base: [0, 10] });
    const bad = solve({ cues, base: [0, 10], pins: new Map([[1, 3]]) });
    expect(bad.ok).toBe(false);
    const good = solve({ cues, base: [0, 10], pins: new Map([[1, 10]]) });
    expect(good.ok).toBe(true);
  });

  it('interior pins closer than the durations between them', () => {
    const cues = makeCues({ durations: [5, 5, 5], base: [0, 5, 10] });
    const bad = solve({
      cues,
      base: [10, 10, 11],
      pins: new Map([[0, 10], [2, 11]]),
    });
    expect(bad.ok).toBe(false);
    // exactly on the envelope: feasible
    const edge = solve({
      cues,
      base: [10, 10, 20],
      pins: new Map([[0, 10], [2, 20]]),
    });
    expect(edge.ok).toBe(true);
    if (edge.ok) expect(edge.starts).toEqual([10, 15, 20]);
  });

  it('trailing pin past the day-minus-suffix envelope', () => {
    const cues = makeCues({ durations: [10, 10], base: [0, 10] });
    const bad = solve({
      cues,
      base: [0, 10],
      pins: new Map([[0, realDay - 5]]),
    });
    expect(bad.ok).toBe(false);
    const edge = solve({
      cues,
      base: [0, 10],
      pins: new Map([[0, realDay - 10]]),
    });
    expect(edge.ok).toBe(true);
  });

  it('pin out of day range or at an invalid index', () => {
    const cues = makeCues({ durations: [10], base: [0] });
    expect(solve({ cues, base: [0], pins: new Map([[0, -1]]) }).ok).toBe(false);
    expect(solve({ cues, base: [0], pins: new Map([[0, realDay + 1]]) }).ok).toBe(
      false,
    );
    expect(solve({ cues, base: [0], pins: new Map([[1, 0]]) }).ok).toBe(false);
    expect(solve({ cues, base: [0], pins: new Map([[-1, 0]]) }).ok).toBe(false);
  });

  it('no pins but total required span exceeds the day', () => {
    // DAY/60 s = 1440 exactly: (n-1)*60 s <= DAY allows up to 1441 cues.
    const mk = (count: number): Cue[] =>
      Array.from({ length: count }, (_, i) => ({
        start: i * 60_000,
        duration: 60_000,
        text: 'a',
      }));
    const fits = mk(1441);
    expect(solve({ cues: fits, base: fits.map((c) => c.start) }).ok).toBe(true);
    const overflow = mk(1442);
    expect(
      solve({ cues: overflow, base: overflow.map((c) => c.start) }).ok,
    ).toBe(false);
  });
});

describe('basic objective and contract', () => {
  it('returns the baseline unchanged when already feasible with zero cost', () => {
    const cues: Cue[] = [
      { start: 0, duration: 5, text: 'a' },
      { start: 6, duration: 5, text: 'b' },
      { start: 20, duration: 5, text: 'c' },
    ];
    const r = solve({ cues, base: [0, 6, 20] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.starts).toEqual([0, 6, 20]);
      expect(r.cost).toBe(0);
    }
  });

  it('removes a one-millisecond overlap with total displacement 1', () => {
    const cues: Cue[] = [
      { start: 0, duration: 10, text: 'a' },
      { start: 9, duration: 10, text: 'b' },
    ];
    const r = solve({ cues, base: [0, 9] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.starts).toEqual([0, 10]);
      expect(r.cost).toBe(1);
    }
  });

  it('hits every pin exactly and keeps the rest gap-consistent', () => {
    const cues: Cue[] = Array.from({ length: 6 }, (_, i) => ({
      start: i * 10,
      duration: 8,
      text: `t${i}`,
    }));
    const pins = new Map([
      [1, 50],
      [4, 200],
    ]);
    const r = solve({ cues, base: cues.map((c) => c.start), pins });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.starts[1]).toBe(50);
      expect(r.starts[4]).toBe(200);
      for (let i = 1; i < r.starts.length; i++) {
        expect(r.starts[i] >= r.starts[i - 1] + cues[i - 1].duration).toBe(true);
      }
    }
  });
});

describe('performance at n = 20000', () => {
  it('solves the worst descending-b case within 2 s (solver only)', () => {
    const n = 20_000;
    const duration = 4_000;
    const cues: Cue[] = new Array(n);
    const base: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      cues[i] = { start: 0, duration, text: 'x' };
      base[i] = duration * i + (6_000_000 - 300 * i); // strictly increasing
    }
    // starts must be strictly increasing on import: differences are 3700 > 0,
    // and the last start ~ 80m < 86.4m, so the fixture is legal.
    for (let i = 1; i < n; i++) expect(base[i] > base[i - 1]).toBe(true);

    const t0 = performance.now();
    const r = solve({ cues, base });
    const elapsed = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
    if (r.ok) {
      // single merged even block -> constant lower weighted median
      const median = 3_000_000;
      expect(r.starts[0]).toBe(median);
      expect(r.starts[n - 1]).toBe(duration * (n - 1) + median);
      for (let i = 1; i < n; i++) {
        expect(r.starts[i] - r.starts[i - 1]).toBe(duration);
      }
      let cost = 0;
      for (let i = 0; i < n; i++) cost += Math.abs(median - (base[i] - duration * i));
      expect(r.cost).toBe(cost);
    }
  });

  it('keeps long interior pin blocks frozen even with extreme observations', () => {
    // 19998 observations all far below the left pin value: the pin block must
    // never drift, and the whole segment takes the pinned constant.
    const n = 20_000;
    const duration = 1_000;
    const cues: Cue[] = Array.from({ length: n }, (_, i) => ({
      start: duration * i,
      duration,
      text: 'z',
    }));
    const base = cues.map((c) => c.start);
    const pins = new Map<number, number>([[0, 10_000_000]]);
    const r = solve({ cues, base, pins });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.starts[0]).toBe(10_000_000);
      // Feasibility trailing envelope leaves slack; the projection pulls the
      // interior up to the pin constant since every b[i] is far below it and
      // the monotone + start-in-day optimum is constant until the day cap.
      for (let i = 1; i < n; i++) {
        expect(r.starts[i] >= r.starts[i - 1] + duration).toBe(true);
        expect(r.starts[i] <= 86_400_000).toBe(true);
      }
      // Pinned block (including every absorbed member) stays at the pin y:
      // the first 10k+ cues all share start = 10m + 1000*i while feasible.
      expect(r.starts[1]).toBe(10_001_000);
    }
  });

  it('solves a random pinned 20000-cue case within 2 s (solver only)', () => {
    const rand = rng(7);
    const n = 20_000;
    const cues: Cue[] = new Array(n);
    const base: number[] = new Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d = 1 + Math.floor(rand() * 3_000);
      s += d + Math.floor(rand() * 300); // gaps >= d: baseline is feasible
      cues[i] = { start: s, duration: d, text: 'r' };
      base[i] = s;
    }
    // Equal forward shift on every pin preserves pin-to-pin spans, so the
    // instance stays feasible while forcing the solution to move.
    const pins = new Map<number, number>();
    let lastPin = -100;
    for (let k = 0; k < 20; k++) {
      const i = Math.min(n - 1, lastPin + 50 + Math.floor(rand() * 900));
      pins.set(i, base[i] + 1_000);
      lastPin = i;
    }
    const t0 = performance.now();
    const r = solve({ cues, base, pins });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const [i, v] of pins) expect(r.starts[i]).toBe(v);
      for (let i = 1; i < n; i++) {
        expect(r.starts[i] >= r.starts[i - 1] + cues[i - 1].duration).toBe(true);
      }
    }
  });
});

describe('parseCues strict validation', () => {
  const valid = JSON.stringify({
    cues: [
      { start: 0, duration: 100, text: 'a' },
      { start: 100, duration: 100, text: 'bb' },
    ],
  });

  it('accepts a well-formed document', () => {
    const r = parseCues(valid);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['not json', '{'],
    ['root is array', '[]'],
    ['root is null', 'null'],
    ['root missing cues', '{}'],
    ['root extra key', JSON.stringify({ cues: [], extra: 1 })],
    ['cues empty', JSON.stringify({ cues: [] })],
    ['cue extra key', JSON.stringify({ cues: [{ start: 0, duration: 1, text: 'a', x: 1 }] })],
    ['cue missing text', JSON.stringify({ cues: [{ start: 0, duration: 1 }] })],
    ['negative start', JSON.stringify({ cues: [{ start: -1, duration: 1, text: 'a' }] })],
    ['start past day', JSON.stringify({ cues: [{ start: 86400001, duration: 1, text: 'a' }] })],
    ['zero duration', JSON.stringify({ cues: [{ start: 0, duration: 0, text: 'a' }] })],
    ['duration too long', JSON.stringify({ cues: [{ start: 0, duration: 60001, text: 'a' }] })],
    ['empty text', JSON.stringify({ cues: [{ start: 0, duration: 1, text: '' }] })],
    ['non-integer start', JSON.stringify({ cues: [{ start: 1.5, duration: 1, text: 'a' }] })],
    ['equal starts', JSON.stringify({ cues: [{ start: 1, duration: 1, text: 'a' }, { start: 1, duration: 1, text: 'b' }] })],
    ['decreasing starts', JSON.stringify({ cues: [{ start: 2, duration: 1, text: 'a' }, { start: 1, duration: 1, text: 'b' }] })],
    ['cue is array', JSON.stringify({ cues: [[0, 1, 'a']] })],
  ])('rejects %s', (_name, text) => {
    expect(parseCues(text).ok).toBe(false);
  });

  it('round-trips through toCuesJson with new starts', () => {
    const parsed = parseCues(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const json = JSON.parse(toCuesJson(parsed.cues, [5, 105]));
    expect(json.cues[0]).toEqual({ start: 5, duration: 100, text: 'a' });
    expect(json.cues[1]).toEqual({ start: 105, duration: 100, text: 'bb' });
  });
});
