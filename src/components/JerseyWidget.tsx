import React, { useEffect, useMemo, useState } from "react";
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

interface TeamOption {
  team_id: string; // stored on players.team_id (string)
  label: string;   // team_label if available, else team_id
}

const CURRENT_SEASON_YEAR = 2025; // update once per season
const NOT_ASSIGNED_TEAM_ID = "__NOT_ASSIGNED__";

const toAgeGroup = (seasonYear: number, yob: number): string => {
  const age = seasonYear - yob;
  if (!Number.isFinite(age) || age <= 0) return "";
  return `U${age}`;
};

const JerseyWidget: React.FC = () => {
  // Demo-only controls
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [sizes, setSizes] = useState<string[]>([]);
  const [selectedSize, setSelectedSize] = useState<string>("");

  // Player identity inputs (needed to persist YOB)
  const [firstName, setFirstName] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");

  // Widget inputs
  const [yearOfBirth, setYearOfBirth] = useState<string>("");
  const [preferredNumber, setPreferredNumber] = useState<string>("");

  // Team dropdown (loaded from players table, filtered by YOB-derived age_group)
  const [teamOptions, setTeamOptions] = useState<TeamOption[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>(NOT_ASSIGNED_TEAM_ID);

  // Results / status
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [stockBySize, setStockBySize] = useState<StockBySize[]>([]);
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [usedTeamFallback, setUsedTeamFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const computedAgeGroup = useMemo(() => {
    if (!Number.isFinite(yobNum) || yobNum < 1900) return "";
    return toAgeGroup(CURRENT_SEASON_YEAR, yobNum);
  }, [yobNum]);

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

  // 3) Load team options for club + computed age group (from players table)
  useEffect(() => {
    const loadTeams = async () => {
      setTeamOptions([]);
      setSelectedTeamId(NOT_ASSIGNED_TEAM_ID);

      if (!selectedClubId) return;
      if (!computedAgeGroup) return; // require YOB before suggesting teams

      setError(null);

      const { data, error } = await supabase
        .from("players")
        .select("team_id, team_label, age_group")
        .eq("club_id", selectedClubId)
        .eq("age_group", computedAgeGroup);

      if (error) {
        console.warn("JerseyWidget loadTeams error", error);
        // Not fatal - dropdown will just show "not assigned"
        return;
      }

      const seen = new Map<string, string>();
      (data ?? []).forEach((r: any) => {
        const teamId = String(r.team_id ?? "").trim();
        if (!teamId) return;
        const label = String(r.team_label ?? "").trim();
        if (!seen.has(teamId)) {
          seen.set(teamId, label || teamId);
        }
      });

      const options: TeamOption[] = Array.from(seen.entries())
        .map(([team_id, label]) => ({ team_id, label }))
        .sort((a, b) => a.label.localeCompare(b.label));

      setTeamOptions(options);
    };

    void loadTeams();
  }, [selectedClubId, computedAgeGroup]);

  const clubName =
    clubs.find((c) => c.id === selectedClubId)?.name ?? "Selected club";

  const getStockForSelectedSize = (stock: StockBySize[]) => {
    const hit = stock.find(
      (s) => String(s.size).trim() === String(selectedSize).trim()
    );
    return hit?.count ?? 0;
  };

  const upsertPlayerYobAndTeam = async () => {
    // We only persist if we have enough to identify a player row.
    // For Shopify, you can map these fields to line item properties and pass into the widget.
    if (!selectedClubId) return;
    if (!firstName.trim() || !lastName.trim()) return;
    if (!Number.isFinite(yobNum) || yobNum < 1900) return;

    const teamIdForStore =
      selectedTeamId === NOT_ASSIGNED_TEAM_ID ? null : selectedTeamId;

    const payload: any = {
      club_id: selectedClubId,
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      year_of_birth: yobNum,
      yob: yobNum,
      age_group: computedAgeGroup || null,
      team_id: teamIdForStore,
    };

    // Upsert strategy: use a pragmatic conflict target via Postgres unique index later.
    // For now, we do: try find an existing record matching club + name, then update that id.
    const { data: existing, error: findError } = await supabase
      .from("players")
      .select("id, year_of_birth")
      .eq("club_id", selectedClubId)
      .ilike("first_name", payload.first_name)
      .ilike("last_name", payload.last_name)
      .limit(1);

    if (findError) {
      console.warn("Widget player lookup failed", findError);
      return;
    }

    const existingRow = (existing ?? [])[0];

    if (existingRow?.id) {
      // Update existing row - keep any existing year_of_birth if set and conflicts (avoid overwriting good data)
      const existingYob = Number(existingRow.year_of_birth);
      const finalYob =
        Number.isFinite(existingYob) && existingYob > 0 ? existingYob : yobNum;

      const { error: updateError } = await supabase
        .from("players")
        .update({
          ...payload,
          year_of_birth: finalYob,
          yob: finalYob,
        })
        .eq("id", existingRow.id);

      if (updateError) {
        console.warn("Widget player update failed", updateError);
      }
    } else {
      // Insert new row
      const { error: insertError } = await supabase.from("players").insert(payload);
      if (insertError) {
        console.warn("Widget player insert failed", insertError);
      }
    }
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

    if (!Number.isFinite(yobNum) || yobNum < 1900) {
      return setError("Year of birth looks invalid.");
    }

    const num = Number(preferredNumber);

    // Allow 0 as valid
    if (!Number.isFinite(num) || num < 0) {
      return setError("Preferred number must be 0 or a positive number.");
    }

    setChecking(true);
    try {
      // Persist YOB + team (best effort, non-blocking)
      await upsertPlayerYobAndTeam();

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

      setStatusMessage("This number is available for your age group and size.");
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

    if (!Number.isFinite(yobNum) || yobNum < 1900) {
      return setError("Year of birth looks invalid.");
    }

    setSuggesting(true);
    try {
      // Persist YOB + team (best effort, non-blocking)
      await upsertPlayerYobAndTeam();

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
          "No age-group-safe numbers were available. Showing best fallback options based on your selected team."
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
        Demo widget. In Shopify you will pass club + size automatically, and can pass player name.
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
              onChange={(e) => setSelectedSize(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              disabled={sizes.length === 0}
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

        {/* Player name */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Player first name
            </label>
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="e.g. Bella"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Player last name
            </label>
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="e.g. Smith"
            />
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
            {computedAgeGroup && (
              <div className="mt-1 text-[11px] text-gray-500">
                Detected age group: {computedAgeGroup}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Team (filtered by age group)
            </label>
            <select
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              disabled={!computedAgeGroup}
            >
              <option value={NOT_ASSIGNED_TEAM_ID}>
                Team not listed / I am not yet assigned
              </option>
              {teamOptions.map((t) => (
                <option key={t.team_id} value={t.team_id}>
                  {t.label}
                </option>
              ))}
            </select>
            {!computedAgeGroup && (
              <div className="mt-1 text-[11px] text-gray-500">
                Enter YOB to load teams for the correct age group.
              </div>
            )}
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
            {usedTeamFallback && (
              <div className="mb-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                Fallback options: no age-group-safe numbers available.
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
