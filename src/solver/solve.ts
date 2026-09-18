// Solver: lock a few cues at fixed starts and remove all overlaps.
//
// Variables x[i] >= 0 are integer cue starts; feasibility constraints are
//   x[0] >= 0
//   x[i+1] >= x[i] + duration[i]
//   x[n-1] <= DAY_MS
// Pins force x[i] = start exactly. Objective: minimise sum |x[i] - base[i]|,
// ties broken by the lexicographically smallest vector (cue order).
//
// Change of variable y[i] = x[i] - P[i], where P[i] = sum_{k<i} duration[k].
// Then the gap constraints become y non-decreasing and the objective is
// sum |y[i] - b[i]| with b[i] = base[i] - P[i] — L1 isotonic regression with
// pinned observations. The lexicographically smallest minimiser is produced by
// PAVA blocks taking their *lower weighted median*; pins are observations with
// weight > total finite weight, so every block containing a pin evaluates to
// the pin value. Pins split the problem into independent segments, each solved
// by a PAVA stack; weighted medians inside blocks are maintained with meldable
// leftist heaps (lo = lower half, max heap; hi = upper half, min heap), giving
// O(n log n) overall, well inside 2 s for n = 20 000.

export const DAY_MS = 86_400_000;

export interface Cue {
  start: number;
  duration: number;
  text: string;
}

/** cueIndex -> fixed integer start; one pin per cue, re-edit overwrites. */
export type Pins = ReadonlyMap<number, number>;

export interface SolveInput {
  cues: ReadonlyArray<Cue>;
  base: ReadonlyArray<number>;
  pins?: Pins;
}

export type SolveResult =
  | { ok: true; starts: number[]; cost: number }
  | { ok: false; reason: 'INFEASIBLE' };

/** Same contract as solve() with a configurable day span (tests use small U). */
export function solveWithSpan(
  cues: ReadonlyArray<Cue>,
  base: ReadonlyArray<number>,
  pins: Pins,
  daySpan: number,
): SolveResult {
  return solveCore(cues, base, pins, daySpan);
}

// ---------------------------------------------------------------------------
// Leftist heap of weighted observations. Nodes are mutated in place; heaps
// are melded destructively (every observation belongs to exactly one block).
// ---------------------------------------------------------------------------

interface HNode {
  value: number;
  weight: number; // observation weight
  rank: number;
  left: HNode | null;
  right: HNode | null;
}

function makeNode(value: number, weight: number): HNode {
  return { value, weight, rank: 1, left: null, right: null };
}

/**
 * Destructive leftist heap meld.
 * cmp < 0 means a belongs above b; mult = 1 gives a min heap, mult = -1 a max
 * heap. Equal values order arbitrarily (weight tie-breaks stay deterministic).
 */
function meld(
  a: HNode | null,
  b: HNode | null,
  mult: 1 | -1,
): HNode | null {
  if (a === null) return b;
  if (b === null) return a;
  if (mult * a.value > mult * b.value) {
    const t = a;
    a = b;
    b = t;
  }
  a.right = meld(a.right, b, mult);
  const rl = a.left ? a.left.rank : 0;
  const rr = a.right ? a.right.rank : 0;
  if (rl < rr) {
    const t = a.left;
    a.left = a.right;
    a.right = t;
  }
  a.rank = (a.right ? a.right.rank : 0) + 1;
  return a;
}

function popLo(h: HNode | null): HNode | null {
  return meld(h ? h.left : null, h ? h.right : null, -1);
}

function popHi(h: HNode | null): HNode | null {
  return meld(h ? h.left : null, h ? h.right : null, 1);
}

// ---------------------------------------------------------------------------
// PAVA blocks.
// ---------------------------------------------------------------------------

interface Block {
  lo: HNode | null; // lower half (max heap), root is the block value candidate
  hi: HNode | null; // upper half (min heap)
  wLo: number;
  wHi: number;
  total: number; // total observation weight
  memberHead: EntryNode | null; // linked list of observations, index ascending
  memberTail: EntryNode | null;
}

interface EntryNode {
  index: number;
  next: EntryNode | null;
}

function singleton(index: number, value: number, weight: number): Block {
  const head: EntryNode = { index, next: null };
  return {
    lo: makeNode(value, weight),
    hi: null,
    wLo: weight,
    wHi: 0,
    total: weight,
    memberHead: head,
    memberTail: head,
  };
}

