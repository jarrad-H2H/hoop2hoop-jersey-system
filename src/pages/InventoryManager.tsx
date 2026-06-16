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
}

interface InventoryBySizeRow {
  size: string;
  numbers: number[]; // duplicates preserved
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

  // Group into one row per size
  const groupedBySize: InventoryBySizeRow[] = useMemo(() => {
    const map = new Map<string, number[]>();

    for (const row of inventory) {
      const size = String(row.size ?? "").trim();
      if (!size) continue;

      const n = Number(row.jersey_number);
      if (!Number.isFinite(n)) continue; // allow 0

      const existing = map.get(size);
      if (!existing) {
        map.set(size, [n]);
      } else {
        existing.push(n);
      }
    }

    const rows: InventoryBySizeRow[] = [];
    for (const [size, numbers] of map.entries()) {
      numbers.sort((a, b) => a - b);
      rows.push({
        size,
        numbers,
        totalQty: numbers.length,
      });
    }

    // Keep size ordering stable (matches previous .order("size"))
    rows.sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }));

    return rows;
  }, [inventory]);

  const renderNumbersCell = (nums: number[]) => {
    // duplicates preserved e.g. "2, 2, 2, 4, 4"
    const text = nums.join(", ");
    return <span className="whitespace-normal break-words">{text}</span>;
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Inventory Manager</h1>

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
                <th className="px-3 py-2 text-left w-28">Size</th>
                <th className="px-3 py-2 text-left">Playing numbers in stock</th>
                <th className="px-3 py-2 text-left w-28">Total qty</th>
              </tr>
            </thead>
            <tbody>
              {groupedBySize.map((row) => (
                <tr key={row.size} className="border-t odd:bg-white even:bg-gray-50 align-top">
                  <td className="px-3 py-2 font-semibold">{row.size}</td>
                  <td className="px-3 py-2">{renderNumbersCell(row.numbers)}</td>
                  <td className="px-3 py-2">{row.totalQty}</td>
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
