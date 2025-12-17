// FILE: src/components/JerseyWidget.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  smartCheckNumber,
  StockBySize,
  NumberSuggestion,
  reserveNumberForPurchase,
  suggestNumbersForClubRanked,
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
const HOLD_MINUTES_DEFAULT = 15;

const formatCountdown = (ms: number) => {
  const safe = Math.max(0, ms);
  const totalSeconds = Math.floor(safe / 1000);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
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
  const [simulatingPurchase, setSimulatingPurchase] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Reservation state (locks widget to 1 active reservation)
  const [reservationMeta, setReservationMeta] = useState<{
    pendingAllocationId: string | null;
    inventoryId: string | null;
    expiresAtIso: string | null;
    reservedNumber: number | null;
    reservedSize: string | null;
    reservedClubId: string | null;
    status: "reserved" | "purchased" | "expired" | "cancelled" | null;
  }>({
    pendingAllocationId: null,
    inventoryId: null,
    expiresAtIso: null,
    reservedNumber: null,
    reservedSize: null,
    reservedClubId: null,
    status: null,
  });

  const [msRemaining, setMsRemaining] = useState<number>(0);

  const clubName = useMemo(
    () => clubs.find((c) => c.id === selectedClubId)?.name ?? "Selected club",
    [clubs, selectedClubId]
  );

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = useMemo(
    () => Number.isFinite(yobNum) && yobNum >= 1900,
    [yobNum]
  );

  const isLocked =
    reservationMeta.status === "reserved" &&
    !!reservationMeta.pendingAllocationId &&
    !!reservationMeta.inventoryId;

  const hardResetAll = () => {
    setStatusMessage("");
    setStockBySize([]);
    setSuggestions([]);
    setError(null);
    setReservationMeta({
      pendingAllocationId: null,
      inventoryId: null,
      expiresAtIso: null,
      reservedNumber: null,
      reservedSize: null,
      reservedClubId: null,
      status: null,
    });
    setMsRemaining(0);
  };

  const resetOutputsOnly = () => {
    setStatusMessage("");
    setStockBySize([]);
    setSuggestions([]);
    setError(null);
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
        // Exact cohort: age = SEASON_YEAR - yob
        const targetAge = SEASON_YEAR - yobNum;
        const minYob = SEASON_YEAR - targetAge;
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
          if (!existing) {
            counts.set(teamId, { value: teamId, label, count: 1 });
          } else {
            existing.count += 1;
          }
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

  // Countdown timer
  useEffect(() => {
    if (!isLocked || !reservationMeta.expiresAtIso) {
      setMsRemaining(0);
      return;
    }

    const compute = () => {
      const exp = Date.parse(reservationMeta.expiresAtIso as string);
      if (!Number.isFinite(exp)) {
        setMsRemaining(0);
        return;
      }
      const remaining = exp - Date.now();
      setMsRemaining(Math.max(0, remaining));
    };

    compute();
    const t = window.setInterval(compute, 1000);
    return () => window.clearInterval(t);
  }, [isLocked, reservationMeta.expiresAtIso]);

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
    if (isLocked) return;

    setError(null);
    resetOutputsOnly();

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

      // Hard block: cohort clash
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

      // Must have stock in selected size
      const inSize =
        result.stockBySize.find((s) => s.size === selectedSize)?.count ?? 0;

      if (inSize <= 0) {
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
    if (isLocked) return;

    setError(null);
    resetOutputsOnly();

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
    if (isLocked) return;

    setError(null);
    resetOutputsOnly();

    const validated = validateCore();
    if (!validated) return;

    const { yob, num } = validated;

    setReserving(true);
    try {
      // Safety check right before reserving
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

      const inSize =
        check.stockBySize.find((s) => s.size === selectedSize)?.count ?? 0;

      if (inSize <= 0) {
        setError("That number has no available stock in this size. Please pick a suggested number.");
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
        expiresMinutes: HOLD_MINUTES_DEFAULT,
      });

      if (!result.success) {
        setError(result.message);
        return;
      }

      const pendingId = result.pendingAllocationId ?? null;
      const invId = result.inventoryId ?? null;

      // Prefer DB expires_at (source of truth)
      let expiresAtIso: string | null = null;
      if (pendingId) {
        const { data, error } = await supabase
          .from("pending_allocations")
          .select("expires_at, status")
          .eq("id", pendingId)
          .maybeSingle();

        if (!error && data?.expires_at) {
          expiresAtIso = String((data as any).expires_at);
        }
      }

      // Fallback if we can’t read it
      if (!expiresAtIso) {
        expiresAtIso = new Date(Date.now() + HOLD_MINUTES_DEFAULT * 60_000).toISOString();
      }

      setReservationMeta({
        pendingAllocationId: pendingId,
        inventoryId: invId,
        expiresAtIso,
        reservedNumber: num,
        reservedSize: selectedSize,
        reservedClubId: selectedClubId,
        status: "reserved",
      });

      setStatusMessage(
        `Reserved jersey #${num} (${selectedSize}). Please click Add to cart before the hold expires.`
      );
    } catch (err: any) {
      console.error("JerseyWidget handleReserve error", err);
      setError(err.message ?? "Failed to reserve this number.");
    } finally {
      setReserving(false);
    }
  };

  const handleUseSuggestion = (num: number) => {
    if (isLocked) return;
    setPreferredNumber(String(num));
    setStatusMessage(`Selected #${num}. Now click Confirm and Reserve.`);
  };

  const handleSimulateAddToCart = async () => {
    if (!isLocked || !reservationMeta.pendingAllocationId) return;

    setSimulatingPurchase(true);
    setError(null);

    try {
      // Mark pending allocation as purchased (demo stand-in for Shopify checkout)
      const { error: updErr } = await supabase
        .from("pending_allocations")
        .update({
          status: "purchased",
        })
        .eq("id", reservationMeta.pendingAllocationId)
        .eq("status", "reserved");

      if (updErr) {
        console.error("simulate purchase update error", updErr);
        setError("Failed to mark reservation as purchased.");
        return;
      }

      setReservationMeta((prev) => ({
        ...prev,
        status: "purchased",
      }));

      setStatusMessage(
        "Simulated Add to cart: pending allocation marked as purchased. Inventory remains allocated."
      );
    } catch (err: any) {
      console.error("handleSimulateAddToCart error", err);
      setError(err.message ?? "Failed to simulate Add to cart.");
    } finally {
      setSimulatingPurchase(false);
    }
  };

  const handleChangeNumberCancel = async () => {
    if (!isLocked) return;

    const pendingId = reservationMeta.pendingAllocationId;
    const invId = reservationMeta.inventoryId;

    if (!pendingId || !invId) {
      hardResetAll();
      return;
    }

    setCancelling(true);
    setError(null);

    try {
      // 1) Mark pending allocation cancelled (only if still reserved)
      const { data: pendingRow, error: pendingErr } = await supabase
        .from("pending_allocations")
        .select("club_id, jersey_number, size")
        .eq("id", pendingId)
        .maybeSingle();

      if (pendingErr) {
        console.error("cancel read pending error", pendingErr);
        setError("Failed to read pending allocation for cancellation.");
        return;
      }

      const { error: cancelErr } = await supabase
        .from("pending_allocations")
        .update({ status: "cancelled" })
        .eq("id", pendingId)
        .eq("status", "reserved");

      if (cancelErr) {
        console.error("cancel pending update error", cancelErr);
        setError("Failed to cancel reservation (pending allocation).");
        return;
      }

      // 2) Return inventory to available
      const { error: invErr } = await supabase
        .from("inventory")
        .update({ status: "Available" })
        .eq("id", invId)
        .eq("status", "Allocated");

      if (invErr) {
        console.error("cancel inventory return error", invErr);
        setError(
          "Reservation cancelled, but failed to return inventory to Available. (You may need to manually fix this row.)"
        );
        return;
      }

      // 3) Audit event (best-effort)
      try {
        const club_id = String((pendingRow as any)?.club_id ?? reservationMeta.reservedClubId ?? "");
        const jersey_number = Number((pendingRow as any)?.jersey_number ?? reservationMeta.reservedNumber ?? NaN);
        const size = String((pendingRow as any)?.size ?? reservationMeta.reservedSize ?? "");

        if (club_id && Number.isFinite(jersey_number) && size) {
          await supabase.from("allocations").insert({
            allocation_type: "return",
            club_id,
            player_id: null,
            jersey_number,
            size,
            previous_jersey_number: null,
            previous_size: null,
            note: "Cancelled reservation via widget demo (change number) - returned to stock",
          });
        }
      } catch {
        // ignore audit failures
      }

      hardResetAll();
      setStatusMessage("Reservation cancelled. You can now choose a different number.");
    } catch (err: any) {
      console.error("handleChangeNumberCancel error", err);
      setError(err.message ?? "Failed to cancel reservation.");
    } finally {
      setCancelling(false);
    }
  };

  const amberTitle = useMemo(() => {
    if (!isLocked) return "";
    const num = reservationMeta.reservedNumber ?? Number(preferredNumber);
    const size = reservationMeta.reservedSize ?? selectedSize;
    return `Reserved jersey #${Number.isFinite(num) ? num : "—"} (${size || "—"})`;
  }, [isLocked, reservationMeta.reservedNumber, reservationMeta.reservedSize, preferredNumber, selectedSize]);

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Widget Demo</h1>
      <p className="text-sm text-gray-600 mb-6">
        Internal preview only. In Shopify, club + size will be auto-detected from the product.
      </p>

      <div className="bg-white rounded-xl shadow p-6 space-y-4">
        {/* Amber reservation banner */}
        {isLocked && (
          <div className="text-sm bg-amber-50 border border-amber-200 rounded p-3 text-amber-900">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold">{amberTitle}</div>
                <div className="text-[12px] mt-1">
                  Hold expires in{" "}
                  <span className="font-semibold">{formatCountdown(msRemaining)}</span>. Please click Add to cart.
                </div>
              </div>

              <div className="flex flex-col gap-2 items-end">
                <button
                  type="button"
                  onClick={handleSimulateAddToCart}
                  disabled={simulatingPurchase || reservationMeta.status !== "reserved"}
                  className="px-3 py-1.5 rounded bg-emerald-600 text-white text-xs font-semibold disabled:bg-gray-300"
                >
                  {simulatingPurchase ? "Adding…" : "Simulate Add to cart (demo)"}
                </button>

                <button
                  type="button"
                  onClick={handleChangeNumberCancel}
                  disabled={cancelling || reservationMeta.status !== "reserved"}
                  className="px-3 py-1.5 rounded bg-slate-800 text-white text-xs font-semibold disabled:bg-gray-300"
                >
                  {cancelling ? "Cancelling…" : "Change number (cancel reservation)"}
                </button>
              </div>
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
                setSelectedClubId(e.target.value);
                if (!isLocked) hardResetAll();
              }}
              className="w-full border rounded px-3 py-2 text-sm"
              disabled={isLocked}
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
                setSelectedSize(e.target.value);
                if (!isLocked) resetOutputsOnly();
              }}
              className="w-full border rounded px-3 py-2 text-sm"
              disabled={sizes.length === 0 || isLocked}
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
                setYearOfBirth(e.target.value);
                if (!isLocked) resetOutputsOnly();
              }}
              placeholder="e.g. 2013"
              className="w-full border rounded px-3 py-2 text-sm"
              disabled={isLocked}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Team (optional)
            </label>
            <select
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              disabled={!yobValid || teamsLoading || isLocked}
            >
              {!yobValid && <option value="">Enter YOB to see teams</option>}
              {yobValid && teamsLoading && <option value="">Loading teams…</option>}
              {yobValid && !teamsLoading && (
                <>
                  {teams.length === 0 && <option value="">No teams found for this cohort</option>}
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
              setPreferredNumber(e.target.value);
              if (!isLocked) resetOutputsOnly();
            }}
            placeholder="e.g. 12"
            className="w-full border rounded px-3 py-2 text-sm"
            disabled={isLocked}
          />
        </div>

        {/* Actions */}
        <div className="flex flex-col md:flex-row gap-3">
          <button
            type="button"
            onClick={handleCheckNumber}
            disabled={checking || isLocked}
            className="flex-1 px-4 py-2 rounded bg-indigo-600 text-white text-sm font-semibold disabled:bg-gray-300"
          >
            {checking ? "Checking…" : "Check this number"}
          </button>

          <button
            type="button"
            onClick={handleSuggestNumbers}
            disabled={suggesting || isLocked}
            className="flex-1 px-4 py-2 rounded bg-slate-800 text-white text-sm font-semibold disabled:bg-gray-300"
          >
            {suggesting ? "Finding options…" : "Suggest recommended numbers"}
          </button>
        </div>

        <div className="flex flex-col md:flex-row gap-3">
          <button
            type="button"
            onClick={handleReserve}
            disabled={reserving || isLocked}
            className="flex-1 px-4 py-2 rounded bg-emerald-600 text-white text-sm font-semibold disabled:bg-gray-300"
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

        {/* Suggestions */}
        {!isLocked && suggestions.length > 0 && (
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
                  className="px-3 py-1 rounded-full text-xs border border-emerald-500 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
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
