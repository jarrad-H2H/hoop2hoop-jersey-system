// FILE: src/pages/PreOrderManager.tsx
// Admin page for managing per-club pre-order windows, running FCFS allocation,
// and importing/exporting correction spreadsheets.
// See ALLOCATION_LOGIC.md Section 17 for full design.
import React, { useCallback, useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, fetchAllPages } from "../services/supabase";
import { runFcfsAllocation, validateImportRow, finalisePreorder, getLockedShopifyUpdates, importPreallocatedRoster, type PreorderRequest, type PreallocatedImportRow } from "../services/preorder";
import { ClipboardList, Download, Upload, Play, Lock, Unlock, RefreshCw, Trash2 } from "lucide-react";
import { SkeletonTable } from "../components/ui/Skeleton";
import EmptyState from "../components/ui/EmptyState";

type PreorderMode = "off" | "open" | "closed" | "locked";

interface Club {
  id: string;
  name: string;
  preorder_mode: PreorderMode;
  allocation_type: "fcfs" | "pre_allocated";
}

const MODE_BADGE: Record<PreorderMode, { label: string; className: string }> = {
  off: { label: "Off", className: "bg-gray-100 text-gray-700 border-gray-300" },
  open: { label: "Open", className: "bg-green-100 text-green-800 border-green-300" },
  closed: { label: "Closed", className: "bg-yellow-100 text-yellow-800 border-yellow-300" },
  locked: { label: "Locked", className: "bg-blue-100 text-blue-700 border-blue-300" },
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  needs_size: "bg-amber-100 text-amber-800",
  allocated: "bg-green-100 text-green-800",
  overflow: "bg-red-100 text-red-700",
  locked: "bg-blue-100 text-blue-700",
};

const EXPORT_COLUMNS = [
  "request_id", "club_name", "age_group", "first_name", "last_name",
  "year_of_birth", "gender", "size", "jersey_name", "pref_1", "pref_2", "pref_3", "any_number",
  "claimed_current", "assigned_number", "status", "order_number", "paid_at", "admin_notes",
];

const CURRENT_SEASON = new Date().getFullYear();

