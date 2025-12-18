// FILE: src/pages/BulkStockUpload.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface ClubSizeRow {
  id: string;
  size_label: string;
  sort_order: number | null;
  // UI-only fields:
  numbersInput: string;
  quantityInput: string;
}

const BulkStockUpload: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  const [sizeRows, setSizeRows] = useState<ClubSizeRow[]>([]);

  const [loadingClubs, setLoadingClubs] = useState(false);
  const [loadingSizes, setLoadingSizes] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string>("");

  // --- NEW: size label management ---
  const [sizeEdit, setSizeEdit] = useState<Record<string, string>>({}); // id -> new label
  const [renameSaving, setRenameSaving] = useState<Record<string, boolean>>({}); // id -> saving
  const [newSizeLabel, setNewSizeLabel] = useState<string>("");
  const [addingSize, setAddingSize] = useState(false);

  const normaliseSize = (s: string) => (s ?? "").trim();

  // Load client clubs
  useEffect(() => {
    const loadClubs = async () => {
      setLoadingClubs(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from("clubs")
          .select("id, name, is_client")
          .eq("is_client", true)
          .order("name", { ascending: true });

        if (error) {
          console.error("BulkStockUpload loadClubs error", error);
          setError("Failed to load clubs.");
          return;
        }

        const list = (data ?? []) as Club[];
        setClubs(list);
        if (list.length > 0) {
          setSelectedClubId(list[0].id);
        }
      } finally {
        setLoadingClubs(false);
      }
    };

    void loadClubs();
  }, []);

  const loadSizes = async (clubId: string) => {
    if (!clubId) {
      setSizeRows([]);
      setSizeEdit({});
      return;
    }

    setLoadingSizes(true);
    setError(null);
    setSuccessMessage("");

    try {
      const { data, error } = await supabase
        .from("club_sizes")
        .select("id, size_label, sort_order")
        .eq("club_id", clubId)
        .order("sort_order", { ascending: true })
        .order("size_label", { ascending: true });

      if (error) {
        console.error("BulkStockUpload loadSizes error", error);
        setError("Failed to load size configuration for this club.");
        return;
      }

      const list = (data ?? []) as {
        id: string;
        size_label: string;
        sort_order: number | null;
      }[];

      if (list.length === 0) {
        setSizeRows([]);
        setSizeEdit({});
        setError(
          "No size configuration found for this club. Please set up club_sizes first."
        );
        return;
      }

      const rows: ClubSizeRow[] = list.map((row) => ({
        ...row,
        numbersInput: "",
        quantityInput: "",
      }));

      setSizeRows(rows);

      // Initialize edit map with current labels
      const editMap: Record<string, string> = {};
      rows.forEach((r) => {
        editMap[r.id] = r.size_label;
      });
      setSizeEdit(editMap);
    } finally {
      setLoadingSizes(false);
    }
  };

  // Load club_sizes for selected club
  useEffect(() => {
    void loadSizes(selectedClubId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClubId]);

  const handleClubChange = (clubId: string) => {
    setSelectedClubId(clubId);
    setSizeRows([]);
    setSizeEdit({});
    setError(null);
    setSuccessMessage("");
  };

  const handleNumbersChange = (id: string, value: string) => {
    setSizeRows((prev) => prev.map((r) => (r.id === id ? { ...r, numbersInput: value } : r)));
  };

  const handleQuantityChange = (id: string, value: string) => {
    setSizeRows((prev) => prev.map((r) => (r.id === id ? { ...r, quantityInput: value } : r)));
  };

  const handleClear = () => {
    setSizeRows((prev) =>
      prev.map((r) => ({
        ...r,
        numbersInput: "",
        quantityInput: "",
      }))
    );
    setError(null);
    setSuccessMessage("");
  };

  const selectedClubName = clubs.find((c) => c.id === selectedClubId)?.name ?? "";

  const existingLabels = useMemo(() => {
    const set = new Set<string>();
    sizeRows.forEach((r) => set.add(normaliseSize(r.size_label).toLowerCase()));
    return set;
  }, [sizeRows]);

  // --- NEW: rename size label (club_sizes) + propagate to data tables ---
  const handleRenameSizeLabel = async (row: ClubSizeRow) => {
    setError(null);
    setSuccessMessage("");

    if (!selectedClubId) {
      setError("Please select a club.");
      return;
    }

    const oldLabel = normaliseSize(row.size_label);
    const newLabel = normaliseSize(sizeEdit[row.id] ?? "");

    if (!oldLabel) {
      setError("Old size label is empty.");
      return;
    }
    if (!newLabel) {
      setError("New size label cannot be empty.");
      return;
    }
    if (oldLabel === newLabel) {
      setSuccessMessage("No change - label is already the same.");
      return;
    }

    // Guard: don't accidentally merge labels
    if (existingLabels.has(newLabel.toLowerCase())) {
      setError(
        `Size "${newLabel}" already exists in club_sizes for this club. Choose a unique label.`
      );
      return;
    }

    setRenameSaving((prev) => ({ ...prev, [row.id]: true }));
    try {
      // 1) update club_sizes label
      const { error: csErr } = await supabase
        .from("club_sizes")
        .update({ size_label: newLabel })
        .eq("id", row.id);

      if (csErr) {
        console.error("Rename club_sizes error", csErr);
        setError(csErr.message ?? "Failed to rename size label.");
        return;
      }

      // 2) propagate rename to inventory
      const { error: invErr } = await supabase
        .from("inventory")
        .update({ size: newLabel })
        .eq("club_id", selectedClubId)
        .eq("size", oldLabel);

      if (invErr) {
        console.error("Rename inventory.size error", invErr);
        setError(
          invErr.message ??
            "Renamed club size label, but failed to update inventory size values."
        );
        return;
      }

      // 3) propagate rename to pending_allocations
      const { error: pendErr } = await supabase
        .from("pending_allocations")
        .update({ size: newLabel })
        .eq("club_id", selectedClubId)
        .eq("size", oldLabel);

      if (pendErr) {
        console.error("Rename pending_allocations.size error", pendErr);
        setError(
          pendErr.message ??
            "Renamed club size label, but failed to update pending allocations size values."
        );
        return;
      }

      // 4) propagate rename to allocations (history/reporting)
      const { error: allocErr } = await supabase
        .from("allocations")
        .update({ size: newLabel })
        .eq("club_id", selectedClubId)
        .eq("size", oldLabel);

      if (allocErr) {
        console.error("Rename allocations.size error", allocErr);
        setError(
          allocErr.message ??
            "Renamed club size label, but failed to update allocations size values."
        );
        return;
      }

      setSuccessMessage(`Renamed size "${oldLabel}" -> "${newLabel}".`);

      // Reload sizes to reflect new label and reset edit map
      await loadSizes(selectedClubId);
    } catch (err: any) {
      console.error("handleRenameSizeLabel error", err);
      setError(err.message ?? "Unexpected error during size rename.");
    } finally {
      setRenameSaving((prev) => ({ ...prev, [row.id]: false }));
    }
  };

  // --- NEW: add a size label to club_sizes (persists immediately) ---
  const handleAddSize = async () => {
    setError(null);
    setSuccessMessage("");

    if (!selectedClubId) {
      setError("Please select a club first.");
      return;
    }

    const label = normaliseSize(newSizeLabel);
    if (!label) {
      setError("Please enter a size label to add.");
      return;
    }

    if (existingLabels.has(label.toLowerCase())) {
      setError("That size label already exists for this club.");
      return;
    }

    setAddingSize(true);
    try {
      // Determine next sort order (append to end)
      const maxSort = sizeRows.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0);
      const nextSort = (Number.isFinite(maxSort) ? maxSort : 0) + 1;

      const { data, error } = await supabase
        .from("club_sizes")
        .insert({
          club_id: selectedClubId,
          size_label: label,
          sort_order: nextSort,
        })
        .select("id, size_label, sort_order")
        .limit(1);

      if (error) {
        console.error("Add size club_sizes error", error);
        setError(error.message ?? "Failed to add size label.");
        return;
      }

      const inserted = (data ?? [])[0] as { id: string; size_label: string; sort_order: number | null } | undefined;
      if (!inserted) {
        setError("Add size succeeded but returned no row.");
        return;
      }

      setNewSizeLabel("");
      setSuccessMessage(`Added size "${label}" to this club.`);

      // Reload from DB so ordering is consistent
      await loadSizes(selectedClubId);
    } catch (err: any) {
      console.error("handleAddSize error", err);
      setError(err.message ?? "Unexpected error adding size label.");
    } finally {
      setAddingSize(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage("");

    if (!selectedClubId) {
      setError("Please select a club before uploading stock.");
      return;
    }

    // Build inventory rows
    const inventoryRows: {
      jersey_number: number;
      size: string;
      status: string;
      condition: string;
      club_id: string;
    }[] = [];

    for (const row of sizeRows) {
      const rawQty = row.quantityInput.trim();
      if (rawQty === "") {
        // no quantity = skip this size
        continue;
      }

      const qtyNum = Number(rawQty);
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
        // invalid or non-positive quantity; skip but warn at the end
        console.warn(
          `Skipping size ${row.size_label} due to invalid quantity: "${row.quantityInput}"`
        );
        continue;
      }

      // Parse numbers; allow "0" as a valid number.
      const numberStrings = row.numbersInput
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n !== "" && !isNaN(Number(n)));

      if (numberStrings.length === 0) {
        console.warn(
          `Skipping size ${row.size_label} because no valid numbers were provided.`
        );
        continue;
      }

      // Round-robin assign numbers so total rows == qtyNum
      for (let i = 0; i < qtyNum; i++) {
        const idx = i % numberStrings.length;
        const nStr = numberStrings[idx];
        const jerseyNumber = Number(nStr); // 0 is valid

        inventoryRows.push({
          jersey_number: jerseyNumber,
          size: row.size_label,
          status: "Available",
          condition: "New",
          club_id: selectedClubId,
        });
      }
    }

    if (inventoryRows.length === 0) {
      setError(
        "No valid inventory rows to insert. Please check numbers and quantities."
      );
      return;
    }

    setSubmitting(true);
    try {
      const { error: insertError, count } = await supabase
        .from("inventory")
        .insert(inventoryRows, { count: "exact" });

      if (insertError) {
        console.error("BulkStockUpload insert error", insertError);
        setError(
          insertError.message ||
            "Failed to insert inventory rows. Please try again."
        );
        return;
      }

      setSuccessMessage(
        `Successfully added ${count ?? inventoryRows.length} inventory rows for this club.`
      );

      // Clear inputs but keep size list
      setSizeRows((prev) =>
        prev.map((r) => ({
          ...r,
          numbersInput: "",
          quantityInput: "",
        }))
      );
    } catch (err: any) {
      console.error("BulkStockUpload handleSubmit error", err);
      setError(err.message ?? "Unexpected error during bulk upload.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Bulk Stock Upload</h1>
      <p className="text-sm text-gray-600 mb-6">
        Seed or adjust jersey inventory for a club in bulk. Sizes are locked to
        that club&apos;s configured labels to keep everything consistent.
        Enter comma-separated jersey numbers and a total quantity per size.
      </p>

      {/* Club selector */}
      <div className="mb-4">
        <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
          Club
        </label>
        <select
          value={selectedClubId}
          onChange={(e) => handleClubChange(e.target.value)}
          className="border rounded px-3 py-2 min-w-[220px]"
          disabled={loadingClubs}
        >
          {loadingClubs && <option value="">Loading clubs...</option>}
          {!loadingClubs && clubs.length === 0 && (
            <option value="">No client clubs found</option>
          )}
          {!loadingClubs &&
            clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </div>

      {/* --- NEW: Size Manager panel --- */}
      {selectedClubId && (
        <div className="mb-6 bg-white border border-gray-200 rounded-xl shadow-sm p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">
                Size Manager
              </h2>
              <p className="text-xs text-gray-500">
                Rename sizes to match Shopify labels (eg Youth 12 -> Y12) or add new sizes for this club.
                Renames update inventory + allocations + pending allocations.
              </p>
            </div>
            <button
              type="button"
              onClick={() => loadSizes(selectedClubId)}
              disabled={loadingSizes}
              className="px-3 py-1.5 rounded bg-slate-800 text-white text-xs font-semibold disabled:bg-gray-400"
            >
              {loadingSizes ? "Refreshing…" : "Refresh sizes"}
            </button>
          </div>

          <div className="mt-4 flex flex-col sm:flex-row gap-2">
            <input
              value={newSizeLabel}
              onChange={(e) => setNewSizeLabel(e.target.value)}
              placeholder='Add new size label (eg "Y12")'
              className="flex-1 border rounded px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={handleAddSize}
              disabled={addingSize}
              className="px-4 py-2 rounded bg-indigo-600 text-white text-sm font-semibold disabled:bg-gray-400"
            >
              {addingSize ? "Adding…" : "Add size"}
            </button>
          </div>

          <div className="mt-4 overflow-x-auto border rounded bg-white">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-3 py-2 text-left w-40">Current label</th>
                  <th className="px-3 py-2 text-left">New label</th>
                  <th className="px-3 py-2 text-right w-32">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadingSizes ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-gray-500">
                      Loading sizes…
                    </td>
                  </tr>
                ) : sizeRows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-gray-500">
                      No sizes found for this club.
                    </td>
                  </tr>
                ) : (
                  sizeRows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-gray-100 odd:bg-white even:bg-gray-50"
                    >
                      <td className="px-3 py-2 font-semibold">{row.size_label}</td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={sizeEdit[row.id] ?? row.size_label}
                          onChange={(e) =>
                            setSizeEdit((prev) => ({ ...prev, [row.id]: e.target.value }))
                          }
                          className="w-full border rounded px-2 py-1 text-xs"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleRenameSizeLabel(row)}
                          disabled={!!renameSaving[row.id]}
                          className="px-3 py-1.5 rounded bg-emerald-600 text-white text-xs font-semibold disabled:bg-gray-400"
                        >
                          {renameSaving[row.id] ? "Saving…" : "Rename"}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Errors / status */}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-3">
          {successMessage}
        </div>
      )}

      {/* Size grid + form */}
      {loadingSizes && (
        <div className="text-sm text-gray-600">Loading sizes…</div>
      )}

      {!loadingSizes && sizeRows.length === 0 && !error && (
        <div className="text-sm text-gray-500">
          No size configuration found for this club.
        </div>
      )}

      {!loadingSizes && sizeRows.length > 0 && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-sm font-semibold">
              Sizes for {selectedClubName || "selected club"}
            </h2>
            <button
              type="button"
              onClick={handleClear}
              className="text-xs px-3 py-1 border rounded text-gray-700 hover:bg-gray-50"
            >
              Clear All Inputs
            </button>
          </div>

          <div className="overflow-x-auto border rounded bg-white">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-3 py-2 text-left w-32">Size</th>
                  <th className="px-3 py-2 text-left">
                    Jersey Numbers (comma-separated)
                  </th>
                  <th className="px-3 py-2 text-left w-28">
                    Total Quantity
                  </th>
                </tr>
              </thead>
              <tbody>
                {sizeRows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-gray-100 odd:bg-white even:bg-gray-50"
                  >
                    <td className="px-3 py-2 align-top font-semibold">
                      {row.size_label}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        type="text"
                        value={row.numbersInput}
                        onChange={(e) =>
                          handleNumbersChange(row.id, e.target.value)
                        }
                        placeholder="e.g. 4, 5, 6, 0"
                        className="w-full border rounded px-2 py-1 text-xs"
                      />
                      <p className="text-[10px] text-gray-500 mt-1">
                        0 is allowed. Invalid entries will be ignored.
                      </p>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <input
                        type="number"
                        min={0}
                        value={row.quantityInput}
                        onChange={(e) =>
                          handleQuantityChange(row.id, e.target.value)
                        }
                        placeholder="e.g. 10"
                        className="w-full border rounded px-2 py-1 text-xs"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-emerald-600 text-white rounded text-sm disabled:bg-gray-400"
            >
              {submitting ? "Uploading…" : "Upload Stock to Inventory"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

export default BulkStockUpload;
