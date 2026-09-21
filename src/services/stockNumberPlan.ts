// FILE: src/services/stockNumberPlan.ts
// Pure planning logic for choosing clash-free print numbers for warehouse stock.
// For each birth year (cohort) we work out which numbers are already worn by players
// whose YOB falls inside that cohort's clash window (Section 3 of ALLOCATION_LOGIC.md,
// i.e. the same ±1 year rule the widget uses), then pick stock numbers per size that
// are free for the cohorts that typically order that size.
import { getClashYobWindow, yobOverlapsWindow } from "./allocation";

export const PLAN_NUMBERS: number[] = Array.from({ length: 100 }, (_, i) => i).filter(
  (n) => n !== 69
);

export interface NumberHolder {
  number: number;
  exactYob: number | null;
  estMin: number | null;
  estMax: number | null;
  ageGroup: string | null;
}

export interface DemandRow {
  yob: number;
  size: string;
}

export interface Cohort {
  yob: number;
  demand: number;
  blocked: Set<number>;
  free: number[];
}

export interface SuggestedNumber {
  number: number;
  /** Share (0–1) of this size's demand whose cohorts are clash-free for this number. */
  coverage: number;
}

export interface SizeSuggestion {
  size: string;
  units: number;
  cohortYobs: number[];
  numbers: SuggestedNumber[];
  shortfall: number;
}

/** One cohort per distinct birth year seen in demand, with the numbers blocked in its clash window. */
export function buildCohorts(
  holders: NumberHolder[],
  demand: DemandRow[],
  currentYear: number,
  hasU8: boolean
): Cohort[] {
  const demandByYob = new Map<number, number>();
  for (const d of demand) demandByYob.set(d.yob, (demandByYob.get(d.yob) ?? 0) + 1);

  return Array.from(demandByYob.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([yob, count]) => {
      const win = getClashYobWindow(yob, currentYear, hasU8);
      const blocked = new Set<number>();
      for (const h of holders) {
        if (yobOverlapsWindow(h.exactYob, h.estMin, h.estMax, h.ageGroup, currentYear, win)) {
          blocked.add(h.number);
        }
      }
      return {
        yob,
        demand: count,
        blocked,
        free: PLAN_NUMBERS.filter((n) => !blocked.has(n)),
      };
    });
}

/**
 * Pick numbers for each size. A size's "typical" cohorts are the birth years that
 * make up `coverageTarget` of its demand. Numbers free for every typical cohort rank
 * first, then numbers free for most of the demand; numbers not already picked for
 * another size are preferred so print runs don't duplicate numbers needlessly.
 */
export function suggestStockNumbers(params: {
  cohorts: Cohort[];
  demand: DemandRow[];
  unitsBySize: Record<string, number>;
  stockNumbersBySize: Record<string, Set<number>>;
  coverageTarget?: number;
}): SizeSuggestion[] {
  const { cohorts, demand, unitsBySize, stockNumbersBySize } = params;
  const coverageTarget = params.coverageTarget ?? 0.8;
  const cohortByYob = new Map(cohorts.map((c) => [c.yob, c]));
  const usedGlobally = new Set<number>();

  const sizes = Object.keys(unitsBySize)
    .filter((s) => (unitsBySize[s] ?? 0) > 0)
    .sort((a, b) => unitsBySize[b] - unitsBySize[a]);

  const out: SizeSuggestion[] = [];
  for (const size of sizes) {
    const units = unitsBySize[size];

    const countByYob = new Map<number, number>();
    for (const d of demand) {
      if (d.size === size) countByYob.set(d.yob, (countByYob.get(d.yob) ?? 0) + 1);
    }
    const totalDemand = Array.from(countByYob.values()).reduce((a, b) => a + b, 0);
    const ranked = Array.from(countByYob.entries()).sort((a, b) => b[1] - a[1]);

    const typical: number[] = [];
    let cum = 0;
    for (const [yob, c] of ranked) {
      typical.push(yob);
      cum += c;
      if (totalDemand > 0 && cum / totalDemand >= coverageTarget) break;
    }

    const alreadyInStock = stockNumbersBySize[size] ?? new Set<number>();
    const scored = PLAN_NUMBERS.filter((n) => !alreadyInStock.has(n)).map((n) => {
      let freeWeight = 0;
      for (const [yob, c] of ranked) {
        const cohort = cohortByYob.get(yob);
        if (cohort && !cohort.blocked.has(n)) freeWeight += c;
      }
      const coverage = totalDemand > 0 ? freeWeight / totalDemand : 1;
      const clean = typical.every((yob) => !cohortByYob.get(yob)?.blocked.has(n));
      return { n, coverage, clean };
    });

    scored.sort((a, b) => {
      if (a.clean !== b.clean) return a.clean ? -1 : 1;
      const ua = usedGlobally.has(a.n) ? 1 : 0;
      const ub = usedGlobally.has(b.n) ? 1 : 0;
      if (ua !== ub) return ua - ub;
      if (a.coverage !== b.coverage) return b.coverage - a.coverage;
      return a.n - b.n;
    });

    const picked = scored.slice(0, units);
    for (const p of picked) usedGlobally.add(p.n);

    out.push({
      size,
      units,
      cohortYobs: typical.sort((a, b) => a - b),
      numbers: picked
        .map((p) => ({ number: p.n, coverage: p.coverage }))
        .sort((a, b) => a.number - b.number),
      shortfall: Math.max(0, units - picked.length),
    });
  }
  return out;
}