const PreOrderManager: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [season, setSeason] = useState<string>(String(CURRENT_SEASON));
  const [loadingClubs, setLoadingClubs] = useState(true);

  const [requests, setRequests] = useState<PreorderRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [rosterImportError, setRosterImportError] = useState<string | null>(null);
  const [rosterImportSuccess, setRosterImportSuccess] = useState<string | null>(null);
  const [rosterProductType, setRosterProductType] = useState<"" | "unisex" | "mens" | "womens">("");
  const rosterFileInputRef = useRef<HTMLInputElement>(null);

  const [availableSeasons, setAvailableSeasons] = useState<string[]>([]);
  const [addingNewSeason, setAddingNewSeason] = useState(false);
  const [newSeasonInput, setNewSeasonInput] = useState("");

  const selectedClub = clubs.find(c => c.id === selectedClubId) ?? null;

  // ── Load available seasons for selected club ────────────────────────────────
  const loadAvailableSeasons = useCallback(async (clubId: string) => {
    if (!clubId) return;
    const { data } = await supabase
      .from("preorder_requests")
      .select("season")
      .eq("club_id", clubId)
      .order("season", { ascending: false });
    const distinct = [...new Set((data ?? []).map((r: any) => String(r.season)))];
    setAvailableSeasons(distinct);
    if (distinct.length > 0 && !distinct.includes(season)) {
      setSeason(distinct[0]);
    }
  }, [season]);

  // ── Load clubs ──────────────────────────────────────────────────────────────
  const loadClubs = useCallback(async () => {
    setLoadingClubs(true);
    const { data } = await supabase
      .from("clubs")
      .select("id, name, preorder_mode, allocation_type")
      .eq("is_client", true)
      .order("name");
    setClubs(((data ?? []) as any[]).map(c => ({ ...c, allocation_type: c.allocation_type ?? "fcfs" })) as Club[]);
    if (data && data.length > 0 && !selectedClubId) {
      setSelectedClubId((data[0] as Club).id);
    }
    setLoadingClubs(false);
  }, [selectedClubId]);

  useEffect(() => { void loadClubs(); }, []);

  // ── Load requests ───────────────────────────────────────────────────────────
  const loadRequests = useCallback(async () => {
    if (!selectedClubId) { setRequests([]); return; }
    setLoadingRequests(true);
    setLoadError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setLoadError("Session expired — please sign out and sign back in to view pre-order requests.");
        return;
      }
      const rows = await fetchAllPages<PreorderRequest>((from, to) =>
        supabase
          .from("preorder_requests")
          .select("id, club_id, first_name, last_name, year_of_birth, gender, size, age_group, pref_1, pref_2, pref_3, any_number, claimed_current, assigned_number, shopify_order_id, order_number, paid_at, status, created_at, jersey_name")
          .eq("club_id", selectedClubId)
          .eq("season", season)
          .order("paid_at", { ascending: true, nullsFirst: false })
          .order("created_at", { ascending: true })
          .range(from, to)
      );
      setRequests(rows);
    } catch (e: any) {
      setLoadError(e?.message ?? "Failed to load requests. Your session may have expired — try signing out and back in.");
    } finally {
      setLoadingRequests(false);
    }
  }, [selectedClubId, season]);

  useEffect(() => { void loadRequests(); }, [loadRequests]);
  useEffect(() => { if (selectedClubId) void loadAvailableSeasons(selectedClubId); }, [selectedClubId]);

  // ── Mode actions ────────────────────────────────────────────────────────────
  const setMode = async (mode: PreorderMode) => {
    if (!selectedClubId) return;
    setActionLoading(true);
    setActionMsg(null);
    const { error } = await supabase
      .from("clubs")
      .update({ preorder_mode: mode })
      .eq("id", selectedClubId);
    if (error) {
      setActionMsg({ type: "err", text: `Failed to update mode: ${error.message}` });
    } else {
      setClubs(prev => prev.map(c => c.id === selectedClubId ? { ...c, preorder_mode: mode } : c));
      setActionMsg({ type: "ok", text: `Pre-order window ${mode === "open" ? "opened" : mode === "closed" ? "closed" : "locked"}.` });
    }
    setActionLoading(false);
  };

  const handleGenerateReport = async () => {
    if (!selectedClubId) return;
    if (!window.confirm(`Generate allocation report for ${selectedClub?.name ?? "this club"} — season ${season}?\n\nThis will run the FCFS number allocation and download an Excel report for the club to review.`)) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      const result = await runFcfsAllocation(selectedClubId, season);
      // Fetch the freshly allocated rows so the export includes assigned numbers
      const fresh = await fetchAllPages<PreorderRequest>((from, to) =>
        supabase
          .from("preorder_requests")
          .select("id, club_id, first_name, last_name, year_of_birth, gender, size, age_group, pref_1, pref_2, pref_3, any_number, claimed_current, assigned_number, shopify_order_id, order_number, paid_at, status, created_at, jersey_name")
          .eq("club_id", selectedClubId)
          .eq("season", season)
          .order("paid_at", { ascending: true, nullsFirst: false })
          .order("created_at", { ascending: true })
          .range(from, to)
      );
      setRequests(fresh);
      handleExport(fresh);
      const overflowNote = result.overflow > 0 ? ` ⚠️ ${result.overflow} overflow — pool(s) exceeded 99 players, manual resolution needed.` : "";
      setActionMsg({ type: result.overflow > 0 ? "err" : "ok", text: `Report generated and downloaded. Send it to the club for review.${overflowNote}` });
    } catch (e: any) {
      setActionMsg({ type: "err", text: `Report generation failed: ${e?.message ?? "unknown error"}` });
    }
    setActionLoading(false);
  };

  const handleLock = async () => {
    if (!selectedClubId) return;
    if (!window.confirm(`Lock & finalise pre-order for ${selectedClub?.name ?? "this club"} — season ${season}?\n\nThis will write assigned numbers to player records and inventory. No further changes can be made via the admin panel after this.`)) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      const result = await finalisePreorder(selectedClubId, season);
      await setModeNoConfirm("locked");
      await loadRequests();

      const errNote = result.errors.length > 0 ? ` ${result.errors.length} error(s): ${result.errors.slice(0, 3).join("; ")}` : "";
      let shopifyNote = "";

      // Write allocated numbers back to Shopify orders as note_attributes (shows on packing slip)
      if (result.shopifyUpdates.length > 0) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const token = session?.access_token ?? "";
          const syncRes = await fetch("/api/preorder/sync-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ orders: result.shopifyUpdates }),
          });
          const syncJson = await syncRes.json();
          if (syncJson.ok) {
            shopifyNote = ` ${syncJson.updated} Shopify order${syncJson.updated !== 1 ? "s" : ""} updated with allocated numbers.`;
            if (syncJson.errors?.length > 0) {
              shopifyNote += ` (${syncJson.errors.length} Shopify update error(s) — check server logs.)`;
            }
          } else {
            shopifyNote = ` Shopify update failed: ${syncJson.error ?? "unknown"}`;
          }
        } catch {
          shopifyNote = " Could not update Shopify orders — numbers are locked in the system but packing slips may need manual update.";
        }
      }

      const hasErr = result.errors.length > 0;
      setActionMsg({ type: hasErr ? "err" : "ok", text: `Confirmed ${result.locked} allocations.${errNote}${shopifyNote}` });
    } catch (e: any) {
      setActionMsg({ type: "err", text: `Lock failed: ${e?.message ?? "unknown error"}` });
    }
    setActionLoading(false);
  };

  const handleResync = async () => {
    if (!selectedClubId) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      const updates = await getLockedShopifyUpdates(selectedClubId, season);
      if (updates.length === 0) {
        setActionMsg({ type: "ok", text: "No locked allocations with Shopify order data found to re-sync." });
        setActionLoading(false);
        return;
      }
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      const syncRes = await fetch("/api/preorder/sync-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ orders: updates }),
      });
      const syncJson = await syncRes.json();
      if (syncJson.ok) {
        let msg = `Re-synced ${syncJson.updated} Shopify order${syncJson.updated !== 1 ? "s" : ""} with allocated numbers.`;
        if (syncJson.errors?.length > 0) msg += ` (${syncJson.errors.length} error(s) — check server logs.)`;
        setActionMsg({ type: "ok", text: msg });
      } else {
        setActionMsg({ type: "err", text: `Re-sync failed: ${syncJson.error ?? "unknown"}` });
      }
    } catch (e: any) {
      setActionMsg({ type: "err", text: `Re-sync failed: ${e?.message ?? "unknown"}` });
    }
    setActionLoading(false);
  };

  const setModeNoConfirm = async (mode: PreorderMode) => {
    await supabase.from("clubs").update({ preorder_mode: mode }).eq("id", selectedClubId);
    setClubs(prev => prev.map(c => c.id === selectedClubId ? { ...c, preorder_mode: mode } : c));
  };

  const handleClearRoster = async () => {
    if (!selectedClubId || !season) return;
    const clubName = selectedClub?.name ?? "this club";
    if (!window.confirm(`Delete ALL pre-order records for ${clubName} — season "${season}"?\n\nThis cannot be undone.`)) return;
    setActionLoading(true);
    setActionMsg(null);
    const { error } = await supabase
      .from("preorder_requests")
      .delete()
      .eq("club_id", selectedClubId)
      .eq("season", season);
    if (error) {
      setActionMsg({ type: "err", text: `Delete failed: ${error.message}` });
    } else {
      setRequests([]);
      await loadAvailableSeasons(selectedClubId);
      setActionMsg({ type: "ok", text: `All records for season "${season}" deleted.` });
    }
    setActionLoading(false);
  };

  const handleDeleteRequest = async (id: string, playerName: string) => {
    if (!window.confirm(`Delete pre-order entry for ${playerName}?\n\nThis cannot be undone.`)) return;
    setActionLoading(true);
    setActionMsg(null);
    const { error } = await supabase.from("preorder_requests").delete().eq("id", id);
    if (error) {
      setActionMsg({ type: "err", text: `Delete failed: ${error.message}` });
    } else {
      setRequests(prev => prev.filter(r => r.id !== id));
      setActionMsg({ type: "ok", text: `Deleted entry for ${playerName}.` });
    }
    setActionLoading(false);
  };

  // ── Excel export ────────────────────────────────────────────────────────────
  const handleExport = (exportRows?: PreorderRequest[]) => {
    const data = exportRows ?? requests;
    if (data.length === 0) return;
    const clubName = selectedClub?.name ?? "";
    const sheetRows = data.map(r => ({
      request_id: r.id,
      club_name: clubName,
      age_group: r.age_group ?? "",
      first_name: r.first_name,
      last_name: r.last_name,
      year_of_birth: r.year_of_birth,
      gender: r.gender ?? "",
      size: r.size ?? "",
      jersey_name: (r as any).jersey_name ?? "",
      pref_1: r.pref_1 ?? "",
      pref_2: r.pref_2 ?? "",
      pref_3: r.pref_3 ?? "",
      any_number: r.any_number ? "TRUE" : "FALSE",
      claimed_current: r.claimed_current ?? "",
      assigned_number: r.assigned_number ?? "",
      status: r.status,
      order_number: r.order_number ?? "",
      paid_at: r.paid_at ? new Date(r.paid_at).toLocaleString() : "",
      admin_notes: "",
    }));
    const ws = XLSX.utils.json_to_sheet(sheetRows, { header: EXPORT_COLUMNS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pre-Orders");
    XLSX.writeFile(wb, `preorder_${clubName.replace(/\s+/g, "_")}_${season}.xlsx`);
  };

  // ── Excel import (correction round-trip) ────────────────────────────────────
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setImportSuccess(null);

    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });

      // Validate headers
      const firstRow = rawRows[0] ?? {};
      const missingCols = ["request_id", "assigned_number"].filter(c => !(c in firstRow));
      if (missingCols.length > 0) {
        setImportError(`Missing required columns: ${missingCols.join(", ")}. Export a fresh copy and only edit the assigned_number column.`);
        return;
      }

      // Validate all rows first — reject entire import on any error
      const errors: string[] = [];
      for (let i = 0; i < rawRows.length; i++) {
        const err = validateImportRow(rawRows[i], i + 2); // +2: header is row 1
        if (err) errors.push(err);
      }
      if (errors.length > 0) {
        setImportError(`Import rejected — fix the following errors and re-import:\n\n${errors.join("\n")}`);
        return;
      }

      // Collect IDs that exist in our loaded requests (for unknown-ID detection)
      const knownIds = new Set(requests.map(r => r.id));
      const unknownIds = rawRows
        .map((r, i) => ({ id: String(r["request_id"] ?? "").trim(), i }))
        .filter(({ id }) => id && !knownIds.has(id));
      if (unknownIds.length > 0) {
        setImportError(`Import rejected — ${unknownIds.length} unknown request_id(s) found. Only import a spreadsheet exported from this page for this club and season.`);
        return;
      }

      // Apply updates — only rows where assigned_number is non-blank
      const toUpdate = rawRows
        .map(r => ({
          id: String(r["request_id"] ?? "").trim(),
          assigned_number: r["assigned_number"] !== "" && r["assigned_number"] != null ? Number(r["assigned_number"]) : null,
        }))
        .filter(r => r.id && r.assigned_number != null);

      if (toUpdate.length === 0) {
        setImportSuccess("No assigned_number values to apply — nothing changed.");
        return;
      }

      await Promise.all(
        toUpdate.map(u =>
          supabase
            .from("preorder_requests")
            .update({ assigned_number: u.assigned_number, status: "allocated" })
            .eq("id", u.id)
        )
      );

      await loadRequests();
      setImportSuccess(`Applied ${toUpdate.length} number assignment(s) from import.`);
    } catch (e: any) {
      setImportError(`Import failed: ${e?.message ?? "unknown error"}`);
    }

    // Reset file input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── Allocation type toggle ───────────────────────────────────────────────────
  const setAllocationType = async (type: "fcfs" | "pre_allocated") => {
    if (!selectedClubId) return;
    const { error } = await supabase.from("clubs").update({ allocation_type: type }).eq("id", selectedClubId);
    if (!error) {
      setClubs(prev => prev.map(c => c.id === selectedClubId ? { ...c, allocation_type: type } : c));
    }
  };

  // ── Pre-allocated roster CSV import ─────────────────────────────────────────
  const handleRosterImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRosterImportError(null);
    setRosterImportSuccess(null);

    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });

      if (rawRows.length === 0) { setRosterImportError("File is empty."); return; }

      const firstRow = rawRows[0] ?? {};
      const required = ["first_name", "last_name", "jersey_number", "year_of_birth"];
      const missing = required.filter(c => !(c in firstRow));
      if (missing.length > 0) {
        setRosterImportError(`Missing required columns: ${missing.join(", ")}. Download the template and use it as the base.`);
        return;
      }

      const errors: string[] = [];
      const parsed: PreallocatedImportRow[] = [];

      rawRows.forEach((row, i) => {
        const rowNum = i + 2;
        const firstName = String(row["first_name"] ?? "").trim();
        const lastName = String(row["last_name"] ?? "").trim();
        const jerseyNumber = Number(row["jersey_number"]);
        const rawYob = row["year_of_birth"];
        const yearOfBirth = rawYob !== undefined && rawYob !== null && rawYob !== ""
          ? Number(rawYob) : null;

        if (!firstName) { errors.push(`Row ${rowNum}: first_name is blank.`); return; }
        if (!lastName) { errors.push(`Row ${rowNum}: last_name is blank.`); return; }
        if (!Number.isFinite(jerseyNumber) || !Number.isInteger(jerseyNumber) || jerseyNumber < 0 || jerseyNumber > 99 || jerseyNumber === 69) {
          errors.push(`Row ${rowNum}: jersey_number "${row["jersey_number"]}" must be 0–99 and not 69.`); return;
        }
        if (yearOfBirth !== null && (!Number.isFinite(yearOfBirth) || yearOfBirth < 1900 || yearOfBirth > 2100)) {
          errors.push(`Row ${rowNum}: year_of_birth "${rawYob}" is not a valid year.`); return;
        }

        parsed.push({
          first_name: firstName,
          last_name: lastName,
          jersey_number: jerseyNumber,
          year_of_birth: yearOfBirth,
          gender: String(row["gender"] ?? "").trim() || null,
          age_group: String(row["age_group"] ?? "").trim() || null,
          parent_1_name: String(row["parent_1_name"] ?? "").trim() || null,
          parent_1_email: String(row["parent_1_email"] ?? "").trim() || null,
          parent_1_mobile: String(row["parent_1_mobile"] ?? "").trim() || null,
          parent_2_name: String(row["parent_2_name"] ?? "").trim() || null,
          parent_2_email: String(row["parent_2_email"] ?? "").trim() || null,
          parent_2_mobile: String(row["parent_2_mobile"] ?? "").trim() || null,
        });
      });

      if (errors.length > 0) {
        setRosterImportError(`Import rejected — fix the following errors:\n\n${errors.join("\n")}`);
        return;
      }

      const result = await importPreallocatedRoster(selectedClubId, season, parsed, rosterProductType);
      await Promise.all([loadRequests(), loadAvailableSeasons(selectedClubId)]);
      const parts = [`Imported ${result.inserted} new + updated ${result.updated} existing records.`];
      if (result.errors.length > 0) parts.push(`${result.errors.length} error(s): ${result.errors.slice(0, 3).join("; ")}`);
      setRosterImportSuccess(parts.join(" "));
    } catch (e: any) {
      setRosterImportError(`Import failed: ${e?.message ?? "unknown error"}`);
    }

    if (rosterFileInputRef.current) rosterFileInputRef.current.value = "";
    setRosterProductType("");
  };

  const handleDownloadRosterTemplate = () => {
    const headers = ["first_name", "last_name", "jersey_number", "year_of_birth", "gender", "age_group", "parent_1_name", "parent_1_email", "parent_1_mobile", "parent_2_name", "parent_2_email", "parent_2_mobile"];
    const example = { first_name: "Jordan", last_name: "Smith", jersey_number: 6, year_of_birth: 2008, gender: "Female", age_group: "U18", parent_1_name: "Alex Smith", parent_1_email: "alex.smith@email.com", parent_1_mobile: "0400000000", parent_2_name: "", parent_2_email: "", parent_2_mobile: "" };
    const ws = XLSX.utils.json_to_sheet([example], { header: headers });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Roster");
    XLSX.writeFile(wb, "preallocated_roster_template.xlsx");
  };

  // ── Counts ──────────────────────────────────────────────────────────────────
  const counts = {
    pending: requests.filter(r => r.status === "pending").length,
    allocated: requests.filter(r => r.status === "allocated").length,
    overflow: requests.filter(r => r.status === "overflow").length,
    locked: requests.filter(r => r.status === "locked").length,
    needs_size: requests.filter(r => r.status === "needs_size").length,
    total: requests.length,
  };

  const mode = selectedClub?.preorder_mode ?? "off";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <ClipboardList size={28} className="text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pre-Order Manager</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage pre-order windows, run FCFS number allocation, and import/export correction spreadsheets.
          </p>
        </div>
      </div>

      {/* Club + Season selectors */}
      <div className="flex flex-wrap gap-4 mb-6">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Club</label>
          <select
            value={selectedClubId}
            onChange={e => setSelectedClubId(e.target.value)}
            disabled={loadingClubs}
            className="border rounded px-3 py-2 min-w-[200px]"
          >
            {loadingClubs && <option>Loading…</option>}
            {!loadingClubs && clubs.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.preorder_mode !== "off" ? ` (${MODE_BADGE[c.preorder_mode].label})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Season</label>
          <div className="flex items-center gap-2">
            {availableSeasons.length > 0 && !addingNewSeason ? (
              <select
                value={season}
                onChange={e => setSeason(e.target.value)}
                className="border rounded px-3 py-2 min-w-[140px]"
              >
                {availableSeasons.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : !addingNewSeason ? (
              <span className="text-sm text-gray-400 italic">No seasons yet</span>
            ) : null}
            {addingNewSeason ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={newSeasonInput}
                  onChange={e => setNewSeasonInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && newSeasonInput.trim()) {
                      const s = newSeasonInput.trim();
                      setAvailableSeasons(prev => prev.includes(s) ? prev : [s, ...prev]);
                      setSeason(s);
                      setNewSeasonInput("");
                      setAddingNewSeason(false);
                    }
                    if (e.key === "Escape") { setAddingNewSeason(false); setNewSeasonInput(""); }
                  }}
                  autoFocus
                  placeholder="e.g. 2027 U18"
                  className="border rounded px-3 py-2 w-36"
                />
                <button
                  type="button"
                  onClick={() => {
                    const s = newSeasonInput.trim();
                    if (!s) return;
                    setAvailableSeasons(prev => prev.includes(s) ? prev : [s, ...prev]);
                    setSeason(s);
                    setNewSeasonInput("");
                    setAddingNewSeason(false);
                  }}
                  className="px-3 py-2 bg-brand-600 text-white rounded text-sm font-medium hover:bg-brand-700"
                >Add</button>
                <button
                  type="button"
                  onClick={() => { setAddingNewSeason(false); setNewSeasonInput(""); }}
                  className="px-2 py-2 text-gray-400 hover:text-gray-600 text-sm"
                >✕</button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingNewSeason(true)}
                className="px-3 py-2 border border-dashed border-gray-400 text-gray-600 rounded text-sm hover:bg-gray-50"
                title="Add new season / age group"
              >+ New</button>
            )}
          </div>
        </div>
        <div className="flex items-end">
          <button
            type="button"
            onClick={loadRequests}
            disabled={loadingRequests}
            className="flex items-center gap-1 px-3 py-2 border rounded text-sm text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {/* Mode status card */}
      {selectedClub && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
          <div className="flex flex-wrap items-center gap-4 mb-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-700">Pre-Order Window:</span>
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border ${MODE_BADGE[mode].className}`}>
                {MODE_BADGE[mode].label}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-700">Mode:</span>
              <select
                value={selectedClub?.allocation_type ?? "fcfs"}
                onChange={e => setAllocationType(e.target.value as "fcfs" | "pre_allocated")}
                className="border rounded px-2 py-1 text-xs"
              >
                <option value="fcfs">FCFS (players choose)</option>
                <option value="pre_allocated">Pre-allocated (numbers set by club)</option>
              </select>
            </div>
          </div>

          {/* Count summary */}
          {counts.total > 0 && (
            <div className="flex flex-wrap gap-4 mb-4 text-sm">
              <span className="text-gray-600">Total: <strong>{counts.total}</strong></span>
              {selectedClub?.allocation_type === "pre_allocated" ? (
                <>
                  <span className="text-amber-700">Awaiting size: <strong>{counts.needs_size}</strong></span>
                  <span className="text-emerald-700">Size confirmed: <strong>{counts.allocated}</strong></span>
                </>
              ) : (
                <>
                  <span className="text-gray-600">Pending: <strong>{counts.pending}</strong></span>
                  <span className="text-emerald-700">Allocated: <strong>{counts.allocated}</strong></span>
                  {counts.overflow > 0 && <span className="text-red-700">Overflow: <strong>{counts.overflow}</strong></span>}
                </>
              )}
              {counts.locked > 0 && <span className="text-blue-700">Locked: <strong>{counts.locked}</strong></span>}
            </div>
          )}

          {/* Action buttons — linear 4-step workflow */}
          <div className="flex flex-wrap gap-3">

            {/* Step 0: open the window */}
            {(mode === "off" || mode === "closed" || mode === "locked") && (
              <button
                type="button"
                onClick={() => setMode("open")}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                <Unlock size={15} />
                {mode === "off" ? "Open Pre-Order Window" : "Re-Open Window"}
              </button>
            )}

            {/* Re-sync: push allocated numbers to Shopify again (locked state only) */}
            {mode === "locked" && (
              <button
                type="button"
                onClick={handleResync}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-lg text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
              >
                <RefreshCw size={15} />
                Re-sync Shopify Orders
              </button>
            )}

            {/* Step 1: close the window (taking orders → closed) */}
            {mode === "open" && (
              <button
                type="button"
                onClick={() => setMode("closed")}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                <Lock size={15} />
                Close Pre-Orders
              </button>
            )}

            {/* Pre-allocated: import roster (shown when mode is open or closed, not locked) */}
            {selectedClub?.allocation_type === "pre_allocated" && mode !== "locked" && mode !== "off" && (
              <>
                <select
                  value={rosterProductType}
                  onChange={e => setRosterProductType(e.target.value as "" | "unisex" | "mens" | "womens")}
                  className={`border rounded px-2 py-2 text-xs ${rosterProductType === "" ? "text-gray-400 border-red-300" : "text-gray-700"}`}
                  title="Select product type before importing"
                >
                  <option value="" disabled>— Select product type —</option>
                  <option value="unisex">Unisex</option>
                  <option value="mens">Mens</option>
                  <option value="womens">Womens</option>
                </select>
                <label className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm font-medium transition-colors ${rosterProductType === "" ? "border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed pointer-events-none" : "border-amber-400 text-amber-800 bg-amber-50 hover:bg-amber-100 cursor-pointer"}`}>
                  <Upload size={15} />
                  Import Pre-Allocated Roster
                  <input
                    ref={rosterFileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleRosterImport}
                    disabled={rosterProductType === ""}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleDownloadRosterTemplate}
                  className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50"
                >
                  <Download size={15} />
                  Download Template
                </button>
              </>
            )}

            {/* Pre-allocated: lock when all sizes confirmed */}
            {selectedClub?.allocation_type === "pre_allocated" && mode === "closed" && counts.needs_size === 0 && counts.allocated > 0 && (
              <button
                type="button"
                onClick={handleLock}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                <Lock size={15} />
                Confirm &amp; Write to Orders
                <span className="ml-1 bg-white/20 px-1.5 rounded-full">{counts.allocated}</span>
              </button>
            )}

            {/* Pre-allocated: waiting on sizes message */}
            {selectedClub?.allocation_type === "pre_allocated" && mode === "closed" && counts.needs_size > 0 && (
              <span className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Waiting on {counts.needs_size} player{counts.needs_size !== 1 ? "s" : ""} to confirm their size before you can finalise.
              </span>
            )}

            {/* Step 2: run FCFS + auto-download report for club review
                Only shown when mode=closed, FCFS mode, and no numbers have been allocated yet */}
            {selectedClub?.allocation_type !== "pre_allocated" && mode === "closed" && counts.allocated === 0 && counts.overflow === 0 && counts.pending > 0 && (
              <button
                type="button"
                onClick={handleGenerateReport}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                <Play size={15} />
                Generate Allocation Report
                <span className="ml-1 bg-white/20 px-1.5 rounded-full">{counts.pending}</span>
              </button>
            )}

            {/* Steps 3 & 4: shown once FCFS allocation has been run */}
            {selectedClub?.allocation_type !== "pre_allocated" && mode === "closed" && (counts.allocated > 0 || counts.overflow > 0) && (
              <>
                {/* Step 3: upload the club's approved/corrected report */}
                <label className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 cursor-pointer">
                  <Upload size={15} />
                  Upload Approved Report
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={handleImportFile}
                    className="hidden"
                  />
                </label>

                {/* Step 4: lock, write to players/inventory, and update Shopify orders */}
                <button
                  type="button"
                  onClick={handleLock}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  <Lock size={15} />
                  Confirm &amp; Write to Orders
                </button>
              </>
            )}

            {/* Re-download report — available whenever there are requests */}
            {requests.length > 0 && mode !== "off" && (
              <button
                type="button"
                onClick={() => handleExport()}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50"
              >
                <Download size={15} />
                {mode === "open" ? "Export Current Requests" : "Re-download Report"}
              </button>
            )}

            {/* Delete Season — always available when there's data */}
            {requests.length > 0 && (
              <button
                type="button"
                onClick={handleClearRoster}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 border border-red-300 text-red-700 bg-red-50 rounded-lg text-sm font-medium hover:bg-red-100 disabled:opacity-50"
              >
                <Trash2 size={15} />
                Delete Season
              </button>
            )}

          </div>

          {/* Action result */}
          {actionMsg && (
            <div className={`mt-4 p-3 rounded text-sm ${actionMsg.type === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
              {actionMsg.text}
            </div>
          )}
          {importError && (
            <div className="mt-4 p-3 rounded text-sm bg-red-50 text-red-800 whitespace-pre-wrap">
              {importError}
            </div>
          )}
          {importSuccess && (
            <div className="mt-4 p-3 rounded text-sm bg-green-50 text-green-800">
              {importSuccess}
            </div>
          )}
          {rosterImportError && (
            <div className="mt-4 p-3 rounded text-sm bg-red-50 text-red-800 whitespace-pre-wrap">
              {rosterImportError}
            </div>
          )}
          {rosterImportSuccess && (
            <div className="mt-4 p-3 rounded text-sm bg-green-50 text-green-800">
              {rosterImportSuccess}
            </div>
          )}
        </div>
      )}

      {/* Requests table */}
      {loadingRequests && <SkeletonTable rows={6} cols={8} />}

      {loadError && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
          {loadError}
        </div>
      )}

      {!loadingRequests && !loadError && requests.length === 0 && selectedClubId && (
        <EmptyState
          icon={ClipboardList}
          title="No pre-order requests yet"
          description={mode === "open" ? "Requests appear here as customers submit their preferences." : "Open the pre-order window to start collecting preferences."}
        />
      )}

      {!loadingRequests && requests.length > 0 && (
        <div className="overflow-x-auto bg-white rounded-xl shadow-sm border border-gray-200">
          <div className="px-4 py-2 text-xs text-gray-500 border-b">
            {requests.length} request{requests.length !== 1 ? "s" : ""} · sorted by payment time (earliest = highest FCFS priority)
          </div>
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">#</th>
                <th className="px-3 py-2 text-left font-semibold">Player</th>
                <th className="px-3 py-2 text-left font-semibold">YOB</th>
                <th className="px-3 py-2 text-left font-semibold">Gender</th>
                <th className="px-3 py-2 text-left font-semibold">Age Group</th>
                <th className="px-3 py-2 text-left font-semibold">Size</th>
                <th className="px-3 py-2 text-left font-semibold">Preferences</th>
                <th className="px-3 py-2 text-left font-semibold">Assigned #</th>
                <th className="px-3 py-2 text-left font-semibold">Jersey Name</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-left font-semibold">Paid At</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r, idx) => (
                <tr key={r.id} className="border-t border-gray-100 odd:bg-white even:bg-gray-50">
                  <td className="px-3 py-2 text-gray-400">{idx + 1}</td>
                  <td className="px-3 py-2 font-medium">
                    {r.first_name} {r.last_name}
                    {r.order_number && <span className="ml-1 text-gray-400">#{r.order_number}</span>}
                  </td>
                  <td className="px-3 py-2">{r.year_of_birth}</td>
                  <td className="px-3 py-2">{r.gender ?? "—"}</td>
                  <td className="px-3 py-2">{r.age_group ?? "—"}</td>
                  <td className="px-3 py-2">{r.size}</td>
                  <td className="px-3 py-2">
                    {r.any_number ? (
                      <span className="italic text-gray-500">Any</span>
                    ) : (
                      <span>
                        {[r.pref_1, r.pref_2, r.pref_3]
                          .filter(p => p != null)
                          .map((p, i) => <span key={i} className="mr-1">#{p}</span>)}
                      </span>
                    )}
                    {r.claimed_current != null && (
                      <span className="ml-1 text-purple-700">(reclaim #{r.claimed_current})</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.assigned_number != null
                      ? <span className="font-bold text-brand-700">#{r.assigned_number}</span>
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 font-medium text-gray-800">
                    {(r as any).jersey_name ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_BADGE[r.status] ?? ""}`}>
                      {r.status === "needs_size" ? "needs size" : r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                    {r.paid_at ? new Date(r.paid_at).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => handleDeleteRequest(r.id, `${r.first_name} ${r.last_name}`)}
                      disabled={actionLoading}
                      className="text-red-400 hover:text-red-700 disabled:opacity-40"
                      title="Delete this entry"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default PreOrderManager;
