import React, { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import {
  smartCheckNumber,
  suggestNumbersForCohortSizeTeam,
  StockBySize,
  NumberSuggestion,
} from "../services/allocation";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface Team {
  id: string;
  name: string;
}

const CURRENT_SEASON_YEAR = 2025; // update once per season

const NOT_ASSIGNED_TEAM_ID = "__NOT_ASSIGNED__";

const JerseyWidget: React.FC = () => {
  // Demo-only controls
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [sizes, setSizes] = useState<string[]>([]);
  const [selectedSize, setSelectedSize] = useState<string>("");

  // Team dropdown (optional)
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>(NOT_ASSIGNED_TEAM_ID);

  // Widget inputs
  const [yearOfBirth, setYearOfBirth] = useState<string>("");
  const [preferredNumber, setPreferredNumber] = useState<string>("");

  // Results / status
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [stockBySize, setStockBySize] = useState<StockBySize[]>([]);
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [usedTeamFallback, setUsedTeamFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  // 1) Load demo clubs (is_client = true)
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

  // 2) Load available sizes for selected club (from inventory)
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

  // 3) Load teams for selected club (optional - if teams table exists)
  useEffect(() => {
    const loadTeams = async () => {
      if (!selectedClubId) {
        setTeams([]);
        setSelectedTeamId(NOT_ASSIGNED_TEAM_ID);
        return;
      }

      setError(null);

      try {
        const { data, error } = await supabase
          .from("teams")
          .select("id, name")
          .eq("club_id", selectedClubId)
          .order("name", { ascending: true });

        // If teams table doesn't exist or query fails, we silently fall back to "not assigned"
        if (error) {
          console.warn("JerseyWidget loadTeams warning", error);
          setTeams([]);
          setSelectedTeamId(NOT_ASSIGNED_TEAM_ID);
          return;
        }

        const list = (data ?? []) as Team[];
        setTeams(list);
        setSelectedTeamId(NOT_ASSIGNED_TEAM_ID);
      } catch {
        setTeams([]);
        setSelectedTeamId(NOT_ASSIGNED_TEAM_ID);
      }
    };

    void loadTeams();
  }, [selectedClubId]);

  const clubName =
    clubs.find((c) => c.id === selectedClubId)?.name ?? "Selected club";

  const selectedTeamName =
    selectedTeamId === NOT_ASSIGNED_TEAM_ID
      ? "Team not listed / not yet assigned"
      : teams.find((t) => t.id === selectedTeamId)?.name ?? "Selected team";

  const getStockForSelectedSize = (stock: StockBySize[]) => {
    const hit = stock.find((s) => String(s.size).trim() === String(selectedSize).trim());
    return hit?.count ?? 0;
  };

  const handleCheckNumber = async () => {
    setError(null);
    setStatusMessage("");
    setStockBySize([]);
    setSuggestions([]);
    setUsedTeamFallback(false);

    if (!selectedClubId) return setError("Please choose a club.");
    if (!selectedSize) return setError("Please choose a size.");
    if (!yearOfBirth) return setError("Please enter year of birth.");
    if (preferredNumber === "") return setError("Please enter a preferred number.");

    const yobNum = Number(yearOfBirth);
    const num = Number(preferredNumber);

    if (!Number.isFinite(yobNum) || yobNum < 1900) {
      return setError("Year of birth looks invalid.");
    }

    // Allow 0 (valid jersey number)
    if (!Number.isFinite(num) || num < 0) {
      return setError("Preferred number must be 0 or a positive number.");
    }

    setChecking(true);
    try {
      // Strict same-age check: cohortWindowYears = 0
      const result = await smartCheckNumber(selectedClubId, num, {
        seasonYear: CURRENT_SEASON_YEAR,
        yearOfBirth: yobNum,
        cohortWindowYears: 0,
      });

      setStockBySize(result.stockBySize);

      const sameAgeClash = result.clashes.length > 0;
      const sizeStock = getStockForSelectedSize(result.stockBySize);

      if (sameAgeClash) {
        setStatusMessage(
          "This number isn't available for your age group. Please choose a suggested number."
        );
        return;
      }

      if (sizeStock <= 0) {
        setStatusMessage(
          `This number has no available stock in size ${selectedSize}. Please choose a suggested number.`
        );
        return;
      }

      setStatusMessage(
        "This number is available for your age group and size."
      );
    } catch (err: any) {
      console.error("JerseyWidget handleCheckNumber error", err);
      setError(err.message ?? "Failed to check this number.");
    } finally {
      setChecking(false);
    }
  };

  const handleSuggestNumbers = async () => {
    setError(null);
    setStatusMessage("");
    setSuggestions([]);
    setStockBySize([]);
    setUsedTeamFallback(false);

    if (!selectedClubId) return setError("Please choose a club.");
    if (!selectedSize) return setError("Please choose a size.");
    if (!yearOfBirth) return setError("Year of birth is required to suggest numbers.");

    const yobNum = Number(yearOfBirth);
    if (!Number.isFinite(yobNum) || yobNum < 1900) {
      return setError("Year of birth looks invalid.");
    }

    setSuggesting(true);
    try {
      const teamIdForLogic =
        selectedTeamId === NOT_ASSIGNED_TEAM_ID ? null : selectedTeamId;

      const { suggestions, usedTeamFallback } = await suggestNumbersForCohortSizeTeam({
        clubId: selectedClubId,
        size: selectedSize,
        seasonYear: CURRENT_SEASON_YEAR,
        yearOfBirth: yobNum,
        teamId: teamIdForLogic,
        limit: 10,
      });

      setSuggestions(suggestions);
      setUsedTeamFallback(usedTeamFallback);

      if (suggestions.length === 0) {
        setStatusMessage(
          `There are no suitable numbers with available stock for size ${selectedSize}. Please contact the club.`
        );
      } else if (usedTeamFallback) {
        setStatusMessage(
          `No age-group-safe numbers were available. Showing best options that avoid clashes within your selected team (${selectedTeamName}).`
        );
      } else {
        setStatusMessage(
          `Recommended numbers for size ${selectedSize}, based on availability and future demand.`
        );
      }
    } catch (err: any) {
      console.error("JerseyWidget handleSuggestNumbers error", err);
      setError(err.message ?? "Failed to suggest numbers.");
    } finally {
      setSuggesting(false);
    }
  };

  const handleUseSuggestion = (num: number) => {
    setPreferredNumber(String(num));
    setStatusMessage(
      `Using suggested number ${num}. You can now continue with this number.`
    );
  };

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Widget Demo</h1>
      <p className="text-sm text-gray-600 mb-6">
        Shopify will auto-detect club + size from the product. This demo lets you select club, size, YOB, and team for testing.
      </p>

      <div className="bg-white rounded-xl shadow p-6 space-y-4">
        {/* Demo club + size controls */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Demo club
            </label>
            <select
              value={selectedClubId}
              onChange={(e) => setSelectedClubId(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
            >
              {clubs.length === 0 && (
                <option value="">No client clubs found</option>
              )}
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
              onChange={(e) => setSelectedSize(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              disabled={sizes.length === 0}
            >
              {sizes.length === 0 && (
                <option value="">No sizes in inventory</option>
              )}
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* YOB + Team */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Year of birth
            </label>
            <input
              type="number"
              value={yearOfBirth}
              onChange={(e) => setYearOfBirth(e.target.value)}
              placeholder="e.g. 2013"
              className="w-full border rounded px-3 py-2 text-sm"
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
            >
              <option value={NOT_ASSIGNED_TEAM_ID}>
                Team not listed / I am not yet assigned
              </option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-gray-500">
              Used only if no age-group-safe numbers exist.
            </p>
          </div>
        </div>

        {/* Preferred number */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Preferred jersey number
          </label>
          <input
            type="number"
            value={preferredNumber}
            onChange={(e) => setPreferredNumber(e.target.value)}
            placeholder="e.g. 12 (0 allowed)"
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </div>

        {/* Actions */}
        <div className="flex flex-col md:flex-row gap-3">
          <button
            type="button"
            onClick={handleCheckNumber}
            disabled={checking}
            className="flex-1 px-4 py-2 rounded bg-indigo-600 text-white text-sm font-semibold disabled:bg-gray-400"
          >
            {checking ? "Checking…" : "Check this number"}
          </button>
          <button
            type="button"
            onClick={handleSuggestNumbers}
            disabled={suggesting}
            className="flex-1 px-4 py-2 rounded bg-slate-800 text-white text-sm font-semibold disabled:bg-gray-400"
          >
            {suggesting ? "Finding options…" : "Suggest numbers with stock"}
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
        {suggestions.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              Suggested numbers with stock ({clubName}, size {selectedSize || "—"})
            </h2>

            {usedTeamFallback && (
              <div className="mb-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                These are fallback options (no age-group-safe numbers were available).
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.jersey_number}
                  type="button"
                  onClick={() => handleUseSuggestion(s.jersey_number)}
                  className="px-3 py-1 rounded-full text-xs border border-emerald-500 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                >
                  #{s.jersey_number} · {s.total_stock} in stock
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Optional internal debug */}
        {stockBySize.length > 0 && preferredNumber !== "" && (
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
