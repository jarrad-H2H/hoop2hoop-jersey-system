// FILE: src/components/JerseyWidget.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  smartCheckNumber,
  suggestNumbersForClubRanked,
  reserveNumberForPurchase,
} from "../services/allocation";

interface MappingRow {
  shopify_product_id: string;
  club_id: string;
}

interface TeamRow {
  id: string;
  name: string;
}

interface NumberSuggestion {
  jersey_number: number;
  total_stock: number;
  score?: number;
}

const SEASON_YEAR = 2025;

const JerseyWidget: React.FC = () => {
  // ---- Shopify context passed in via iframe query params / postMessage ----
  const [shopifyProductId, setShopifyProductId] = useState<string>("");
  const [selectedSize, setSelectedSize] = useState<string>("");

  // ---- Club detection (via mapping table) ----
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [clubDetectError, setClubDetectError] = useState<string | null>(null);

  // ---- Team dropdown ----
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [teamChoice, setTeamChoice] = useState<string>("not_sure"); // required (including "not sure")
  const [suggestedTeamIds, setSuggestedTeamIds] = useState<string[]>([]);

  // ---- Inputs ----
  const [yearOfBirth, setYearOfBirth] = useState<string>("");
  const [preferredNumber, setPreferredNumber] = useState<string>("");

  // ---- Suggestions / selection ----
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);

  // ---- UI state ----
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [reserving, setReserving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Reservation status ----
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [tick, setTick] = useState<number>(Date.now());
  const [pendingAllocationId, setPendingAllocationId] = useState<string>("");

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = Number.isFinite(yobNum) && yobNum >= 1900 && yobNum <= 2100;

  const remainingSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - tick) / 1000))
    : 0;

  const sizeSelected = Boolean((selectedSize || "").trim());
  const teamSelected = Boolean((teamChoice || "").trim());

  const canSuggest =
    Boolean(selectedClubId) && sizeSelected && yobValid && teamSelected && !loadingSuggest && !reserving;

  const canConfirm =
    Boolean(selectedClubId) &&
    sizeSelected &&
    yobValid &&
    teamSelected &&
    selectedNumber !== null &&
    !reserving &&
    !loadingSuggest;

  // ---- Send events to Shopify (parent window) AND to local page (admin demo) ----
  const notifyShopify = (
    type: "h2h:reservation:ready" | "h2h:reservation:cleared",
    payload?: any
  ) => {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type, ...(payload || {}) }, "*");
      }
      window.dispatchEvent(new CustomEvent(type, { detail: payload || {} }));
    } catch (_) {}
  };

  // ---- 1) Read initial query params (best-effort) ----
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const pid = (params.get("productId") || params.get("product_id") || "").trim();
      if (pid) setShopifyProductId(pid);
    } catch (_) {}
    setTeamChoice("not_sure");
  }, []);

  // ---- 2) Listen for Shopify variant changes from public/widget.js ----
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      try {
        const data: any = event?.data;
        if (!data || data.type !== "h2h:variantChanged") return;

        const size = (data.size || "").trim();
        if (size) {
          setSelectedSize(size);
          setSuggestions([]);
          setSelectedNumber(null);
          setError(null);
        }

        const pid = (data.productId || data.product_id || "").toString().trim();
        if (pid) setShopifyProductId(pid);
      } catch (_) {}
    };

    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // ---- 3) Detect club via mapping table: shopify_product_club_map ----
  useEffect(() => {
    const run = async () => {
      setClubDetectError(null);
      setSelectedClubId("");
      setTeams([]);
      setTeamsError(null);
      setSuggestedTeamIds([]);
      setTeamChoice("not_sure");

      const pid = (shopifyProductId || "").trim();
      if (!pid) return;

      const { data, error } = await supabase
        .from("shopify_product_club_map")
        .select("shopify_product_id, club_id")
        .eq("shopify_product_id", pid)
        .limit(1);

      if (error) {
        setClubDetectError(error.message);
        return;
      }

      const row = (data?.[0] as MappingRow | undefined) ?? undefined;
      if (!row?.club_id) {
        setClubDetectError("Club could not be detected for this product.");
        return;
      }

      setSelectedClubId(row.club_id);
    };

    void run();
  }, [shopifyProductId]);

  // ---- 4) Load teams for detected club (if teams table exists) ----
  useEffect(() => {
    const loadTeams = async () => {
      setTeams([]);
      setTeamsError(null);
      setSuggestedTeamIds([]);
      setTeamChoice("not_sure");

      if (!selectedClubId) return;

      const { data, error } = await supabase
        .from("teams")
        .select("id, name")
        .eq("club_id", selectedClubId)
        .order("name");

      if (error) {
        // If teams table doesn't exist or RLS blocks it, don't break the widget.
        setTeamsError(error.message);
        return;
      }

      setTeams((data ?? []) as TeamRow[]);
    };

    void loadTeams();
  }, [selectedClubId]);

  // ---- 5) Suggest team ordering based on YOB (uses players table team_id frequency) ----
  useEffect(() => {
    const run = async () => {
      setSuggestedTeamIds([]);
      if (!selectedClubId || !yobValid) return;

      // Try exact YOB first
      const tryYobWindows: Array<{ min: number; max: number }> = [
        { min: yobNum, max: yobNum },
        { min: yobNum - 1, max: yobNum + 1 },
      ];

      for (const w of tryYobWindows) {
        const { data, error } = await supabase
          .from("players")
          .select("team_id, year_of_birth")
          .eq("club_id", selectedClubId)
          .gte("year_of_birth", w.min)
          .lte("year_of_birth", w.max);

        if (error) {
          // Don't block widget if players table has RLS issues; just skip.
          return;
        }

        const rows = (data ?? []) as any[];
        const counts = new Map<string, number>();

        for (const r of rows) {
          const tid = (r as any).team_id;
          if (!tid) continue;
          counts.set(String(tid), (counts.get(String(tid)) ?? 0) + 1);
        }

        const ranked = Array.from(counts.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([id]) => id);

        if (ranked.length > 0) {
          setSuggestedTeamIds(ranked.slice(0, 6));
          return;
        }
      }
    };

    void run();
  }, [selectedClubId, yobValid, yobNum]);

  // ---- 6) Countdown tick ----
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  // ---- 7) Auto-expire reservation (UI only) ----
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => {
      if (Date.now() >= expiresAt) {
        setExpiresAt(null);
        setStatusMessage("");
        setSelectedNumber(null);
        setPendingAllocationId("");
        notifyShopify("h2h:reservation:cleared");
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const clearMessages = () => {
    setError(null);
    setStatusMessage("");
  };

  // Order teams: suggested first, then the rest
  const orderedTeams = useMemo(() => {
    if (!teams.length) return { suggested: [] as TeamRow[], rest: [] as TeamRow[] };

    const suggestedSet = new Set(suggestedTeamIds);
    const suggested = teams.filter((t) => suggestedSet.has(t.id));
    const rest = teams.filter((t) => !suggestedSet.has(t.id));

    // keep suggested order based on suggestedTeamIds ranking
    const rank = new Map<string, number>();
    suggestedTeamIds.forEach((id, idx) => rank.set(id, idx));
    suggested.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));

    return { suggested, rest };
  }, [teams, suggestedTeamIds]);

  const handleSuggest = async () => {
    clearMessages();

    if (!selectedClubId) {
      setError(clubDetectError || "Club could not be detected for this product.");
      return;
    }
    if (!sizeSelected) {
      setError("Please select a size above to continue.");
      return;
    }
    if (!yobValid) {
      setError("Please enter a valid year of birth.");
      return;
    }
    if (!teamSelected) {
      setError("Please select a team (or choose Not sure/Not assigned yet).");
      return;
    }

    setLoadingSuggest(true);
    setSuggestions([]);
    setSelectedNumber(null);

    try {
      const ranked = await suggestNumbersForClubRanked({
        clubId: selectedClubId,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobNum,
        limit: 12,
      });

      // If preferred number entered, check if it's safe + stock exists for selected size
      const pref = Number(preferredNumber);
      if (Number.isFinite(pref)) {
        try {
          const check = await smartCheckNumber(selectedClubId, pref, {
            seasonYear: SEASON_YEAR,
            yearOfBirth: yobNum,
            cohortWindowYears: 0,
          });

          const sizeStock = (check.stockBySize || []).find((s) => String(s.size) === String(selectedSize));
          const hasSizeStock = Boolean(sizeStock && sizeStock.count > 0);
          const noClash = (check.clashes || []).length === 0;

          if (noClash && hasSizeStock) {
            const exists = ranked.some((r) => r.jersey_number === pref);
            const boosted: NumberSuggestion[] = exists
              ? ranked
              : [{ jersey_number: pref, total_stock: sizeStock?.count ?? 1, score: -9999 }, ...ranked];
            setSuggestions(boosted);
          } else {
            setSuggestions(ranked);
          }
        } catch (_) {
          setSuggestions(ranked);
        }
      } else {
        setSuggestions(ranked);
      }

      if (!ranked || ranked.length === 0) {
        setError("No available numbers found for this size. Try another size or contact the club.");
      }
    } finally {
      setLoadingSuggest(false);
    }
  };

  const handlePickSuggestion = (num: number) => {
    setSelectedNumber(num);
    setPreferredNumber(String(num));
    setError(null);
  };

  const handleReserve = async () => {
    clearMessages();

    if (!selectedClubId) {
      setError(clubDetectError || "Club could not be detected for this product.");
      return;
    }
    if (!sizeSelected) {
      setError("Please select a size above to continue.");
      return;
    }
    if (!yobValid) {
      setError("Please enter a valid year of birth.");
      return;
    }
    if (!teamSelected) {
      setError("Please select a team (or choose Not sure/Not assigned yet).");
      return;
    }
    if (selectedNumber === null) {
      setError("Please choose a suggested number before confirming.");
      return;
    }

    setReserving(true);
    try {
      const teamId = teamChoice === "not_sure" ? null : teamChoice;

      const result = await reserveNumberForPurchase({
        clubId: selectedClubId,
        jerseyNumber: selectedNumber,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobNum,
        teamId,
        expiresMinutes: 15,
      });

      if (!result.success) {
        setError(result.message || "Could not reserve that number.");
        return;
      }

      const expiry = Date.now() + 15 * 60 * 1000;
      setExpiresAt(expiry);

      const pid = result.pendingAllocationId || "";
      setPendingAllocationId(pid);

      setStatusMessage(`Jersey #${selectedNumber} reserved. Hold expires in 15:00.`);

      notifyShopify("h2h:reservation:ready", {
        jerseyNumber: selectedNumber,
        pendingAllocationId: pid,
      });
    } finally {
      setReserving(false);
    }
  };

  return (
    <div className="w-full max-w-[440px]">
      <div className="mb-3">
        <h3 className="text-base font-semibold">Choose your jersey number</h3>
        <p className="text-xs text-gray-600 mt-1">
          Select your size above, then enter details below to find an available playing number.
        </p>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">
          {error}
        </div>
      )}

      {clubDetectError && !selectedClubId && (
        <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-3 mb-3">
          {clubDetectError}
          {!shopifyProductId && <div className="mt-1">(Waiting for product context from Shopify.)</div>}
        </div>
      )}

      <div className="bg-white border rounded p-4 space-y-3">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Size
          </label>
          <div className="border rounded px-3 py-2 text-sm bg-gray-50">
            {sizeSelected ? selectedSize : "Select a size above to continue"}
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Year of birth
          </label>
          <input
            type="number"
            className="border rounded px-3 py-2 w-full"
            placeholder="e.g. 2013"
            value={yearOfBirth}
            onChange={(e) => {
              setYearOfBirth(e.target.value);
              setSuggestions([]);
              setSelectedNumber(null);
              setError(null);
            }}
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Team
          </label>

          <select
            className="border rounded px-3 py-2 w-full"
            value={teamChoice}
            onChange={(e) => {
              setTeamChoice(e.target.value);
              setSuggestions([]);
              setSelectedNumber(null);
              setError(null);
            }}
          >
            <option value="not_sure">I don&apos;t know / Not assigned yet</option>

            {orderedTeams.suggested.length > 0 && (
              <optgroup label="Suggested teams">
                {orderedTeams.suggested.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}

            {orderedTeams.rest.length > 0 && (
              <optgroup label="All teams">
                {orderedTeams.rest.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          {teamsError && (
            <div className="text-xs text-gray-500 mt-1">
              (Teams list unavailable: {teamsError})
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Preferred number (optional)
          </label>
          <input
            type="number"
            className="border rounded px-3 py-2 w-full"
            placeholder="e.g. 23"
            value={preferredNumber}
            onChange={(e) => setPreferredNumber(e.target.value)}
          />
        </div>

        <button
          type="button"
          onClick={handleSuggest}
          disabled={!canSuggest}
          className="w-full px-4 py-2 rounded font-semibold text-sm bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-600"
        >
          {loadingSuggest ? "Checking…" : "Check & Suggest Playing Numbers"}
        </button>

        {suggestions.length > 0 && (
          <div className="pt-2">
            <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">
              Suggested numbers
            </div>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => {
                const active = selectedNumber === s.jersey_number;
                return (
                  <button
                    key={s.jersey_number}
                    type="button"
                    onClick={() => handlePickSuggestion(s.jersey_number)}
                    className={[
                      "px-3 py-2 rounded border text-sm font-semibold",
                      active
                        ? "bg-emerald-600 border-emerald-700 text-white"
                        : "bg-white border-gray-300 text-gray-900 hover:bg-gray-50",
                    ].join(" ")}
                  >
                    #{s.jersey_number}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={handleReserve}
          disabled={!canConfirm}
          className="w-full px-4 py-2 rounded font-semibold text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-300 disabled:text-gray-600"
        >
          {reserving ? "Reserving…" : "Confirm & Reserve"}
        </button>

        {statusMessage && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded text-sm">
            <div>{statusMessage}</div>
            {expiresAt && (
              <div className="text-xs mt-1">
                Hold expires in {Math.floor(remainingSeconds / 60)}:
                {(remainingSeconds % 60).toString().padStart(2, "0")}
              </div>
            )}
            {pendingAllocationId && (
              <div className="text-[11px] mt-1 text-amber-800">
                Reservation reference: {pendingAllocationId}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default JerseyWidget;