/** Merge PAVA block b into a (a precedes b). Rebalances to the lower weighted median. */
function mergeBlocks(a: Block, b: Block): Block {
  a.lo = meld(a.lo, b.lo, -1);
  a.hi = meld(a.hi, b.hi, 1);
  a.wLo += b.wLo;
  a.wHi += b.wHi;
  a.total += b.total;
  if (a.memberTail) a.memberTail.next = b.memberHead;
  else a.memberHead = b.memberHead;
  a.memberTail = b.memberTail;

  // Lower weighted median m = smallest v with 2 * weight(<= v) >= total.
  // lo holds values <= m (max heap at its root), hi values >= m (min heap).
  for (;;) {
    // Too little weight below the cut: pull the smallest hi value down.
    if (2 * a.wLo < a.total) {
      const node = a.hi!;
      a.hi = popHi(a.hi);
      a.wHi -= node.weight;
      // node's children stayed in hi; detach before reinserting into lo so
      // the node is never shared between both heaps (would create cycles).
      node.left = null;
      node.right = null;
      node.rank = 1;
      a.lo = meld(a.lo, node, -1);
      a.wLo += node.weight;
      continue;
    }
    // Too much weight in lo: its root is above the median, push it up.
    if (a.lo !== null && 2 * (a.wLo - a.lo.weight) >= a.total) {
      const node = a.lo;
      a.lo = popLo(a.lo);
      a.wLo -= node.weight;
      node.left = null;
      node.right = null;
      node.rank = 1;
      a.hi = meld(a.hi, node, 1);
      a.wHi += node.weight;
      continue;
    }
    // Inverted pair across the cut: exchange both roots. Every exchange
    // resolves a distinct crossing pair, so the loop terminates.
    if (a.lo !== null && a.hi !== null && a.lo.value > a.hi.value) {
      const top = a.lo;
      const bot = a.hi;
      a.lo = popLo(a.lo);
      a.hi = popHi(a.hi);
      a.wLo -= top.weight;
      a.wHi -= bot.weight;
      top.left = top.right = null;
      top.rank = 1;
      bot.left = bot.right = null;
      bot.rank = 1;
      a.lo = meld(a.lo, bot, -1);
      a.wLo += bot.weight;
      a.hi = meld(a.hi, top, 1);
      a.wHi += top.weight;
      continue;
    }
    break;
  }
  return a;
}

/**
 * Isotonic regression on indices lo..hi of the transformed coordinates.
 * b[j] = base[j] - P[j]. Every fitted value is forced into the constant box
 * [floor, ceilL] — the per-index bounds are dominated by these under
 * isotonicity, and clamping targets before PAVA preserves the optimum.
 * Optional frozen pin endpoints: left block fixed to floor, right to ceilL —
 * each sentinel outweighs twice the whole segment, so its block value can
 * never move; feasibility guarantees floor <= ceilL so the sentinels never
 * merge into one another.
 */
function solveSegment(
  lo: number,
  hi: number,
  b: ReadonlyArray<number>,
  floor: number,
  ceilL: number,
  leftPin: boolean,
  rightPin: boolean,
): { y: number[]; cost: number } {
  // Every frozen endpoint outweighs twice the whole segment, so its block can
  // never evaluate to anything but its pinned value.
  const pinWeight = 2 * (hi - lo + 1) + 2;
  const stack: Block[] = [];

  const push = (index: number, value: number, weight: number): void => {
    let blk = singleton(index, value, weight);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      // top.lo is never null (every block keeps at least the median in lo).
      if (top.lo!.value <= blk.lo!.value) break;
      stack.pop();
      blk = mergeBlocks(top, blk);
    }
    stack.push(blk);
  };

  // Segment members are clamped to the constant feasible box; a fitted value
  // at a box edge is equivalent in feasibility and the isotonic projection is
  // unchanged because the frozen endpoint sentinels enforce monotonic access.
  if (leftPin) push(lo - 1, floor, pinWeight);
  for (let j = lo; j <= hi; j++) {
    const v = Math.min(ceilL, Math.max(floor, b[j]));
    push(j, v, 1);
  }
  if (rightPin) push(hi + 1, ceilL, pinWeight); // sentinel, output excluded

  const y = new Array<number>(hi - lo + 1);
  let cost = 0;
  for (const blk of stack) {
    const value = blk.lo!.value;
    let entry = blk.memberHead;
    while (entry !== null) {
      const j = entry.index;
      if (j >= lo && j <= hi) {
        y[j - lo] = value;
        // Cost is measured against the unclamped target b[j].
        cost += Math.abs(value - b[j]);
      }
      entry = entry.next;
    }
  }
  return { y, cost };
}

export function solve(input: SolveInput): SolveResult {
  return solveCore(input.cues, input.base, input.pins ?? new Map(), DAY_MS);
}

