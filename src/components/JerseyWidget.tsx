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

interface NumberSuggestion {
  jersey_number: number;
  total_stock: number;
  score?: number;
}

interface TeamRow {
  id: string;
  name: string;
  club_id: string | null;
  club_id_uuid: string | null;
  age_group: string | null;
  gender: string | null;
}

type AgeGroupLabel = "U10" | "U12" | "U14" | "U16" | "U18" | "U20" | "SLG";

function deriveAgeGroupFromYob(seasonYear: number, yob: number): AgeGroupLabel {
  const age = seasonYear - yob;

  // 2-year bands (typical junior structure)
  if (age <= 9) return "U10"; // 8-9-ish
  if (age <= 11) return "U12"; // 10-11
  if (age <= 13) return "U14"; // 12-13
  if (age <= 15) return "U16"; // 14-15
  if (age <= 17) return "U18"; // 16-17
  if (age <= 19) return "U20"; // 18-19
  return "SLG";
}

function normalizeAgeGroup(raw: unknown): AgeGroupLabel | null {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s || s === "N/A") return null;

  if (s.includes("SLG")) return "SLG";

  // Accept "U12", "12", "U 12", etc
  const m = s.match(/U?\s*(10|12|14|16|18|20)\b/);
  if (!m) return null;

  const n = Number(m[1]);
  if (n === 10) return "U10";
  if (n === 12) return "U12";
  if (n === 14) return "U14";
  if (n === 16) return "U16";
  if (n === 18) return "U18";
  if (n === 20) return "U20";
  return null;
}

function inferTeamAgeGroupFromName(name: string): AgeGroupLabel | null {
  const s = String(name ?? "").trim().toUpperCase();
  if (!s) return null;

  if (s.startsWith("SLG") || s.includes(" SLG") || s.includes("SLG.")) return "SLG";

  // Matches "12B.1", "10B.2", "U12 Boys Div 1", etc
  const m = s.match(/\bU?\s*(10|12|14|16|18|20)\b/);
  if (!m) return null;

  const n = Number(m[1]);
  if (n === 10) return "U10";
  if (n === 12) return "U12";
  if (n === 14) return "U14";
  if (n === 16) return "U16";
  if (n === 18) return "U18";
  if (n === 20) return "U20";
  return null;
}

