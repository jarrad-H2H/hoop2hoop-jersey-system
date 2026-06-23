// FILE: src/pages/InventoryManager.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Link } from "react-router-dom";

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
  allocated_player_id: string | null;
  product_type: string | null;
}

interface InventoryBySizeRow {
  size: string;
  productType: string;
  availableNumbers: number[];
  allocatedNumbers: number[];
  availableQty: number;
  allocatedQty: number;
  totalQty: number;
}

const InventoryManager: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(false);

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

    loadClubs();
  }, []);

  // Load inventory for club
  useEffect(() => {
    if (!selectedClubId) {
      setInventory([]);
      return;
    }

    const loadInventory = async () => {
      setLoading(true);
      const { data } = await supabase
        .from("inventory")
        .select("*")
        .eq("club_id", selectedClubId)
        .neq("status", "Written Off")
        .order("size")
        .order("jersey_number");

      setInventory((data ?? []) as InventoryRow[]);
      setLoading(false);
    };

    loadInventory();
  }, [selectedClubId]);

  // Group into one row per (size, product_type), split by status -- a dual-product
  // club's mens/womens pools must never be combined under the same size.
  const groupedBySize: InventoryBySizeRow[] = useMemo(() => {
    const map = new Map<string, { size: string; productType: string; available: number[]; allocated: number[] }>();

    for (const row of inventory) {
      const size = String(row.size ?? "").trim();
      if (!size) continue;
      const productType = row.product_type || "default";

      const n = Number(row.jersey_number);
      if (!Number.isFinite(n)) continue;

      const key = `${size}::${productType}`;
      if (!map.has(key)) {
        map.set(key, { size, productType, available: [], allocated: [] });
      }
      const entry = map.get(key)!;
      if (row.status === "Available") {
        entry.available.push(n);
      } else {
        entry.allocated.push(n);
      }
    }

    const rows: InventoryBySizeRow[] = [];
    for (const { size, productType, available, allocated } of map.values()) {
      available.sort((a, b) => a - b);
      allocated.sort((a, b) => a - b);
      rows.push({
        size,
        productType,
        availableNumbers: available,
        allocatedNumbers: allocated,
        availableQty: available.length,
        allocatedQty: allocated.length,
        totalQty: available.length + allocated.length,
      });
    }

    rows.sort(
      (a, b) =>
        a.size.localeCompare(b.size, undefined, { numeric: true }) ||
        a.productType.localeCompare(b.productType)
    );

    return rows;
  }, [inventory]);

  const totalAvailable = groupedBySize.reduce((s, r) => s + r.availableQty, 0);
  const totalAllocated = groupedBySize.reduce((s, r) => s + r.allocatedQty, 0);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Inventory</h1>

      {/* Club selector */}
      <div className="mb-4">
        <label className="block text-sm font-semibold mb-1">Club</label>
        <select
          value={selectedClubId}
          onChange={(e) => setSelectedClubId(e.target.value)}
          className="border p-2 rounded"
        >
          {clubs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Bulk Upload Button */}
      {selectedClubId && (
        <div className="mb-6">
          <Link
            to={`/admin/inventory/bulk-upload/${selectedClubId}`}
            className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
          >
            Bulk Upload Stock for This Club
          </Link>
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
        </div>
      )}

      {/* Inventory Table */}
      {loading && <p>Loading inventory…</p>}

      {!loading && inventory.length === 0 && (
        <p className="text-gray-600">No inventory found for this club.</p>
      )}

      {!loading && inventory.length > 0 && (
        <div className="overflow-x-auto border rounded bg-white">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-2 text-left w-24">Size</th>
                <th className="px-3 py-2 text-left w-24">Product Type</th>
                <th className="px-3 py-2 text-left w-20 text-emerald-700">Available</th>
                <th className="px-3 py-2 text-left">Available numbers</th>
                <th className="px-3 py-2 text-left w-24 text-amber-700">Allocated</th>
                <th className="px-3 py-2 text-left w-20">Total</th>
              </tr>
            </thead>
            <tbody>
              {groupedBySize.map((row) => (
                <tr
                  key={`${row.size}::${row.productType}`}
                  className="border-t odd:bg-white even:bg-gray-50 align-top"
                >
                  <td className="px-3 py-2 font-semibold">{row.size}</td>
                  <td className="px-3 py-2 text-gray-600">{row.productType}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`font-semibold ${
                        row.availableQty === 0
                          ? "text-red-500"
                          : "text-emerald-600"
                      }`}
                    >
                      {row.availableQty}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-600 whitespace-normal break-words">
                    {row.availableQty === 0 ? (
                      <span className="text-gray-400 italic">none</span>
                    ) : (
                      row.availableNumbers.join(", ")
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`font-semibold ${
                        row.allocatedQty > 0 ? "text-amber-600" : "text-gray-400"
                      }`}
                    >
                      {row.allocatedQty}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-semibold text-gray-700">
                    {row.totalQty}
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

export default InventoryManager;