function solveCore(
  cues: ReadonlyArray<Cue>,
  base: ReadonlyArray<number>,
  pins: Pins,
  daySpan: number,
): SolveResult {
  const n = cues.length;
  if (n === 0) return { ok: true, starts: [], cost: 0 };

  // Prefix durations P[i] = sum_{k < i} duration[k].
  const P = new Array<number>(n);
  P[0] = 0;
  for (let i = 0; i + 1 < n; i++) {
    P[i + 1] = P[i] + cues[i].duration;
  }
  const b = new Array<number>(n);
  for (let i = 0; i < n; i++) b[i] = base[i] - P[i];

  const pinAt = new Array<number | null>(n).fill(null);
  for (const [idx, start] of pins) {
    if (
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= n ||
      !Number.isInteger(start) ||
      start < 0 ||
      start > daySpan
    ) {
      return { ok: false, reason: 'INFEASIBLE' };
    }
    pinAt[idx] = start;
  }

  // Sorted pin indices.
  const pinIdx: number[] = [];
  for (let i = 0; i < n; i++) if (pinAt[i] !== null) pinIdx.push(i);

  // Feasibility in x-space.
  // Leading / interior / trailing prefix-duration bounds.
  if (pinIdx.length > 0) {
    const first = pinIdx[0];
    if (pinAt[first]! < P[first]) return { ok: false, reason: 'INFEASIBLE' };
    for (let k = 1; k < pinIdx.length; k++) {
      const p = pinIdx[k - 1];
      const q = pinIdx[k];
      if (pinAt[q]! - pinAt[p]! < P[q] - P[p]) {
        return { ok: false, reason: 'INFEASIBLE' };
      }
    }
    const last = pinIdx[pinIdx.length - 1];
    if (pinAt[last]! > daySpan - (P[n - 1] - P[last])) {
      return { ok: false, reason: 'INFEASIBLE' };
    }
  } else if (P[n - 1] > daySpan) {
    return { ok: false, reason: 'INFEASIBLE' };
  }

  // Transformed pin values y = x - P[i].
  const pinY = new Map<number, number>();
  for (const i of pinIdx) pinY.set(i, pinAt[i]! - P[i]);

  const y = new Array<number>(n);
  let cost = 0;

  if (pinIdx.length === 0) {
    // Per-index bounds: y[0] >= 0 and y[n-1] <= daySpan - P[n-1]; all others
    // are dominated by these and the isotonic chain.
    const seg = solveSegment(0, n - 1, b, 0, daySpan - P[n - 1], false, false);
    for (let i = 0; i < n; i++) y[i] = seg.y[i];
    cost = seg.cost;
  } else {
    const first = pinIdx[0];
    if (first > 0) {
      // Leading segment: lower bound 0 dominates all y[i] >= -P[i].
      const seg = solveSegment(
        0,
        first - 1,
        b,
        0,
        pinY.get(first)!,
        false,
        true,
      );
      for (let t = 0; t < first; t++) y[t] = seg.y[t];
      cost += seg.cost;
    }
    for (let k = 0; k < pinIdx.length; k++) {
      const p = pinIdx[k];
      const q = k + 1 < pinIdx.length ? pinIdx[k + 1] : n;
      y[p] = pinY.get(p)!;
      // The pinned cue's own displacement is a constant under the constraint
      // but still belongs to the total absolute displacement.
      cost += Math.abs(pinY.get(p)! - b[p]);
      if (p + 1 <= q - 1) {
        // Trailing: upper bound daySpan - P[n-1] dominates y[i] <= D - P[i].
        const isTrailing = q === n;
        const seg = solveSegment(
          p + 1,
          q - 1,
          b,
          pinY.get(p)!,
          isTrailing ? daySpan - P[n - 1] : pinY.get(q)!,
          true,
          isTrailing ? false : true,
        );
        for (let t = p + 1; t <= q - 1; t++) y[t] = seg.y[t - (p + 1)];
        cost += seg.cost;
      }
    }
  }

  const starts = new Array<number>(n);
  for (let i = 0; i < n; i++) starts[i] = y[i] + P[i];

  // Defensive verification (contract checks; should never fire).
  for (let i = 0; i < n; i++) {
    if (!Number.isInteger(starts[i]) || starts[i] < 0 || starts[i] > daySpan) {
      return { ok: false, reason: 'INFEASIBLE' };
    }
    if (i > 0 && starts[i] < starts[i - 1] + cues[i - 1].duration) {
      return { ok: false, reason: 'INFEASIBLE' };
    }
    if (pinAt[i] !== null && starts[i] !== pinAt[i]) {
      return { ok: false, reason: 'INFEASIBLE' };
    }
  }

  return { ok: true, starts, cost };
}
