// FILE: src/pages/InventoryManager.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Link } from "react-router-dom";
import { Shirt, X } from "lucide-react";
import { SkeletonTable } from "../components/ui/Skeleton";
import EmptyState from "../components/ui/EmptyState";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface InventoryRow {
  id: string;
  size: string;
  jersey_number: number;
  status: string;
  product_type: string | null;
}

interface SyncProductResult {
  productId: string;
  gender: string;
  success: boolean;
  results: { variantTitle: string; available: number; matched: boolean; ok: boolean }[];
  warnings?: { unmatchedVariants?: string[]; unmatchedSizes?: string[] };
}

interface SyncResult {
  success: boolean;
  location: string;
  products: SyncProductResult[];
}

const InventoryManager: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [productTypeOptions, setProductTypeOptions] = useState<string[]>(["default"]);
  const [selectedProductType, setSelectedProductType] = useState<string>("default");
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string>("");

  // Shopify sync
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  // Inline edit state
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [addInput, setAddInput] = useState<string>("");
  const [editSubmitting, setEditSubmitting] = useState(false);

  // Load client clubs
  useEffect(() => {
    const loadClubs = async () => {
      const { data } = await supabase
        .from("clubs")
        .select("id, name, is_client")
        .eq("is_client", true)
        .order("name");

      const list = (data ?? []) as Club[];
      setClubs(list);
      if (list.length > 0) setSelectedClubId(list[0].id);
    };

    void loadClubs();
  }, []);

  // Load product types this club has mapped in Shopify
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
        new Set((data ?? []).map((r: { product_type: string | null }) => (r.product_type || "default").trim()))
      );
      const options = Array.from(new Set(["default", "mens", "womens", ...mapped]));
      setProductTypeOptions(options);
      setSelectedProductType((prev) => (options.includes(prev) ? prev : "default"));
    };
    void loadProductTypes();
  }, [selectedClubId]);

  // Load inventory for selected club + product type
  useEffect(() => {
    if (!selectedClubId) {
      setInventory([]);
      return;
    }

    const loadInventory = async () => {
      setLoading(true);
      setError(null);
      setEditingKey(null);
      setSyncResult(null);

      const { data, error: fetchError } = await supabase
        .from("inventory")
        .select("id, size, jersey_number, status, product_type")
        .eq("club_id", selectedClubId)
        .eq("product_type", selectedProductType)
        .neq("status", "Written Off")
        .order("size")
        .order("jersey_number");

      if (fetchError) {
        setError("Failed to load inventory.");
      } else {
        setInventory((data ?? []) as InventoryRow[]);
      }
      setLoading(false);
    };

    void loadInventory();
  }, [selectedClubId, selectedProductType]);

  // Group into one row per size, split by status
  const groupedBySize = useMemo(() => {
    const map = new Map<
      string,
      { size: string; available: InventoryRow[]; allocated: InventoryRow[] }
    >();

    for (const row of inventory) {
      const size = String(row.size ?? "").trim();
      if (!size) continue;
      if (!Number.isFinite(Number(row.jersey_number))) continue;

      if (!map.has(size)) {
        map.set(size, { size, available: [], allocated: [] });
      }
      const entry = map.get(size)!;
      if (row.status === "Available") {
        entry.available.push(row);
      } else {
        entry.allocated.push(row);
      }
    }

    const rows = Array.from(map.values()).map(({ size, available, allocated }) => {
      available.sort((a, b) => a.jersey_number - b.jersey_number);
      allocated.sort((a, b) => a.jersey_number - b.jersey_number);
      return { size, available, allocated };
    });

    rows.sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }));
    return rows;
  }, [inventory]);

  const totalAvailable = groupedBySize.reduce((s, r) => s + r.available.length, 0);
  const totalAllocated = groupedBySize.reduce((s, r) => s + r.allocated.length, 0);

  const handleClubChange = (clubId: string) => {
    setSelectedClubId(clubId);
    setEditingKey(null);
    setError(null);
    setSuccessMessage("");
    setSyncResult(null);
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

      setSyncResult(data as SyncResult);
      setSuccessMessage(
        data.success
          ? `Synced inventory to Shopify (${data.location}).`
          : "Sync completed with some errors — see details below."
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unexpected error during Shopify sync.";
      setError(msg);
    } finally {
      setSyncing(false);
    }
  };

  // ----------------------------
  // Inline edit: remove a single Available jersey
  // ----------------------------
  const handleRemoveJersey = async (row: InventoryRow) => {
    if (
      !window.confirm(
        `Remove jersey #${row.jersey_number} (${row.size}) from Available stock? This cannot be undone.`
      )
    )
      return;

    setEditSubmitting(true);
    setError(null);
    try {
      const { error: delErr } = await supabase
        .from("inventory")
        .delete()
        .eq("id", row.id);

      if (delErr) {
        setError("Failed to remove jersey: " + delErr.message);
        return;
      }

      setInventory((prev) => prev.filter((r) => r.id !== row.id));
      setSuccessMessage(`Removed jersey #${row.jersey_number} (${row.size}).`);
    } finally {
      setEditSubmitting(false);
    }
  };

  // ----------------------------
  // Inline edit: add jersey numbers to a size
  // ----------------------------
  const handleAddJerseys = async (size: string) => {
    if (!selectedClubId) return;

    const numberStrings = addInput
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n !== "" && !isNaN(Number(n)));

    if (numberStrings.length === 0) {
      setError("Please enter at least one valid jersey number.");
      return;
    }

    setEditSubmitting(true);
    setError(null);
    try {
      const rows = numberStrings.map((n) => ({
        jersey_number: Number(n),
        size,
        status: "Available",
        condition: "New",
        club_id: selectedClubId,
        product_type: selectedProductType,
      }));

      const { data: inserted, error: insertErr } = await supabase
        .from("inventory")
        .insert(rows)
        .select("id, size, jersey_number, status, product_type");

      if (insertErr) {
        setError("Failed to add jerseys: " + insertErr.message);
        return;
      }

      setInventory((prev) => [...prev, ...((inserted ?? []) as InventoryRow[])]);
      setAddInput("");
      setSuccessMessage(`Added ${rows.length} jersey(s) to size ${size}.`);
    } finally {
      setEditSubmitting(false);
    }
  };

  const productTypeLabel = (pt: string) =>
    pt === "default" ? "Default / Unisex" : pt === "mens" ? "Mens" : pt === "womens" ? "Womens" : pt;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <h1 className="text-2xl font-bold">Inventory</h1>
        {selectedClubId && (
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleShopifySync}
              disabled={syncing}
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
            <Link
              to={`/admin/inventory/bulk-upload/${selectedClubId}`}
              className="px-4 py-2 border border-brand-600 text-brand-700 rounded text-sm font-semibold hover:bg-brand-50"
            >
              Bulk Upload Stock
            </Link>
          </div>
        )}
      </div>

      {/* Club selector */}
      <div className="flex flex-wrap gap-4 mb-4">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Club
          </label>
          <select
            value={selectedClubId}
            onChange={(e) => handleClubChange(e.target.value)}
            className="border rounded px-3 py-2 min-w-[220px]"
          >
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {selectedClubId && (
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Product Type
            </label>
            <select
              value={selectedProductType}
              onChange={(e) => {
                setSelectedProductType(e.target.value);
                setEditingKey(null);
              }}
              className="border rounded px-3 py-2 min-w-[180px]"
            >
              {productTypeOptions.map((pt) => (
                <option key={pt} value={pt}>
                  {productTypeLabel(pt)}
                </option>
              ))}
            </select>
          </div>
        )}
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

      {/* Summary totals */}
      {!loading && groupedBySize.length > 0 && (
        <div className="flex gap-4 mb-4">
          <div className="bg-emerald-50 border border-emerald-200 rounded px-4 py-2 text-sm">
            <span className="font-semibold text-emerald-700">{totalAvailable}</span>
            <span className="text-emerald-600 ml-1">available</span>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded px-4 py-2 text-sm">
            <span className="font-semibold text-amber-700">{totalAllocated}</span>
            <span className="text-amber-600 ml-1">allocated</span>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded px-4 py-2 text-sm">
            <span className="font-semibold text-gray-700">{totalAvailable + totalAllocated}</span>
            <span className="text-gray-600 ml-1">total</span>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded px-4 py-2 text-sm text-gray-500">
            {productTypeLabel(selectedProductType)}
          </div>
        </div>
      )}

      {/* Inventory Table */}
      {loading && <SkeletonTable rows={6} cols={5} />}

      {!loading && inventory.length === 0 && !error && (
        <EmptyState
          icon={Shirt}
          title="No inventory found for this club"
          description="Use Bulk Upload Stock to add jersey numbers and sizes, or select a different product type."
        />
      )}

      {!loading && groupedBySize.length > 0 && (
        <div className="overflow-x-auto border rounded bg-white">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-2 text-left w-20">Size</th>
                <th className="px-3 py-2 text-left w-16 text-emerald-700">Avail</th>
                <th className="px-3 py-2 text-left">Available numbers</th>
                <th className="px-3 py-2 text-left w-20 text-amber-700">Alloc</th>
                <th className="px-3 py-2 text-left">Allocated numbers</th>
                <th className="px-3 py-2 text-left w-16">Total</th>
                <th className="px-3 py-2 text-left w-24">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groupedBySize.map((row) => {
                const isEditing = editingKey === row.size;
                return (
                  <tr
                    key={row.size}
                    className={`border-t align-top ${isEditing ? "bg-brand-50" : "odd:bg-white even:bg-gray-50"}`}
                  >
                    <td className="px-3 py-2 font-semibold whitespace-nowrap">{row.size}</td>

                    <td className="px-3 py-2">
                      <span className={`font-semibold ${row.available.length === 0 ? "text-red-500" : "text-emerald-600"}`}>
                        {row.available.length}
                      </span>
                    </td>

                    {/* Available numbers — chips in edit mode, plain text otherwise */}
                    <td className="px-3 py-2 text-gray-600 max-w-xs">
                      {isEditing ? (
                        <div>
                          <div className="flex flex-wrap gap-1 mb-2">
                            {row.available.length === 0 && (
                              <span className="text-gray-400 italic text-xs">no available stock</span>
                            )}
                            {row.available.map((invRow) => (
                              <span
                                key={invRow.id}
                                className="inline-flex items-center gap-0.5 bg-emerald-100 border border-emerald-300 rounded px-1.5 py-0.5 text-[11px] font-semibold text-emerald-800"
                              >
                                #{invRow.jersey_number}
                                <button
                                  type="button"
                                  onClick={() => void handleRemoveJersey(invRow)}
                                  disabled={editSubmitting}
                                  title="Remove this jersey from stock"
                                  className="ml-0.5 text-emerald-500 hover:text-red-500 disabled:opacity-40"
                                >
                                  <X size={10} />
                                </button>
                              </span>
                            ))}
                          </div>
                          <div className="flex gap-1 items-center">
                            <input
                              type="text"
                              value={addInput}
                              onChange={(e) => setAddInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void handleAddJerseys(row.size);
                                }
                              }}
                              placeholder="Add numbers: 4, 5, 6"
                              className="border rounded px-2 py-1 text-xs w-40"
                              disabled={editSubmitting}
                            />
                            <button
                              type="button"
                              onClick={() => void handleAddJerseys(row.size)}
                              disabled={editSubmitting || !addInput.trim()}
                              className="px-2 py-1 bg-emerald-600 text-white rounded text-xs font-semibold disabled:bg-gray-300"
                            >
                              Add
                            </button>
                          </div>
                        </div>
                      ) : row.available.length === 0 ? (
                        <span className="text-gray-400 italic">none</span>
                      ) : (
                        <span className="whitespace-normal break-words">
                          {row.available.map((r) => r.jersey_number).join(", ")}
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2">
                      <span className={`font-semibold ${row.allocated.length > 0 ? "text-amber-600" : "text-gray-400"}`}>
                        {row.allocated.length}
                      </span>
                    </td>

                    <td className="px-3 py-2 text-gray-500 max-w-xs whitespace-normal break-words">
                      {row.allocated.length === 0 ? (
                        <span className="text-gray-400 italic">none</span>
                      ) : (
                        row.allocated.map((r) => r.jersey_number).join(", ")
                      )}
                    </td>

                    <td className="px-3 py-2 font-semibold text-gray-700">
                      {row.available.length + row.allocated.length}
                    </td>

                    <td className="px-3 py-2">
                      {isEditing ? (
                        <button
                          type="button"
                          onClick={() => { setEditingKey(null); setAddInput(""); setSuccessMessage(""); }}
                          className="text-xs px-3 py-1 border rounded hover:bg-gray-50"
                        >
                          Done
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => { setEditingKey(row.size); setAddInput(""); setError(null); setSuccessMessage(""); }}
                          className="text-xs px-3 py-1 border rounded hover:bg-gray-50"
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Shopify sync result */}
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
                          <span className="text-emerald-600">OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(product.warnings?.unmatchedSizes?.length ?? 0) > 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  Sizes in admin with no Shopify variant: {product.warnings!.unmatchedSizes!.join(", ")}
                </p>
              )}
              {(product.warnings?.unmatchedVariants?.length ?? 0) > 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  Shopify variants with no matching admin size: {product.warnings!.unmatchedVariants!.join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default InventoryManager;
