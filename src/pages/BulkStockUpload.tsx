// FILE: src/pages/BulkStockUpload.tsx
import React, { useEffect, useMemo, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../services/supabase";
import * as XLSX from "xlsx";
import { Shirt, Upload } from "lucide-react";
import { SkeletonTable } from "../components/ui/Skeleton";
import EmptyState from "../components/ui/EmptyState";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface ClubSizeRow {
  id: string;
  size_label: string;
  sort_order: number | null;

  // UI-only fields for stock upload:
  numbersInput: string;
  quantityInput: string;

  // UI-only fields for editing size labels:
  isEditing?: boolean;
  draftLabel?: string;
}

const BulkStockUpload: React.FC = () => {
  // Inventory Manager links here as /admin/inventory/bulk-upload/:clubId -- honour that
  // when present, instead of always defaulting to whichever client club loads first.
  const { clubId: routeClubId } = useParams<{ clubId: string }>();
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  // Product type (default/mens/womens) -- clubs with dual Shopify products (mens +
  // womens) have a SEPARATE stock pool per product_type. "default" always available
  // as an option (single/unisex-product clubs, or generic sizing not tied to a product).
  const [productTypeOptions, setProductTypeOptions] = useState<string[]>(["default"]);
  const [selectedProductType, setSelectedProductType] = useState<string>("default");

  const [sizeRows, setSizeRows] = useState<ClubSizeRow[]>([]);

  const [loadingClubs, setLoadingClubs] = useState(false);
  const [loadingSizes, setLoadingSizes] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string>("");

  // Shopify sync
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    success: boolean;
    location: string;
    products: {
      productId: string;
      gender: string;
      success: boolean;
      results: { variantTitle: string; available: number; matched: boolean; ok: boolean }[];
      warnings?: { unmatchedVariants?: string[]; unmatchedSizes?: string[] };
    }[];
  } | null>(null);

  // Add-size UI
  const [newSizeLabel, setNewSizeLabel] = useState<string>("");

  // File upload (CSV/Excel) UI
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [fileParseError, setFileParseError] = useState<string | null>(null);
  const [fileParseSummary, setFileParseSummary] = useState<string | null>(null);

  // Current stock per size (keyed by size_label)
  const [stockMap, setStockMap] = useState<
    Map<string, { available: number; allocated: number }>
  >(new Map());

  const selectedClubName = useMemo(
    () => clubs.find((c) => c.id === selectedClubId)?.name ?? "",
    [clubs, selectedClubId]
  );

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
        if (routeClubId && list.some((c) => c.id === routeClubId)) {
          setSelectedClubId(routeClubId);
        } else if (list.length > 0) {
          setSelectedClubId(list[0].id);
        }
      } finally {
        setLoadingClubs(false);
      }
    };

    void loadClubs();
  }, [routeClubId]);

  // Load which product types this club actually has Shopify products for
  useEffect(() => {
    const loadProductTypes = async () => {
      if (!selectedClubId) {
        setProductTypeOptions(["default"]);
        setSelectedProductType("default");
        return;
      }
      const { data } = await supabase
        .from("shopify_product_club_map")
        .select("product_type")
        .eq("club_id", selectedClubId);

      const mapped = Array.from(
        new Set((data ?? []).map((r: any) => (r.product_type || "default").trim()))
      );
      const options = Array.from(new Set(["default", ...mapped]));
      setProductTypeOptions(options);
      setSelectedProductType((prev) => (options.includes(prev) ? prev : "default"));
    };
    void loadProductTypes();
  }, [selectedClubId]);

  // Load club_sizes for selected club + product type
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
          .eq("product_type", selectedProductType)
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

        const rows: ClubSizeRow[] = list
          .map((row, idx) => ({
            id: row.id,
            size_label: row.size_label,
            sort_order: row.sort_order ?? idx + 1,
            numbersInput: "",
            quantityInput: "",
            isEditing: false,
            draftLabel: row.size_label,
          }))
          // ensure stable ordering even if sort_order nulls exist
          .sort((a, b) => (a.sort_order ?? 9999) - (b.sort_order ?? 9999));

        setSizeRows(rows);
      } finally {
        setLoadingSizes(false);
      }
    };

    void loadSizes();
  }, [selectedClubId, selectedProductType]);

  // Load current inventory stock counts for the selected club
  useEffect(() => {
    const loadStock = async () => {
      if (!selectedClubId) {
        setStockMap(new Map());
        return;
      }

      const { data } = await supabase
        .from("inventory")
        .select("size, status")
        .eq("club_id", selectedClubId)
        .eq("product_type", selectedProductType)
        .neq("status", "Written Off");

      const map = new Map<string, { available: number; allocated: number }>();
      for (const row of data ?? []) {
        const size = String(row.size ?? "").trim();
        if (!size) continue;
        if (!map.has(size)) map.set(size, { available: 0, allocated: 0 });
        const entry = map.get(size)!;
        if (row.status === "Available") {
          entry.available += 1;
        } else {
          entry.allocated += 1;
        }
      }
      setStockMap(map);
    };

    void loadStock();
  }, [selectedClubId, selectedProductType]);

  const handleClubChange = (clubId: string) => {
    setSelectedClubId(clubId);
    setSizeRows([]);
    setError(null);
    setSuccessMessage("");
    setNewSizeLabel("");
  };

  const handleNumbersChange = (id: string, value: string) => {
    // Auto-calculate quantity from valid jersey numbers entered
    const validCount = value
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n !== "" && !isNaN(Number(n))).length;

    setSizeRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              numbersInput: value,
              quantityInput: validCount > 0 ? String(validCount) : "",
            }
          : r
      )
    );
  };

  const handleQuantityChange = (id: string, value: string) => {
    setSizeRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, quantityInput: value } : r))
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

  // ----------------------------
  // CSV / Excel file upload -- parses a "size, jersey_number" file (one row
  // per physical jersey) and fills the existing per-size inputs below for
  // review, rather than inserting directly. This re-uses the same validated
  // submit path as manual entry.
  // ----------------------------
  const handleFileUpload = async (file: File) => {
    setFileParseError(null);
    setFileParseSummary(null);
    setError(null);
    setSuccessMessage("");

    try {
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: "array" });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        setFileParseError("Could not find a sheet in this file.");
        return;
      }
      const sheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });

      if (rows.length === 0) {
        setFileParseError("This file has no data rows.");
        return;
      }

      // Tolerate header variations: "size"/"Size", "jersey_number"/"Jersey Number"/"number".
      const findKey = (row: Record<string, unknown>, candidates: string[]) => {
        const keys = Object.keys(row);
        return keys.find((k) =>
          candidates.includes(k.trim().toLowerCase().replace(/\s+/g, "_"))
        );
      };

      const numbersBySize = new Map<string, string[]>();
      let skippedRows = 0;

      for (const row of rows) {
        const sizeKey = findKey(row, ["size", "size_label"]);
        const numberKey = findKey(row, ["jersey_number", "number", "jersey_no", "jersey"]);

        const sizeVal = sizeKey ? String(row[sizeKey] ?? "").trim() : "";
        const numberVal = numberKey ? String(row[numberKey] ?? "").trim() : "";

        if (!sizeVal || numberVal === "" || isNaN(Number(numberVal))) {
          skippedRows += 1;
          continue;
        }

        const list = numbersBySize.get(sizeVal) ?? [];
        list.push(numberVal);
        numbersBySize.set(sizeVal, list);
      }

      if (numbersBySize.size === 0) {
        setFileParseError(
          'No usable rows found. Expected columns "size" and "jersey_number" (one row per jersey).'
        );
        return;
      }

      const matchedSizes: string[] = [];
      const unmatchedSizes: string[] = [];

      setSizeRows((prev) =>
        prev.map((r) => {
          const fileMatch = Array.from(numbersBySize.keys()).find(
            (s) => s.toLowerCase() === r.size_label.toLowerCase()
          );
          if (!fileMatch) return r;

          matchedSizes.push(r.size_label);
          const incoming = numbersBySize.get(fileMatch)!;
          const existing = r.numbersInput
            .split(",")
            .map((n) => n.trim())
            .filter((n) => n !== "");
          const combined = [...existing, ...incoming];

          return {
            ...r,
            numbersInput: combined.join(", "),
            quantityInput: String(combined.length),
          };
        })
      );

      for (const sizeVal of numbersBySize.keys()) {
        if (!matchedSizes.some((m) => m.toLowerCase() === sizeVal.toLowerCase())) {
          unmatchedSizes.push(sizeVal);
        }
      }

      const parts: string[] = [];
      if (matchedSizes.length > 0) {
        parts.push(`Loaded numbers into ${matchedSizes.length} size row(s): ${matchedSizes.join(", ")}.`);
      }
      if (unmatchedSizes.length > 0) {
        parts.push(
          `Skipped sizes not configured for this club: ${unmatchedSizes.join(", ")} — add them above first, then re-upload.`
        );
      }
      if (skippedRows > 0) {
        parts.push(`Ignored ${skippedRows} row(s) with missing/invalid size or number.`);
      }
      parts.push('Review the numbers below, then click "Upload Stock to Inventory" to save.');

      setFileParseSummary(parts.join(" "));
    } catch (err: any) {
      console.error("handleFileUpload error", err);
      setFileParseError(err.message ?? "Failed to read this file. Please check the format and try again.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // ----------------------------
  // Size label editing + adding
  // ----------------------------
  const startEditSize = (id: string) => {
    setError(null);
    setSuccessMessage("");
    setSizeRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, isEditing: true, draftLabel: r.size_label }
          : r
      )
    );
  };

  const cancelEditSize = (id: string) => {
    setSizeRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, isEditing: false, draftLabel: r.size_label }
          : r
      )
    );
  };

  const setDraftLabel = (id: string, value: string) => {
    setSizeRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, draftLabel: value } : r))
    );
  };

  const saveSizeLabel = async (row: ClubSizeRow) => {
    setError(null);
    setSuccessMessage("");

    if (!selectedClubId) {
      setError("No club selected.");
      return;
    }

    const oldLabel = (row.size_label ?? "").trim();
    const newLabel = (row.draftLabel ?? "").trim();

    if (!oldLabel) {
      setError("Old size label is missing.");
      return;
    }
    if (!newLabel) {
      setError("New size label cannot be blank.");
      return;
    }
    if (newLabel === oldLabel) {
      // nothing to do
      setSizeRows((prev) =>
        prev.map((r) =>
          r.id === row.id ? { ...r, isEditing: false } : r
        )
      );
      return;
    }

    // prevent duplicates within this club
    const dup = sizeRows.some(
      (r) =>
        r.id !== row.id &&
        (r.size_label ?? "").trim().toLowerCase() === newLabel.toLowerCase()
    );
    if (dup) {
      setError(`A size label "${newLabel}" already exists for this club.`);
      return;
    }

    setSubmitting(true);
    try {
      // 1) Update club_sizes label
      const { error: csErr } = await supabase
        .from("club_sizes")
        .update({ size_label: newLabel })
        .eq("id", row.id);

      if (csErr) {
        console.error("saveSizeLabel club_sizes error", csErr);
        setError("Failed to rename size label in club_sizes.");
        return;
      }

      // 2) Propagate rename across inventory/allocations/pending_allocations
      // These updates are scoped to the club and old size label.
      const { error: invErr } = await supabase
        .from("inventory")
        .update({ size: newLabel })
        .eq("club_id", selectedClubId)
        .eq("size", oldLabel)
        .eq("product_type", selectedProductType);

      if (invErr) {
        console.error("saveSizeLabel inventory error", invErr);
        setError(
          "Size label updated in club_sizes, but failed to update inventory. Please contact support / re-run."
        );
        return;
      }

      const { error: allocErr } = await supabase
        .from("allocations")
        .update({ size: newLabel })
        .eq("club_id", selectedClubId)
        .eq("size", oldLabel)
        .eq("product_type", selectedProductType);

      if (allocErr) {
        console.error("saveSizeLabel allocations error", allocErr);
        setError(
          "Size label updated in club_sizes, but failed to update allocations. Please contact support / re-run."
        );
        return;
      }

      const { error: pendErr } = await supabase
        .from("pending_allocations")
        .update({ size: newLabel })
        .eq("club_id", selectedClubId)
        .eq("size", oldLabel)
        .eq("product_type", selectedProductType);

      // pending_allocations may not exist in some environments - but yours does.
      if (pendErr) {
        console.error("saveSizeLabel pending_allocations error", pendErr);
        setError(
          "Size label updated in club_sizes, but failed to update pending allocations. Please contact support / re-run."
        );
        return;
      }

      // Update local UI
      setSizeRows((prev) =>
        prev.map((r) =>
          r.id === row.id
            ? {
                ...r,
                size_label: newLabel,
                draftLabel: newLabel,
                isEditing: false,
              }
            : r
        )
      );

      setSuccessMessage(
        `Renamed size "${oldLabel}" to "${newLabel}" and updated linked records.`
      );
    } finally {
      setSubmitting(false);
    }
  };

  const addNewSize = async () => {
    setError(null);
    setSuccessMessage("");

    if (!selectedClubId) {
      setError("Please select a club first.");
      return;
    }

    const label = newSizeLabel.trim();
    if (!label) {
      setError("Please enter a size label to add.");
      return;
    }

    const dup = sizeRows.some(
      (r) => (r.size_label ?? "").trim().toLowerCase() === label.toLowerCase()
    );
    if (dup) {
      setError(`Size "${label}" already exists for this club.`);
      return;
    }

    const nextSort =
      (Math.max(
        0,
        ...sizeRows.map((r) => (typeof r.sort_order === "number" ? r.sort_order : 0))
      ) || 0) + 1;

    setSubmitting(true);
    try {
      const payload = {
        club_id: selectedClubId,
        size_label: label,
        sort_order: nextSort,
        product_type: selectedProductType,
      };

      const { data, error } = await supabase
        .from("club_sizes")
        .insert(payload)
        .select("id, size_label, sort_order")
        .limit(1);

      if (error) {
        console.error("addNewSize error", error);
        setError(error.message || "Failed to add new size.");
        return;
      }

      const inserted = (data ?? [])[0] as
        | { id: string; size_label: string; sort_order: number | null }
        | undefined;

      if (!inserted) {
        setError("Insert succeeded but returned no row.");
        return;
      }

      setSizeRows((prev) => [
        ...prev,
        {
          id: inserted.id,
          size_label: inserted.size_label,
          sort_order: inserted.sort_order ?? nextSort,
          numbersInput: "",
          quantityInput: "",
          isEditing: false,
          draftLabel: inserted.size_label,
        },
      ]);

      setNewSizeLabel("");
      setSuccessMessage(`Added new size "${label}".`);
    } finally {
      setSubmitting(false);
    }
  };

  // ----------------------------
  // Re-order sizes (sort_order)
  // ----------------------------
  const moveSizeRow = (rowId: string, direction: "up" | "down") => {
    setError(null);
    setSuccessMessage("");

    setSizeRows((prev) => {
      const idx = prev.findIndex((r) => r.id === rowId);
      if (idx === -1) return prev;

      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;

      const next = [...prev];
      const tmp = next[idx];
      next[idx] = next[targetIdx];
      next[targetIdx] = tmp;

      // update sort_order in UI immediately (1..N)
      return next.map((r, i) => ({ ...r, sort_order: i + 1 }));
    });
  };

  const saveSizeOrder = async () => {
    setError(null);
    setSuccessMessage("");

    if (!selectedClubId) {
      setError("Please select a club first.");
      return;
    }

    setSubmitting(true);
    try {
      const updates = sizeRows.map((r, index) => ({
        id: r.id,
        sort_order: index + 1,
      }));

      const { error } = await supabase.from("club_sizes").upsert(updates, {
        onConflict: "id",
      });

      if (error) {
        console.error("saveSizeOrder error", error);
        setError("Failed to save size order.");
        return;
      }

      setSuccessMessage("Size order saved.");
    } finally {
      setSubmitting(false);
    }
  };

  // ----------------------------
  // Bulk stock upload
  // ----------------------------
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
      product_type: string;
    }[] = [];

    for (const row of sizeRows) {
      const rawQty = row.quantityInput.trim();
      if (rawQty === "") continue; // no quantity = skip this size

      const qtyNum = Number(rawQty);
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
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
          product_type: selectedProductType,
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

      // Refresh stock counts
      const addedBySize = new Map<string, number>();
      for (const r of inventoryRows) {
        addedBySize.set(r.size, (addedBySize.get(r.size) ?? 0) + 1);
      }
      setStockMap((prev) => {
        const next = new Map<string, { available: number; allocated: number }>(prev);
        for (const [size, qty] of addedBySize.entries()) {
          const existing: { available: number; allocated: number } =
            next.get(size) ?? { available: 0, allocated: 0 };
          next.set(size, { ...existing, available: existing.available + qty });
        }
        return next;
      });
    } catch (err: any) {
      console.error("BulkStockUpload handleSubmit error", err);
      setError(err.message ?? "Unexpected error during bulk upload.");
    } finally {
      setSubmitting(false);
    }
  };

  // ----------------------------
  // Shopify inventory sync
  // ----------------------------
  const handleShopifySync = async () => {
    if (!selectedClubId) {
      setError("Please select a club first.");
      return;
    }

    setSyncing(true);
    setSyncResult(null);
    setError(null);
    setSuccessMessage("");

    try {
      const res = await fetch("/api/shopify-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubId: selectedClubId }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Shopify sync failed.");
        return;
      }

      setSyncResult(data);
      setSuccessMessage(
        data.success
          ? `Synced inventory to Shopify (${data.location}).`
          : "Sync completed with some errors — see details below."
      );
    } catch (err: any) {
      console.error("handleShopifySync error", err);
      setError(err.message ?? "Unexpected error during Shopify sync.");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Bulk Stock Upload</h1>
      <p className="text-sm text-gray-600 mb-6">
        Seed or adjust jersey inventory for a club in bulk. Sizes are linked to
        that club&apos;s configured labels to keep everything consistent.
        Enter comma-separated jersey numbers per size — quantity is calculated automatically.
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
          disabled={loadingClubs || submitting}
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

      {/* Product type selector -- only meaningful once a club is selected; shows "default"
          always, plus mens/womens if this club has dual Shopify products mapped. */}
      {selectedClubId && (
        <div className="mb-4">
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Product Type
          </label>
          <select
            value={selectedProductType}
            onChange={(e) => setSelectedProductType(e.target.value)}
            className="border rounded px-3 py-2 min-w-[220px]"
            disabled={submitting}
          >
            {productTypeOptions.map((pt) => (
              <option key={pt} value={pt}>
                {pt === "default" ? "Default / Unisex" : pt === "mens" ? "Mens" : pt === "womens" ? "Womens" : pt}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-gray-500">
            Each product type has its own separate stock pool — sizes and inventory entered here only apply to the selected one.
          </p>
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
      {fileParseError && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {fileParseError}
        </div>
      )}
      {fileParseSummary && (
        <div className="mb-4 text-sm text-brand-800 bg-brand-50 border border-brand-200 rounded p-3">
          {fileParseSummary}
        </div>
      )}

      {/* CSV / Excel upload */}
      {!loadingSizes && selectedClubId && sizeRows.length > 0 && (
        <div className="mb-6 border border-gray-200 rounded-lg bg-white p-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                <Upload size={16} className="text-brand-600" />
                Upload from CSV / Excel
              </h2>
              <p className="text-xs text-gray-500 max-w-xl">
                File needs a <span className="font-mono">size</span> column and a{" "}
                <span className="font-mono">jersey_number</span> column, with one row per
                physical jersey. Size values must match a size already configured below
                (e.g. "S", "M", "Y12") — add any missing sizes first. This only fills in
                the numbers for review; nothing is saved until you click "Upload Stock to
                Inventory".
              </p>
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFileUpload(file);
                }}
                disabled={submitting}
                className="text-xs"
              />
            </div>
          </div>
        </div>
      )}

      {/* Size management panel */}
      {!loadingSizes && selectedClubId && (
        <div className="mb-6 border border-gray-200 rounded-lg bg-white p-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">
                Size management for {selectedClubName || "selected club"}
              </h2>
              <p className="text-xs text-gray-500">
                Rename sizes to match Shopify labels (eg Youth 12 {"->"} Y12) or add new sizes for this club.
                Renames update inventory, allocations, and pending allocations for this club.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newSizeLabel}
                onChange={(e) => setNewSizeLabel(e.target.value)}
                placeholder="Add new size (eg YL)"
                className="border rounded px-3 py-2 text-sm w-[220px]"
                disabled={submitting}
              />
              <button
                type="button"
                onClick={addNewSize}
                disabled={submitting}
                className="px-3 py-2 rounded bg-brand-600 text-white text-sm font-semibold disabled:bg-gray-400"
              >
                Add size
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Loading or empty state */}
      {loadingSizes && <SkeletonTable rows={4} cols={4} />}

      {!loadingSizes && sizeRows.length === 0 && !error && (
        <EmptyState
          icon={Shirt}
          title="No size configuration found for this club"
          description="Add a size below to start uploading stock."
        />
      )}

      {/* Size grid + form */}
      {!loadingSizes && sizeRows.length > 0 && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold">
              Sizes for {selectedClubName || "selected club"}
            </h2>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={saveSizeOrder}
                disabled={submitting}
                className="text-xs px-3 py-1 border rounded text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Save size order
              </button>

              <button
                type="button"
                onClick={handleClear}
                disabled={submitting}
                className="text-xs px-3 py-1 border rounded text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Clear All Inputs
              </button>
            </div>
          </div>

          <div className="overflow-x-auto border rounded bg-white">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-3 py-2 text-left w-32">Size</th>
                  <th className="px-3 py-2 text-left w-36">Current Stock</th>
                  <th className="px-3 py-2 text-left w-40">Manage</th>
                  <th className="px-3 py-2 text-left w-28">Order</th>
                  <th className="px-3 py-2 text-left">
                    Add Jersey Numbers (comma-separated)
                  </th>
                  <th className="px-3 py-2 text-left w-28">Add Qty (auto)</th>
                </tr>
              </thead>
              <tbody>
                {sizeRows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-gray-100 odd:bg-white even:bg-gray-50"
                  >
                    {/* Size label + inline edit */}
                    <td className="px-3 py-2 align-top font-semibold">
                      {!row.isEditing && <span>{row.size_label}</span>}
                      {row.isEditing && (
                        <input
                          type="text"
                          value={row.draftLabel ?? ""}
                          onChange={(e) => setDraftLabel(row.id, e.target.value)}
                          className="w-full border rounded px-2 py-1 text-xs"
                          disabled={submitting}
                        />
                      )}
                    </td>

                    {/* Current stock */}
                    <td className="px-3 py-2 align-top text-xs">
                      {(() => {
                        const stock = stockMap.get(row.size_label);
                        if (!stock) {
                          return <span className="text-gray-400">—</span>;
                        }
                        return (
                          <div className="space-y-0.5">
                            <div>
                              <span className="font-semibold text-emerald-600">
                                {stock.available}
                              </span>
                              <span className="text-gray-500 ml-1">avail</span>
                            </div>
                            <div>
                              <span className="font-semibold text-amber-600">
                                {stock.allocated}
                              </span>
                              <span className="text-gray-500 ml-1">alloc</span>
                            </div>
                          </div>
                        );
                      })()}
                    </td>

                    {/* Manage buttons */}
                    <td className="px-3 py-2 align-top">
                      {!row.isEditing ? (
                        <button
                          type="button"
                          onClick={() => startEditSize(row.id)}
                          className="text-xs px-3 py-1 border rounded hover:bg-gray-50"
                          disabled={submitting}
                        >
                          Rename
                        </button>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => saveSizeLabel(row)}
                            className="text-xs px-3 py-1 rounded bg-emerald-600 text-white disabled:bg-gray-400"
                            disabled={submitting}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => cancelEditSize(row.id)}
                            className="text-xs px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-50"
                            disabled={submitting}
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </td>

                    {/* Order buttons */}
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="px-2 py-1 border rounded text-xs hover:bg-gray-50 disabled:opacity-50"
                          onClick={() => moveSizeRow(row.id, "up")}
                          disabled={submitting}
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="px-2 py-1 border rounded text-xs hover:bg-gray-50 disabled:opacity-50"
                          onClick={() => moveSizeRow(row.id, "down")}
                          disabled={submitting}
                          title="Move down"
                        >
                          ↓
                        </button>
                        <span className="text-[11px] text-gray-500">
                          {row.sort_order ?? "—"}
                        </span>
                      </div>
                    </td>

                    {/* Stock numbers input */}
                    <td className="px-3 py-2 align-top">
                      <input
                        type="text"
                        value={row.numbersInput}
                        onChange={(e) =>
                          handleNumbersChange(row.id, e.target.value)
                        }
                        placeholder="e.g. 4, 5, 6, 0"
                        className="w-full border rounded px-2 py-1 text-xs"
                        disabled={submitting}
                      />
                      <p className="text-[10px] text-gray-500 mt-1">
                        0 is allowed. Invalid entries will be ignored.
                      </p>
                    </td>

                    {/* Stock quantity — auto-calculated from jersey numbers */}
                    <td className="px-3 py-2 align-top">
                      {row.quantityInput ? (
                        <span className="inline-flex items-center justify-center w-full border border-gray-200 bg-gray-50 rounded px-2 py-1 text-xs font-semibold text-emerald-700">
                          {row.quantityInput}
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-center w-full border border-dashed border-gray-200 rounded px-2 py-1 text-xs text-gray-400">
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleShopifySync}
              disabled={syncing || submitting}
              className="px-4 py-2 bg-brand-600 text-white rounded text-sm font-semibold disabled:bg-gray-400 flex items-center gap-2"
            >
              {syncing ? (
                <>
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Syncing…
                </>
              ) : "Sync to Shopify"}
            </button>

            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-emerald-600 text-white rounded text-sm font-semibold disabled:bg-gray-400"
            >
              {submitting ? "Uploading…" : "Upload Stock to Inventory"}
            </button>
          </div>
        </form>
      )}

      {/* Shopify sync result panel -- one block per mapped Shopify product (a club may
          have multiple, e.g. mens + womens, each synced against its own stock pool). */}
      {syncResult && (
        <div className="mt-6 space-y-4">
          {(syncResult.products ?? []).map((product) => (
            <div
              key={product.productId}
              className="border border-brand-200 rounded-lg bg-brand-50 p-4"
            >
              <h3 className="text-sm font-semibold text-brand-800 mb-2">
                Shopify Sync — {syncResult.location} — product {product.productId}
                {product.gender ? ` (${product.gender})` : ""}
                {!product.success && (
                  <span className="ml-2 text-red-600 font-semibold">Failed</span>
                )}
              </h3>

              <table className="min-w-full text-xs">
                <thead>
                  <tr className="text-left">
                    <th className="pr-4 py-1 text-gray-600">Variant</th>
                    <th className="pr-4 py-1 text-gray-600">Qty Set</th>
                    <th className="pr-4 py-1 text-gray-600">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(product.results ?? []).map((r) => (
                    <tr key={r.variantTitle} className="border-t border-brand-100">
                      <td className="pr-4 py-1 font-medium">{r.variantTitle}</td>
                      <td className="pr-4 py-1">{r.available}</td>
                      <td className="pr-4 py-1">
                        {!r.ok ? (
                          <span className="text-red-600 font-semibold">Error</span>
                        ) : !r.matched ? (
                          <span className="text-amber-600">No size match</span>
                        ) : (
                          <span className="text-emerald-600">✓ OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {(product.warnings?.unmatchedSizes?.length ?? 0) > 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  ⚠ Sizes in admin with no Shopify variant:{" "}
                  {product.warnings!.unmatchedSizes!.join(", ")}
                </p>
              )}
              {(product.warnings?.unmatchedVariants?.length ?? 0) > 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  ⚠ Shopify variants with no matching admin size:{" "}
                  {product.warnings!.unmatchedVariants!.join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default BulkStockUpload;
