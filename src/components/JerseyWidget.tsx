// FILE: src/components/JerseyWidget.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  smartCheckNumber,
  StockBySize,
  NumberSuggestion,
  reserveNumberForPurchase,
  suggestNumbersForClubRanked,
  cancelReservation,
  finalizeReservationForOrder,
} from "../services/allocation";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface TeamOption {
  value: string; // team_id
  label: string; // team_label or team_id
  count: number; // how many players in that cohort currently mapped to this team
}

const SEASON_YEAR = 2025;

const formatMsAsMMSS = (ms: number) => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const JerseyWidget: React.FC = () => {
  // Demo-only controls
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [sizes, setSizes] = useState<string[]>([]);
  const [selectedSize, setSelectedSize] = useState<string>("");

  // Widget inputs
  const [yearOfBirth, setYearOfBirth] = useState<string>("");
  const [selectedTeamId, setSelectedTeamId] = useState<string>(""); // optional
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);

  const [preferredNumber, setPreferredNumber] = useState<string>("");

  // Results / status
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [stockBySize, setStockBySize] = useState<StockBySize[]>([]);
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [reserving, setReserving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  const [reservationResult, setReservationResult] = useState<{
    pendingAllocationId?: string;
    inventoryId?: string;
    expiresAtIso?: string;
    reservedNumber?: number;
    reservedSize?: string;
  }>({});

  const clubName = useMemo(
    () => clubs.find((c) => c.id === selectedClubId)?.name ?? "Selected club",
    [clubs, selectedClubId]
  );

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = useMemo(
    () => Number.isFinite(yobNum) && yobNum >= 1900,
    [yobNum]
  );

  const isReserved = useMemo(
    () => Boolean(reservationResult.pendingAllocationId),
    [reservationResult.pendingAllocationId]
  );

  const remainingMs = useMemo(() => {
    if (!reservationResult.expiresAtIso) return 0;
    const t = Date.parse(reservationResult.expiresAtIso);
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, t - Date.now());
  }, [reservationResult.expiresAtIso]);

  // Tick countdown (UI only)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isReserved) return;
    const id = window.setInterval(() => setTick((x) => x + 1), 250);
    return () => window.clearInterval(id);
  }, [isReserved]);

  const resetOutputs = () => {
    setStatusMessage("");
    setStockBySize([]);
    setSuggestions([]);
    // IMPORTANT: do not clear reservationResult here - we want the lock to persist
  };

  const clearAll = () => {
    setStatusMessage("");
    setStockBySize([]);
    setSuggestions([]);
    setReservationResult({});
    setPreferredNumber("");
    setSelectedTeamId("");
  };

  // Load demo clubs (is_client = true)
  useEffect(() => {
    const loadClubs = async () => {
      setError(null);

      const { data, error } = await supabase
        .from("clubs")
        .select("id, name, is_client")
        .eq("is_client", true)
        .order("name", { ascending: true });

      if (error) {
        console.error("JerseyWidget loadClubs error", error);
        setError("Failed to load clubs for demo.");
        return;
      }

      const list = (data ?? []) as Club[];
      setClubs(list);

      if (list.length > 0) {
        setSelectedClubId(list[0].id);
      }
    };

    void loadClubs();
  }, []);

  // Load available sizes for the selected club (from inventory)
  useEffect(() => {
    const loadSizes = async () => {
      if (!selectedClubId) {
        setSizes([]);
        setSelectedSize("");
        return;
      }

      setError(null);

      const { data, error } = await supabase
        .from("inventory")
        .select("size")
        .eq("club_id", selectedClubId)
        .eq("status", "Available");

      if (error) {
        console.error("JerseyWidget loadSizes error", error);
        setError("Failed to load sizes for this club.");
        return;
      }

      const unique = Array.from(
        new Set((data ?? []).map((row: any) => String(row.size ?? "")))
      ).filter((s) => s.length > 0);

      unique.sort();
      setSizes(unique);
      setSelectedSize(unique[0] ?? "");
    };

    void loadSizes();
  }, [selectedClubId]);

  // Load teams likely matching this YOB (same cohort) for this club
  useEffect(() => {
    const loadTeams = async () => {
      setTeams([]);
      setSelectedTeamId("");
      if (!selectedClubId) return;
      if (!yobValid) return;

      setTeamsLoading(true);
      setError(null);

      try {
        const targetAge = SEASON_YEAR - yobNum;
        const minYob = SEASON_YEAR - targetAge; // exact cohort only
        const maxYob = SEASON_YEAR - targetAge;

        const { data, error } = await supabase
          .from("players")
          .select("team_id, team_label, year_of_birth")
          .eq("club_id", selectedClubId)
          .gte("year_of_birth", minYob)
          .lte("year_of_birth", maxYob);

        if (error) {
          console.error("loadTeams error", error);
          setError("Failed to load teams for this club.");
          return;
        }

        const counts = new Map<string, TeamOption>();
        for (const row of data ?? []) {
          const teamId = String((row as any).team_id ?? "").trim();
          if (!teamId) continue;

          const labelRaw = String((row as any).team_label ?? "").trim();
          const label = labelRaw || teamId;

          const existing = counts.get(teamId);
          if (!existing) counts.set(teamId, { value: teamId, label, count: 1 });
          else existing.count += 1;
        }

        const list = Array.from(counts.values()).sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          return a.label.localeCompare(b.label);
        });

        setTeams(list);
      } finally {
        setTeamsLoading(false);
      }
    };

    void loadTeams();
  }, [selectedClubId, yobValid, yobNum]);

  const validateCore = (): { yob: number; num: number } | null => {
    if (!selectedClubId) {
      setError("Please choose a club.");
      return null;
    }
    if (!selectedSize) {
      setError("Please choose a size.");
      return null;
    }
    if (!yobValid) {
      setError("Please enter a valid year of birth.");
      return null;
    }
    if (preferredNumber.trim().length === 0) {
      setError("Please enter a preferred number.");
      return null;
    }

    const num = Number(preferredNumber);
    if (!Number.isFinite(num) || num < 0) {
      setError("Preferred number must be 0 or a positive number.");
      return null;
    }

    return { yob: yobNum, num };
  };

  const runRankedSuggestions = async () => {
    if (!selectedClubId) return;
    if (!selectedSize) return;
    if (!yobValid) return;

    const ranked = await suggestNumbersForClubRanked({
      clubId: selectedClubId,
      size: selectedSize,
      seasonYear: SEASON_YEAR,
      yearOfBirth: yobNum,
      limit: 10,
      cohortWindowYears: 0,
      adjacentCohortYears: 1,
    });

    setSuggestions(ranked);

    if (ranked.length === 0) {
      setStatusMessage(
        `No available clash-free numbers found for size ${selectedSize} in this age group.`
      );
    } else {
      setStatusMessage(
        `Recommended numbers for size ${selectedSize} (ranked by availability and future clash risk).`
      );
    }
  };

  const handleCheckNumber = async () => {
    setError(null);
    resetOutputs();

    const validated = validateCore();
    if (!validated) return;

    const { yob, num } = validated;

    setChecking(true);
    try {
      const result = await smartCheckNumber(selectedClubId, num, {
        seasonYear: SEASON_YEAR,
        yearOfBirth: yob,
        cohortWindowYears: 0,
      });

      setStockBySize(result.stockBySize);

      // HARD BLOCK LOGIC
      if (result.clashes.length > 0) {
        setStatusMessage(
          "This number is not available for this age group. Please choose one of the suggested numbers."
        );
        setSuggesting(true);
        try {
          await runRankedSuggestions();
        } finally {
          setSuggesting(false);
        }
        return;
      }

      // Require stock in selected size
      const hasStockInSelectedSize =
        result.stockBySize.find((s) => s.size === selectedSize)?.count ?? 0;

      if (hasStockInSelectedSize <= 0) {
        setStatusMessage(
          "This number has no available stock in the selected size. Please choose one of the suggested numbers."
        );
        setSuggesting(true);
        try {
          await runRankedSuggestions();
        } finally {
          setSuggesting(false);
        }
        return;
      }

      setStatusMessage("This number is available in your size for your age group.");
    } catch (err: any) {
      console.error("JerseyWidget handleCheckNumber error", err);
      setError(err.message ?? "Failed to check this number.");
    } finally {
      setChecking(false);
    }
  };

  const handleSuggestNumbers = async () => {
    setError(null);
    resetOutputs();

    if (!selectedClubId) {
      setError("Please choose a club.");
      return;
    }
    if (!selectedSize) {
      setError("Please choose a size.");
      return;
    }
    if (!yobValid) {
      setError("Please enter year of birth first (suggestions are age-group aware).");
      return;
    }

    setSuggesting(true);
    try {
      await runRankedSuggestions();
    } catch (err: any) {
      console.error("JerseyWidget handleSuggestNumbers error", err);
      setError(err.message ?? "Failed to suggest numbers.");
    } finally {
      setSuggesting(false);
    }
  };

  const handleReserve = async () => {
    setError(null);
    setStatusMessage("");
    setStockBySize([]);
    setSuggestions([]);

    if (isReserved) {
      setError("A number is already reserved. Please add to cart or change number.");
      return;
    }

    const validated = validateCore();
    if (!validated) return;

    const { yob, num } = validated;

    setReserving(true);
    try {
      // Safety: hard-block check right before reserving
      const check = await smartCheckNumber(selectedClubId, num, {
        seasonYear: SEASON_YEAR,
        yearOfBirth: yob,
        cohortWindowYears: 0,
      });

      if (check.clashes.length > 0) {
        setError(
          "That number is not available for this age group. Please pick a suggested number."
        );
        await runRankedSuggestions();
        return;
      }

      const hasStockInSelectedSize =
        check.stockBySize.find((s) => s.size === selectedSize)?.count ?? 0;

      if (hasStockInSelectedSize <= 0) {
        setError(
          "That number has no available stock in this size. Please pick a suggested number."
        );
        await runRankedSuggestions();
        return;
      }

      const result = await reserveNumberForPurchase({
        clubId: selectedClubId,
        jerseyNumber: num,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yob,
        teamId: selectedTeamId ? selectedTeamId : null,
        expiresMinutes: 15,
      });

      if (!result.success) {
        setError(result.message);
        return;
      }

      setReservationResult({
        pendingAllocationId: result.pendingAllocationId,
        inventoryId: result.inventoryId,
        expiresAtIso: result.expiresAtIso,
        reservedNumber: num,
        reservedSize: selectedSize,
      });

      setStatusMessage(
        `Reserved jersey #${num} (${selectedSize}). Hold created for 15 minutes.`
      );
    } catch (err: any) {
      console.error("JerseyWidget handleReserve error", err);
      setError(err.message ?? "Failed to reserve this number.");
    } finally {
      setReserving(false);
    }
  };

  const handleCancelReservation = async () => {
    setError(null);
    setStatusMessage("");

    if (!reservationResult.pendingAllocationId) {
      setError("No active reservation to cancel.");
      return;
    }

    const pendingId = reservationResult.pendingAllocationId;

    setReserving(true);
    try {
      const result = await cancelReservation({ pendingAllocationId: pendingId });

      if (!result.success) {
        setError(result.message ?? "Failed to cancel reservation.");
        return;
      }

      setReservationResult({});
      setStatusMessage("Reservation cancelled. You can choose another number.");
    } catch (err: any) {
      console.error("handleCancelReservation error", err);
      setError(err.message ?? "Failed to cancel reservation.");
    } finally {
      setReserving(false);
    }
  };

  const handleSimulateAddToCart = async () => {
    setError(null);
    setStatusMessage("");

    if (!reservationResult.pendingAllocationId) {
      setError("No active reservation. Please reserve a number first.");
      return;
    }

    setFinalizing(true);
    try {
      const orderRef = `demo-${Date.now()}`;
      const result = await finalizeReservationForOrder({
        pendingAllocationId: reservationResult.pendingAllocationId,
        orderRef,
      });

      if (!result.success) {
        setError(result.message ?? "Failed to finalize reservation.");
        return;
      }

      setStatusMessage(
        `Simulated Add to Cart complete. Reservation marked purchased (orderRef: ${orderRef}).`
      );
    } catch (err: any) {
      console.error("handleSimulateAddToCart error", err);
      setError(err.message ?? "Failed to simulate add to cart.");
    } finally {
      setFinalizing(false);
    }
  };

  const handleUseSuggestion = (num: number) => {
    setPreferredNumber(String(num));
    setStatusMessage(`Selected #${num}. Now click Confirm and Reserve.`);
  };

  const lockInputs = isReserved;

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Widget Demo</h1>
      <p className="text-sm text-gray-600 mb-6">
        Internal preview only. In Shopify, club + size will be auto-detected from the product.
      </p>

      <div className="bg-white rounded-xl shadow p-6 space-y-4">
        {/* Amber banner when reserved */}
        {isReserved && (
          <div className="text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded p-3">
            <div className="font-semibold">
              Reserved: #{reservationResult.reservedNumber} ({reservationResult.reservedSize})
            </div>
            <div className="text-[13px] mt-1">
              Hold expires in <strong>{formatMsAsMMSS(remainingMs)}</strong>. Please click Add to Cart.
            </div>

            <div className="mt-3 flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={handleSimulateAddToCart}
                disabled={finalizing}
                className="px-3 py-2 rounded bg-amber-600 text-white text-sm font-semibold disabled:bg-gray-400"
              >
                {finalizing ? "Simulating…" : "Simulate Add to Cart (demo)"}
              </button>

              <button
                type="button"
                onClick={handleCancelReservation}
                disabled={reserving}
                className="px-3 py-2 rounded bg-white border border-amber-300 text-amber-900 text-sm font-semibold disabled:opacity-60"
              >
                {reserving ? "Working…" : "Change number (cancel reservation)"}
              </button>
            </div>
          </div>
        )}

        {/* Demo club + size controls */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Demo club
            </label>
            <select
              value={selectedClubId}
              onChange={(e) => {
                if (lockInputs) return;
                setSelectedClubId(e.target.value);
                clearAll();
              }}
              className="w-full border rounded px-3 py-2 text-sm disabled:bg-gray-100"
              disabled={lockInputs}
            >
              {clubs.length === 0 && <option value="">No client clubs found</option>}
              {clubs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Jersey size (demo)
            </label>
            <select
              value={selectedSize}
              onChange={(e) => {
                if (lockInputs) return;
                setSelectedSize(e.target.value);
                resetOutputs();
              }}
              className="w-full border rounded px-3 py-2 text-sm disabled:bg-gray-100"
              disabled={lockInputs || sizes.length === 0}
            >
              {sizes.length === 0 && <option value="">No sizes in inventory</option>}
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Inputs */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Year of birth
            </label>
            <input
              type="number"
              value={yearOfBirth}
              onChange={(e) => {
                if (lockInputs) return;
                setYearOfBirth(e.target.value);
                resetOutputs();
              }}
              placeholder="e.g. 2013"
              className="w-full border rounded px-3 py-2 text-sm disabled:bg-gray-100"
              disabled={lockInputs}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Team (optional)
            </label>
            <select
              value={selectedTeamId}
              onChange={(e) => {
                if (lockInputs) return;
                setSelectedTeamId(e.target.value);
              }}
              className="w-full border rounded px-3 py-2 text-sm disabled:bg-gray-100"
              disabled={lockInputs || !yobValid || teamsLoading}
            >
              {!yobValid && <option value="">Enter YOB to see teams</option>}
              {yobValid && teamsLoading && <option value="">Loading teams…</option>}
              {yobValid && !teamsLoading && (
                <>
                  {teams.length === 0 && (
                    <option value="">Team not listed / not assigned yet</option>
                  )}
                  {teams.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label} ({t.count})
                    </option>
                  ))}
                  <option value="">Team not listed / not assigned yet</option>
                </>
              )}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Preferred jersey number
          </label>
          <input
            type="number"
            value={preferredNumber}
            onChange={(e) => {
              if (lockInputs) return;
              setPreferredNumber(e.target.value);
              resetOutputs();
            }}
            placeholder="e.g. 12"
            className="w-full border rounded px-3 py-2 text-sm disabled:bg-gray-100"
            disabled={lockInputs}
          />
        </div>

        {/* Actions (disabled when reserved) */}
        <div className="flex flex-col md:flex-row gap-3">
          <button
            type="button"
            onClick={handleCheckNumber}
            disabled={checking || lockInputs}
            className="flex-1 px-4 py-2 rounded bg-indigo-600 text-white text-sm font-semibold disabled:bg-gray-400"
          >
            {checking ? "Checking…" : "Check this number"}
          </button>

          <button
            type="button"
            onClick={handleSuggestNumbers}
            disabled={suggesting || lockInputs}
            className="flex-1 px-4 py-2 rounded bg-slate-800 text-white text-sm font-semibold disabled:bg-gray-400"
          >
            {suggesting ? "Finding options…" : "Suggest recommended numbers"}
          </button>
        </div>

        <div className="flex flex-col md:flex-row gap-3">
          <button
            type="button"
            onClick={handleReserve}
            disabled={reserving || lockInputs}
            className="flex-1 px-4 py-2 rounded bg-emerald-600 text-white text-sm font-semibold disabled:bg-gray-400"
          >
            {reserving ? "Reserving…" : "Confirm and Reserve (15 min hold)"}
          </button>
        </div>

        {/* Messages */}
        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
            {error}
          </div>
        )}

        {statusMessage && (
          <div className="text-sm text-indigo-700 bg-indigo-50 border border-indigo-200 rounded p-3">
            {statusMessage}
          </div>
        )}

        {/* Reservation debug */}
        {(reservationResult.pendingAllocationId || reservationResult.inventoryId) && (
          <div className="text-[12px] text-gray-700 bg-gray-50 border border-gray-200 rounded p-3">
            <div>
              <strong>Pending Allocation ID:</strong>{" "}
              {reservationResult.pendingAllocationId ?? "—"}
            </div>
            <div>
              <strong>Inventory ID:</strong> {reservationResult.inventoryId ?? "—"}
            </div>
            <div>
              <strong>Expires At:</strong> {reservationResult.expiresAtIso ?? "—"}
            </div>
          </div>
        )}

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              Recommended numbers ({clubName}, size {selectedSize || "—"})
            </h2>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.jersey_number}
                  type="button"
                  onClick={() => handleUseSuggestion(s.jersey_number)}
                  className="px-3 py-1 rounded-full text-xs border border-emerald-500 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-60"
                  disabled={lockInputs}
                  title={typeof s.score === "number" ? `Score: ${s.score}` : undefined}
                >
                  #{s.jersey_number} · {s.total_stock} in stock
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Stock debug */}
        {stockBySize.length > 0 && preferredNumber.trim().length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              Internal view: inventory for #{preferredNumber} in {clubName}
            </h2>
            <div className="text-[11px] text-gray-600">
              {stockBySize.map((s) => `${s.size}: ${s.count} available`).join(" • ")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default JerseyWidget;
