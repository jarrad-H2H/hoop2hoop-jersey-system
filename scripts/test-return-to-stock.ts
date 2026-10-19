// returnJerseyToStock: a physical return frees an Allocated jersey, and a jersey that is only marked
// Written Off (auto-written-off when a returning player bought a replacement, e.g. Frankie Hunter's #88)
// is restored ONLY after the caller confirms. Runs against an in-memory fake: it never touches the
// live database.
// Run with: npx tsx scripts/test-return-to-stock.ts
import { returnJerseyToStock } from "../src/services/allocation";

type Row = { id: string; club_id: string; jersey_number: number; size: string; product_type: string; status: string;
  allocated_player_id: string | null; allocation_date: string | null; return_date_due: string | null };

const CLUB = "club-1";
const row = (id: string, status: string, over: Partial<Row> = {}): Row => ({
  id, club_id: CLUB, jersey_number: 88, size: "G10", product_type: "womens", status,
  allocated_player_id: status === "Allocated" ? "player-1" : null,
  allocation_date: status === "Allocated" ? "2026-09-03" : null, return_date_due: null, ...over,
});

class Query {
  private filters: [string, unknown][] = [];
  private mode: "select" | "update" = "select";
  private payload: Partial<Row> = {};
  private limitN = Infinity;
  private returnRows = false;
  constructor(private rows: Row[], private beforeUpdate?: () => void) {}
  select() { if (this.mode === "update") this.returnRows = true; return this; }
  update(p: Partial<Row>) { this.mode = "update"; this.payload = p; return this; }
  eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
  limit(n: number) { this.limitN = n; return this; }
  then(resolve: (v: { data: unknown; error: null }) => unknown) {
    if (this.mode === "update") this.beforeUpdate?.();
    const hits = this.rows.filter((r) => this.filters.every(([c, v]) => (r as any)[c] === v));
    if (this.mode === "update") {
      hits.forEach((r) => Object.assign(r, this.payload));
      return resolve({ data: this.returnRows ? hits.map((r) => ({ id: r.id })) : null, error: null });
    }
    return resolve({ data: hits.slice(0, this.limitN).map((r) => ({ id: r.id, status: r.status })), error: null });
  }
}
const fake = (rows: Row[], beforeUpdate?: () => void) => ({ from: () => new Query(rows, beforeUpdate) }) as any;

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} - ${label}`);
  if (!ok) failures++;
}
const logs: any[] = [];
const log = async (e: any) => { logs.push(e); return { success: true }; };
const run = (rows: Row[], restore = false, beforeUpdate?: () => void, over: { size?: string; pt?: string } = {}) => {
  logs.length = 0;
  return returnJerseyToStock(CLUB, 88, over.size ?? "G10", over.pt ?? "womens", { restoreWrittenOff: restore }, { client: fake(rows, beforeUpdate), log });
};

// 1. Normal return: an Allocated jersey is freed, exactly as before
{
  const rows = [row("a", "Allocated")];
  const r = await run(rows);
  check("normal return succeeds", r.success && !r.needsConfirmation);
  check("normal return frees the row and clears its links", rows[0].status === "Available" && rows[0].allocated_player_id === null && rows[0].allocation_date === null);
  check("normal return logs the plain note", logs.length === 1 && logs[0].note === "Warehouse return to stock" && logs[0].allocation_type === "return");
}

// 2. Only a Written Off jersey, no confirmation: nothing changes, caller is asked to confirm
{
  const rows = [row("w", "Written Off")];
  const r = await run(rows);
  check("written-off without confirmation is not restored", !r.success && r.needsConfirmation === "written_off");
  check("...and the row is untouched", rows[0].status === "Written Off");
  check("...and nothing is logged", logs.length === 0);
  check("...and the message tells the person what to do", /Written Off/.test(r.message) && /confirm/i.test(r.message));
}

// 3. Written Off with confirmation: restored and logged
{
  const rows = [row("w", "Written Off")];
  const r = await run(rows, true);
  check("written-off with confirmation succeeds", r.success && !r.needsConfirmation);
  check("...and the row is Available", rows[0].status === "Available");
  check("...and the log says it was restored", logs.length === 1 && /restored from Written Off/.test(logs[0].note));
}

// 4. An Allocated jersey wins over a Written Off one with the same number/size
{
  const rows = [row("w", "Written Off"), row("a", "Allocated")];
  const r = await run(rows);
  check("allocated is freed first when both exist", r.success && rows[1].status === "Available");
  check("...and the written-off one is left alone", rows[0].status === "Written Off");
}

// 5. Already Available: nothing to return, even if a written-off one exists
{
  const rows = [row("v", "Available"), row("w", "Written Off")];
  const r = await run(rows, true);
  check("already Available is reported, not restored", !r.success && /already Available/.test(r.message) && rows[1].status === "Written Off");
}

// 6. Nothing matches
{
  const r = await run([row("x", "Allocated", { jersey_number: 12 })]);
  check("no matching row is reported", !r.success && /No allocated inventory row/.test(r.message) && !r.needsConfirmation);
}

// 7. A row for another size / product pool / club is never touched
{
  const rows = [row("w", "Written Off", { size: "G12" }), row("m", "Written Off", { product_type: "mens" }), row("c", "Written Off", { club_id: "club-2" })];
  const r = await run(rows, true);
  check("other size, product pool or club is not restored", !r.success && rows.every((x) => x.status === "Written Off"));
}

// 8. The row changes between finding it and updating it: nothing is changed
{
  const rows = [row("w", "Written Off")];
  const r = await run(rows, true, () => { rows[0].status = "Allocated"; });
  check("a row that changed in the meantime is not overwritten", !r.success && /changed while/.test(r.message) && rows[0].status === "Allocated" && logs.length === 0);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