const JerseyWidget: React.FC = () => {
  const SEASON_YEAR = new Date().getFullYear();

  // Shopify context
  const [shopifyProductId, setShopifyProductId] = useState<string>("");
  const [selectedSize, setSelectedSize] = useState<string>("");

  // Club detection
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [clubDetectError, setClubDetectError] = useState<string | null>(null);

  // Inputs
  const [yearOfBirth, setYearOfBirth] = useState<string>("");
  const [teamChoice, setTeamChoice] = useState<string>("not_sure");
  const [preferredNumber, setPreferredNumber] = useState<string>("");

  // Teams
  const [allTeams, setAllTeams] = useState<TeamRow[]>([]);
  const [loadingTeams, setLoadingTeams] = useState(false);

  // Suggestions
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);

  // UI state
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [reserving, setReserving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reservation status
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [tick, setTick] = useState<number>(Date.now());

  // Keep the current reservation id so we can pass it into Shopify line item properties
  const [pendingAllocationId, setPendingAllocationId] = useState<string>("");

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = Number.isFinite(yobNum) && yobNum >= 1900 && yobNum <= 2100;

  const derivedAgeGroup: AgeGroupLabel | null = useMemo(() => {
    if (!yobValid) return null;
    return deriveAgeGroupFromYob(SEASON_YEAR, yobNum);
  }, [SEASON_YEAR, yobNum, yobValid]);

  const remainingSeconds = expiresAt ? Math.max(0, Math.floor((expiresAt - tick) / 1000)) : 0;
  const sizeSelected = Boolean((selectedSize || "").trim());
  const teamSelected = Boolean((teamChoice || "").trim()); // includes "not_sure"

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

  // Read query params
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const pid = (params.get("productId") || params.get("product_id") || "").trim();
      if (pid) setShopifyProductId(pid);
    } catch (_) {}
    setTeamChoice("not_sure");
  }, []);

  // Listen for Shopify variant changes
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

  // Detect club via mapping table
  useEffect(() => {
    const run = async () => {
      setClubDetectError(null);
      setSelectedClubId("");

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

  // Tick for countdown display
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  // Auto-clear UI when expired (note: DB expiry needs server-side sweep too)
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

  // Load all teams for club (by uuid)
  useEffect(() => {
    const load = async () => {
      setAllTeams([]);
      if (!selectedClubId) return;

      setLoadingTeams(true);
      try {
        // Primary: use club_id_uuid (matches your clubs.uuid)
        const primary = await supabase
          .from("teams")
          .select("id, name, club_id, club_id_uuid, age_group, gender")
          .eq("club_id_uuid", selectedClubId)
          .order("name");

        if (primary.error) throw primary.error;

        const primaryTeams = (primary.data ?? []) as TeamRow[];

        // Fallback: if nothing returned, try legacy club_id text
        if (primaryTeams.length === 0) {
          const fallback = await supabase
            .from("teams")
            .select("id, name, club_id, club_id_uuid, age_group, gender")
            .eq("club_id", selectedClubId)
            .order("name");

          if (fallback.error) throw fallback.error;
          setAllTeams((fallback.data ?? []) as TeamRow[]);
        } else {
          setAllTeams(primaryTeams);
        }
      } catch (e: any) {
        console.warn("Failed to load teams", e?.message || e);
        setAllTeams([]);
      } finally {
        setLoadingTeams(false);
      }
    };

    void load();
  }, [selectedClubId]);

  const clearMessages = () => {
    setError(null);
    setStatusMessage("");
  };

  const filteredTeams = useMemo(() => {
    if (!derivedAgeGroup) return [];

    const want = derivedAgeGroup;

    return (allTeams ?? []).filter((t) => {
      const fromAgeGroupCol = normalizeAgeGroup(t.age_group);
      const fromName = inferTeamAgeGroupFromName(t.name);

      const tag = fromAgeGroupCol ?? fromName;
      return tag === want;
    });
  }, [allTeams, derivedAgeGroup]);

  // If current selected team isn't in filtered list, reset to not_sure (keeps UX safe)
  useEffect(() => {
    if (!derivedAgeGroup) return;

    if (teamChoice === "not_sure") return;

    const exists = filteredTeams.some((t) => t.id === teamChoice);
    if (!exists) setTeamChoice("not_sure");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedAgeGroup, filteredTeams]);

  const orderedTeamOptions = useMemo(() => {
    const notSure = [
      {
        id: "not_sure",
        name: "I don't know / Not assigned yet",
        club_id: null,
        club_id_uuid: selectedClubId || null,
        age_group: derivedAgeGroup ?? null,
        gender: null,
      } as TeamRow,
    ];

    // Before YOB valid -> only show not sure
    if (!derivedAgeGroup) return notSure;

    // If no matching teams, still show not sure (dropdown won’t be empty)
    if (!filteredTeams.length) return notSure;

    return [...notSure, ...filteredTeams];
  }, [filteredTeams, selectedClubId, derivedAgeGroup]);

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

      // If preferred number entered, check if it’s viable for THIS size (stock exists + no cohort clash)
      const pref = Number(preferredNumber);
      if (Number.isFinite(pref)) {
        try {
          const check = await smartCheckNumber(selectedClubId, pref, {
            seasonYear: SEASON_YEAR,
            yearOfBirth: yobNum,
            cohortWindowYears: 0,
          });

          const hasStockForSize = (check.stockBySize ?? []).some(
            (s) => String(s.size).toLowerCase() === String(selectedSize).toLowerCase() && s.count > 0
          );
          const noClash = (check.clashes ?? []).length === 0;

          if (hasStockForSize && noClash) {
            const exists = ranked.some((r) => r.jersey_number === pref);
            const boosted: NumberSuggestion[] = exists
              ? ranked
              : [{ jersey_number: pref, total_stock: 1, score: -999 }, ...ranked];
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
    } catch (e: any) {
      setError(e?.message || "Failed to suggest numbers.");
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
      const result = await reserveNumberForPurchase({
        clubId: selectedClubId,
        jerseyNumber: selectedNumber,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobNum,
        teamId: teamChoice === "not_sure" ? null : teamChoice,
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

      setStatusMessage(`Jersey #${selectedNumber} reserved.`);

      notifyShopify("h2h:reservation:ready", {
        jerseyNumber: selectedNumber,
        pendingAllocationId: pid,
      });
    } catch (e: any) {
      setError(e?.message || "Reservation failed.");
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
            onChange={(e) => setYearOfBirth(e.target.value)}
          />
          {derivedAgeGroup && (
            <div className="text-xs text-gray-500 mt-1">
              Showing teams for <span className="font-semibold">{derivedAgeGroup}</span> when available.
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Team
          </label>
          <select
            className="border rounded px-3 py-2 w-full"
            value={teamChoice}
            onChange={(e) => setTeamChoice(e.target.value)}
            disabled={loadingTeams}
          >
            {orderedTeamOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          {derivedAgeGroup && !loadingTeams && filteredTeams.length === 0 && (
            <div className="text-xs text-amber-800 mt-1">
              No teams found for {derivedAgeGroup} (for this club). You can still proceed with “Not assigned yet”.
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
              <div className="text-[11px] mt-1 text-amber-900/80 break-all">
                Reservation ID saved for checkout.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default JerseyWidget;
