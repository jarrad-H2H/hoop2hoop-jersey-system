// FILE: src/pages/InventoryManager.tsx
import React, { useEffect, useState } from "react";
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
        .order("size")
        .order("jersey_number");

      setInventory((data ?? []) as InventoryRow[]);
      setLoading(false);
    };

    loadInventory();
  }, [selectedClubId]);

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
                <th className="px-3 py-2 text-left">Size</th>
                <th className="px-3 py-2 text-left">Number</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((row) => (
                <tr key={row.id} className="border-t odd:bg-white even:bg-gray-50">
                  <td className="px-3 py-2">{row.size}</td>
                  <td className="px-3 py-2">{row.jersey_number}</td>
                  <td className="px-3 py-2">{row.status}</td>
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
