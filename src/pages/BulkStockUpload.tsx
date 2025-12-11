// FILE: src/pages/BulkStockUpload.tsx
import React, { useEffect, useState } from "react";
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

  // Load club_sizes for selected club
  useEffect(() => {
    const loadSizes = async () => {
      if (!selectedClubId) {
        setSizeRows([]);
        return;
      }

      setLoadingSizes(true);
      setError(null);
      setSuccessMessage("");

      try {
        const { data, error } = await supabase
          .from("club_sizes")
          .select("id, size_label, sort_order")
          .eq("club_id", selectedClubId)
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
      } finally {
        setLoadingSizes(false);
      }
    };

    void loadSizes();
  }, [selectedClubId]);

  const handleClubChange = (clubId: string) => {
    setSelectedClubId(clubId);
    setSizeRows([]);
    setError(null);
    setSuccessMessage("");
  };

  const handleNumbersChange = (id: string, value: string) => {
    setSizeRows((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, numbersInput: value } : r
      )
    );
  };

  const handleQuantityChange = (id: string, value: string) => {
    setSizeRows((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, quantityInput: value } : r
      )
    );
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

  const selectedClubName =
    clubs.find((c) => c.id === selectedClubId)?.name ?? "";

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
