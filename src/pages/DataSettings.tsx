// FILE: src/pages/DataSettings.tsx
import React, { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { AlertTriangle } from "lucide-react";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

const DataSettings: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  const [loadingClubs, setLoadingClubs] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Counts for sanity-check
  const [playerCount, setPlayerCount] = useState<number | null>(null);
  const [inventoryCount, setInventoryCount] = useState<number | null>(null);
  const [sizeCount, setSizeCount] = useState<number | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(false);

  // Confirmation text + busy flags
  const [confirmPlayers, setConfirmPlayers] = useState("");
  const [confirmInventory, setConfirmInventory] = useState("");
  const [confirmSizes, setConfirmSizes] = useState("");

  const [busyPlayers, setBusyPlayers] = useState(false);
  const [busyInventory, setBusyInventory] = useState(false);
  const [busySizes, setBusySizes] = useState(false);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);

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
          console.error("DataSettings loadClubs error", error);
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

  // Load counts whenever club changes
  useEffect(() => {
    const loadCounts = async () => {
      if (!selectedClubId) {
        setPlayerCount(null);
        setInventoryCount(null);
        setSizeCount(null);
        return;
      }

      setLoadingCounts(true);
      setError(null);

      try {
        // Players count
        const { count: pCount, error: pErr } = await supabase
          .from("players")
          .select("*", { count: "exact", head: true })
          .eq("club_id", selectedClubId);

        if (pErr) {
          console.error("DataSettings players count error", pErr);
        }
        setPlayerCount(pCount ?? 0);

        // Inventory count
        const { count: iCount, error: iErr } = await supabase
          .from("inventory")
          .select("*", { count: "exact", head: true })
          .eq("club_id", selectedClubId);

        if (iErr) {
          console.error("DataSettings inventory count error", iErr);
        }
        setInventoryCount(iCount ?? 0);

        // Size config count
        const { count: sCount, error: sErr } = await supabase
          .from("club_sizes")
          .select("*", { count: "exact", head: true })
          .eq("club_id", selectedClubId);

        if (sErr) {
          console.error("DataSettings size count error", sErr);
        }
        setSizeCount(sCount ?? 0);
      } finally {
        setLoadingCounts(false);
      }
    };

    void loadCounts();
  }, [selectedClubId]);

  const selectedClubName =
    clubs.find((c) => c.id === selectedClubId)?.name ?? "Selected club";

  const handleDeletePlayers = async () => {
    setStatusMessage(null);
    setError(null);

    if (!selectedClubId) {
      setError("Please select a club first.");
      return;
    }
    if (confirmPlayers !== "DELETE") {
      setError('To delete player data, type "DELETE" in the confirmation box.');
      return;
    }

    setBusyPlayers(true);
    try {
      const { error } = await supabase
        .from("players")
        .delete()
        .eq("club_id", selectedClubId);

      if (error) {
        console.error("Delete players error", error);
        setError("Failed to delete player data for this club.");
        return;
      }

      setStatusMessage(
        `All player records for ${selectedClubName} have been deleted.`
      );
      setConfirmPlayers("");
      // refresh counts
      setPlayerCount(0);
    } finally {
      setBusyPlayers(false);
    }
  };

  const handleDeleteInventory = async () => {
    setStatusMessage(null);
    setError(null);

    if (!selectedClubId) {
      setError("Please select a club first.");
      return;
    }
    if (confirmInventory !== "DELETE") {
      setError(
        'To delete inventory, type "DELETE" in the confirmation box for inventory.'
      );
      return;
    }

    setBusyInventory(true);
    try {
      const { error } = await supabase
        .from("inventory")
        .delete()
        .eq("club_id", selectedClubId);

      if (error) {
        console.error("Delete inventory error", error);
        setError("Failed to delete inventory for this club.");
        return;
      }

      setStatusMessage(
        `All inventory records for ${selectedClubName} have been deleted.`
      );
      setConfirmInventory("");
      setInventoryCount(0);
    } finally {
      setBusyInventory(false);
    }
  };

  const handleDeleteSizes = async () => {
    setStatusMessage(null);
    setError(null);

    if (!selectedClubId) {
      setError("Please select a club first.");
      return;
    }
    if (confirmSizes !== "DELETE") {
      setError(
        'To delete size labels, type "DELETE" in the confirmation box for size labels.'
      );
      return;
    }

    setBusySizes(true);
    try {
      const { error } = await supabase
        .from("club_sizes")
        .delete()
        .eq("club_id", selectedClubId);

      if (error) {
        console.error("Delete club_sizes error", error);
        setError("Failed to delete size configuration for this club.");
        return;
      }

      setStatusMessage(
        `All size labels for ${selectedClubName} have been deleted.`
      );
      setConfirmSizes("");
      setSizeCount(0);
    } finally {
      setBusySizes(false);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Data Settings</h1>
      <p className="text-sm text-gray-600 mb-4">
        Dangerous tools for cleaning up data per club. Use with care.
      </p>

      <div className="mb-6 flex items-start space-x-3 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <AlertTriangle className="text-yellow-600 mt-0.5" size={18} />
        <div className="text-xs text-yellow-800">
          <p className="font-semibold mb-1">Warning</p>
          <ul className="list-disc ml-4 space-y-1">
            <li>All deletions here are permanent.</li>
            <li>
              Player deletion will remove all player rows for the selected club.
            </li>
            <li>
              Inventory deletion will wipe all jersey stock records for the
              selected club.
            </li>
            <li>
              Size label deletion will remove the club&apos;s size configuration
              used by bulk stock upload.
            </li>
          </ul>
        </div>
      </div>

      {/* Club selector */}
      <div className="mb-6">
        <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
          Club
        </label>
        <select
          value={selectedClubId}
          onChange={(e) => setSelectedClubId(e.target.value)}
          className="border rounded px-3 py-2 min-w-[260px]"
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
        {loadingCounts && (
          <div className="mt-2 text-xs text-gray-500">
            Refreshing record counts…
          </div>
        )}
        {!loadingCounts && selectedClubId && (
          <div className="mt-2 text-xs text-gray-600 space-y-1">
            <div>
              <span className="font-semibold">Players:</span>{" "}
              {playerCount ?? 0}
            </div>
            <div>
              <span className="font-semibold">Inventory rows:</span>{" "}
              {inventoryCount ?? 0}
            </div>
            <div>
              <span className="font-semibold">Size labels:</span>{" "}
              {sizeCount ?? 0}
            </div>
          </div>
        )}
      </div>

      {/* Status / error */}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}
      {statusMessage && (
        <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-3">
          {statusMessage}
        </div>
      )}

      {/* Dangerous actions grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
        {/* Delete players */}
        <div className="border border-red-200 bg-red-50 rounded-lg p-4 flex flex-col space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-red-800 mb-1">
              Delete all player data for this club
            </h2>
            <p className="text-xs text-red-700">
              Removes every player row where <code>club_id</code> matches the
              selected club. This will also affect allocation logic for this
              club until new data is imported.
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-red-800 mb-1">
              Type DELETE to confirm
            </label>
            <input
              type="text"
              value={confirmPlayers}
              onChange={(e) => setConfirmPlayers(e.target.value)}
              className="w-full border rounded px-2 py-1 text-xs"
              placeholder="DELETE"
            />
          </div>
          <button
            type="button"
            onClick={handleDeletePlayers}
            disabled={busyPlayers || !selectedClubId}
            className="mt-auto w-full px-3 py-2 rounded bg-red-600 text-white text-xs font-semibold disabled:bg-gray-400"
          >
            {busyPlayers ? "Deleting players..." : "Delete player data"}
          </button>
        </div>

        {/* Delete inventory */}
        <div className="border border-orange-200 bg-orange-50 rounded-lg p-4 flex flex-col space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-orange-800 mb-1">
              Delete all inventory for this club
            </h2>
            <p className="text-xs text-orange-700">
              Wipes the jersey inventory rows for the selected club. Use if
              you&apos;re resetting stock from scratch.
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-orange-800 mb-1">
              Type DELETE to confirm
            </label>
            <input
              type="text"
              value={confirmInventory}
              onChange={(e) => setConfirmInventory(e.target.value)}
              className="w-full border rounded px-2 py-1 text-xs"
              placeholder="DELETE"
            />
          </div>
          <button
            type="button"
            onClick={handleDeleteInventory}
            disabled={busyInventory || !selectedClubId}
            className="mt-auto w-full px-3 py-2 rounded bg-orange-600 text-white text-xs font-semibold disabled:bg-gray-400"
          >
            {busyInventory ? "Deleting inventory..." : "Delete inventory"}
          </button>
        </div>

        {/* Delete size labels */}
        <div className="border border-slate-200 bg-slate-50 rounded-lg p-4 flex flex-col space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 mb-1">
              Delete size labels for this club
            </h2>
            <p className="text-xs text-slate-700">
              Removes the size configuration used by Bulk Stock Upload for this
              club. You&apos;ll need to re-seed sizes before uploading stock
              again.
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-900 mb-1">
              Type DELETE to confirm
            </label>
            <input
              type="text"
              value={confirmSizes}
              onChange={(e) => setConfirmSizes(e.target.value)}
              className="w-full border rounded px-2 py-1 text-xs"
              placeholder="DELETE"
            />
          </div>
          <button
            type="button"
            onClick={handleDeleteSizes}
            disabled={busySizes || !selectedClubId}
            className="mt-auto w-full px-3 py-2 rounded bg-slate-900 text-white text-xs font-semibold disabled:bg-gray-400"
          >
            {busySizes ? "Deleting sizes..." : "Delete size labels"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DataSettings;
