// FILE: src/pages/ClubOverview.tsx
import React, { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface Player {
  id: string;
  first_name: string;
  last_name: string;
  team_id: string | null;
  final_shirt: number | null;
  year_of_birth: number | null;
}

interface InventoryRow {
  id: string;
  club_id: string | null;
  club_name?: string | null;
  jersey_number: number;
  size: string;
  status: "Available" | "Allocated" | string;
}

interface ClubSummary {
  totalPlayers: number;
  playersWithNumber: number;
  playersMissingNumber: number;
  playersMissingYOB: number;
  fullyCompletePlayers: number;
  inventoryTotal: number;
  inventoryAvailable: number;
  inventoryAllocated: number;
  stockBySize: {
    size: string;
    available: number;
    allocated: number;
    total: number;
  }[];
  sampleMissingNumber: Player[];
  sampleMissingYOB: Player[];
}

const ClubOverview: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [loadingClubs, setLoadingClubs] = useState(false);

  const [loadingSummary, setLoadingSummary] = useState(false);
  const [summary, setSummary] = useState<ClubSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          console.error("loadClubs error", error);
          setError("Failed to load clubs.");
          return;
        }

        const list = (data ?? []) as Club[];
        setClubs(list);

        if (list.length > 0) {
          setSelectedClubId(list[0].id);
          void loadSummary(list[0].id);
        }
      } finally {
        setLoadingClubs(false);
      }
    };

    loadClubs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSummary = async (clubId: string) => {
    if (!clubId) return;

    setLoadingSummary(true);
    setError(null);
    setSummary(null);

    try {
      // Load players for this club
      const { data: playersData, error: playersError } = await supabase
        .from("players")
        .select(
          "id, first_name, last_name, team_id, final_shirt, year_of_birth"
        )
        .eq("club_id", clubId);

      if (playersError) {
        console.error("loadSummary players error", playersError);
        setError("Failed to load players for this club.");
        setLoadingSummary(false);
        return;
      }

      const players = (playersData ?? []) as Player[];

      // Load inventory via the view so we see club_name as well
      const { data: invData, error: invError } = await supabase
        .from("inventory_with_club")
        .select("id, club_id, club_name, jersey_number, size, status")
        .eq("club_id", clubId);

      if (invError) {
        console.error("loadSummary inventory error", invError);
        setError("Failed to load inventory for this club.");
        setLoadingSummary(false);
        return;
      }

      const inventory = (invData ?? []) as InventoryRow[];

      // --- Players stats ---
      const totalPlayers = players.length;
      const playersWithNumber = players.filter(
        (p) => p.final_shirt !== null
      ).length;
      const playersMissingNumber = players.filter(
        (p) => p.final_shirt === null
      ).length;
      const playersMissingYOB = players.filter(
        (p) => p.year_of_birth === null
      ).length;
      const fullyCompletePlayers = players.filter(
        (p) => p.final_shirt !== null && p.year_of_birth !== null
      ).length;

      const sampleMissingNumber = players
        .filter((p) => p.final_shirt === null)
        .slice(0, 10);
      const sampleMissingYOB = players
        .filter((p) => p.year_of_birth === null)
        .slice(0, 10);

      // --- Inventory stats ---
      const inventoryTotal = inventory.length;
      const inventoryAvailable = inventory.filter(
        (row) => row.status === "Available"
      ).length;
      const inventoryAllocated = inventory.filter(
        (row) => row.status === "Allocated"
      ).length;

      // Group stock by size
      const stockMap = new Map<string, { available: number; allocated: number }>();

      inventory.forEach((row) => {
        const key = row.size || "Unknown";
        if (!stockMap.has(key)) {
          stockMap.set(key, { available: 0, allocated: 0 });
        }
        const bucket = stockMap.get(key)!;
        if (row.status === "Available") {
          bucket.available += 1;
        } else if (row.status === "Allocated") {
          bucket.allocated += 1;
        }
      });

      const stockBySize = Array.from(stockMap.entries())
        .map(([size, bucket]) => ({
          size,
          available: bucket.available,
          allocated: bucket.allocated,
          total: bucket.available + bucket.allocated,
        }))
        .sort((a, b) => a.size.localeCompare(b.size));

      const nextSummary: ClubSummary = {
        totalPlayers,
        playersWithNumber,
        playersMissingNumber,
        playersMissingYOB,
        fullyCompletePlayers,
        inventoryTotal,
        inventoryAvailable,
        inventoryAllocated,
        stockBySize,
        sampleMissingNumber,
        sampleMissingYOB,
      };

      setSummary(nextSummary);
    } catch (err: any) {
      console.error("loadSummary error", err);
      setError(err.message ?? "Failed to load club overview.");
    } finally {
      setLoadingSummary(false);
    }
  };

  const selectedClub = clubs.find((c) => c.id === selectedClubId);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Club Overview</h1>
      <p className="text-sm text-gray-600 mb-6">
        High-level snapshot per club: player readiness, missing data, and live
        inventory summary. Use this to spot problems early and plan stock.
      </p>

      {/* Club picker */}
      <div className="mb-6 flex flex-col md:flex-row md:items-center md:space-x-4 space-y-3 md:space-y-0">
        <div>
          <label className="block text-sm font-semibold mb-1">Club</label>
          <select
            value={selectedClubId}
            onChange={(e) => {
              const clubId = e.target.value;
              setSelectedClubId(clubId);
              setSummary(null);
              if (clubId) {
                void loadSummary(clubId);
              }
            }}
            className="border rounded px-3 py-2 min-w-[220px]"
            disabled={loadingClubs}
          >
            {loadingClubs && <option>Loading clubs…</option>}
            {!loadingClubs && clubs.length === 0 && (
              <option>No client clubs found</option>
            )}
            {!loadingClubs &&
              clubs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </div>
        {selectedClub && (
          <div className="text-sm text-gray-500">
            Showing data for{" "}
            <span className="font-semibold">{selectedClub.name}</span>.
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}

      {/* Loading */}
      {loadingSummary && (
        <div className="mb-4 text-sm text-gray-600">
          Loading club overview…
        </div>
      )}

      {/* Summary cards */}
      {summary && !loadingSummary && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Players
              </div>
              <div className="mt-2 text-2xl font-bold">
                {summary.totalPlayers}
              </div>
              <div className="mt-1 text-xs text-gray-600">
                {summary.playersWithNumber} with numbers •{" "}
                {summary.playersMissingNumber} missing
              </div>
            </div>

            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Data Completeness
              </div>
              <div className="mt-2 text-2xl font-bold">
                {summary.fullyCompletePlayers}
              </div>
              <div className="mt-1 text-xs text-gray-600">
                {summary.playersMissingYOB} players missing year of birth
              </div>
            </div>

            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Inventory Rows
              </div>
              <div className="mt-2 text-2xl font-bold">
                {summary.inventoryTotal}
              </div>
              <div className="mt-1 text-xs text-gray-600">
                {summary.inventoryAvailable} available •{" "}
                {summary.inventoryAllocated} allocated
              </div>
            </div>

            <div className="bg-white rounded-lg shadow p-4">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Sizes in Use
              </div>
              <div className="mt-2 text-2xl font-bold">
                {summary.stockBySize.length}
              </div>
              <div className="mt-1 text-xs text-gray-600">
                Unique sizes with inventory rows for this club
              </div>
            </div>
          </div>

          {/* Stock by size */}
          <div className="mb-8 bg-white rounded-lg shadow p-4">
            <h2 className="text-sm font-semibold mb-3">Inventory by Size</h2>
            {summary.stockBySize.length === 0 ? (
              <p className="text-xs text-gray-500">
                No inventory rows found for this club yet.
              </p>
            ) : (
              <div className="overflow-x-auto max-w-2xl">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-2 py-1 text-left">Size</th>
                      <th className="px-2 py-1 text-left">Available</th>
                      <th className="px-2 py-1 text-left">Allocated</th>
                      <th className="px-2 py-1 text-left">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.stockBySize.map((row) => (
                      <tr
                        key={row.size}
                        className="odd:bg-white even:bg-gray-50"
                      >
                        <td className="px-2 py-1">{row.size}</td>
                        <td className="px-2 py-1">{row.available}</td>
                        <td className="px-2 py-1">{row.allocated}</td>
                        <td className="px-2 py-1">{row.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Data quality panels */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-sm font-semibold mb-3">
                Players Missing Jersey Number
              </h2>
              {summary.sampleMissingNumber.length === 0 ? (
                <p className="text-xs text-gray-500">
                  All players currently have a number assigned.
                </p>
              ) : (
                <ul className="text-xs text-gray-700 space-y-1">
                  {summary.sampleMissingNumber.map((p) => (
                    <li key={p.id}>
                      <span className="font-semibold">
                        {p.last_name}, {p.first_name}
                      </span>{" "}
                      {p.team_id && (
                        <span className="text-gray-500">
                          &mdash; {p.team_id}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-sm font-semibold mb-3">
                Players Missing Year of Birth
              </h2>
              {summary.sampleMissingYOB.length === 0 ? (
                <p className="text-xs text-gray-500">
                  All players have year of birth recorded.
                </p>
              ) : (
                <ul className="text-xs text-gray-700 space-y-1">
                  {summary.sampleMissingYOB.map((p) => (
                    <li key={p.id}>
                      <span className="font-semibold">
                        {p.last_name}, {p.first_name}
                      </span>{" "}
                      {p.team_id && (
                        <span className="text-gray-500">
                          &mdash; {p.team_id}
                        </span>
                      )}
                      {p.final_shirt !== null && (
                        <span className="ml-2 text-gray-500">
                          (#{p.final_shirt})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ClubOverview;
