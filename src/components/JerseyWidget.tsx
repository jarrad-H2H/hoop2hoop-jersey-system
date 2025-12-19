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
  clubs?: { name: string } | null;
}

interface NumberSuggestion {
  jersey_number: number;
  total_stock: number;
  score?: number;
}

const SEASON_YEAR = 2025;

const JerseyWidget: React.FC = () => {
  // Shopify context (sent from parent page)
  const [shopifyProductId, setShopifyProductId] = useState<string>("");
  const [shopifyVariantId, setShopifyVariantId] = useState<string>("");
  const [selectedSize, setSelectedSize] = useState<string>("");

  // Detected club (from mapping table)
  const [clubId, setClubId] = useState<string>("");
  const [clubName, setClubName] = useState<string>("");

  // Inputs
  const [yearOfBirth, setYearOfBirth] = useState("");
  const [teamOptions, setTeamOptions] = useState<string[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>("I don't know / Not assigned yet");
  const [preferredNumber, setPreferredNumber] = useState("");

  // Results
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [pickedNumber, setPickedNumber] = useState<number | null>(null);

  // UI states
  const [loading, setLoading] = useState(false);
  const [reserving, setReserving] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Hold timer
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = Number.isFinite(yobNum) && yobNum > 1900 && yobNum < 2100;

  // Pull productId from query params (backup - primary is postMessage)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const pid = (params.get("productId") || "").trim();
      if (pid) setShopifyProductId(pid);
    } catch (_) {}
  }, []);

  // Listen for parent -> iframe messages (size pill + variant id)
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      try {
        if (!event?.data) return;
        const data = event.data;

        if (data.type === "h2h:variantChanged") {
          const size = String(data.size || "").trim();
          const variantId = String(data.variantId || "").trim();
          const productId = String(data.productId || "").trim();

          if (productId) setShopifyProductId(productId);
          if (variantId) setShopifyVariantId(variantId);
          setSelectedSize(size);

          // Reset flow when variant/size changes
          setSuggestions([]);
          setPickedNumber(null);
          setStatusMessage("");
          setError(null);
          setExpiresAt(null);

          // Tell parent to re-lock ATC until we re-reserve
          window.parent?.postMessage({ type: "h2h:reservation:cleared" }, "*");
        }
      } catch (_) {}
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Resolve club from mapping table using Shopify productId
  useEffect(() => {
    if (!shopifyProductId) return;

    void (async () => {
      setError(null);
      setStatusMessage("");
      setClubId("");
      setClubName("");

      try {
        const { data, error: mapErr } = await supabase
          .from("shopify_product_club_map")
          .select("shopify_product_id, club_id, clubs(name)")
          .eq("shopify_product_id", shopifyProductId)
          .maybeSingle();

        if (mapErr) {
          setError(mapErr.message);
          return;
        }

        const row = (data as any) as MappingRow | null;
        if (!row?.club_id) {
          setError("Club could not be detected for this product.");
          return;
        }

        setClubId(row.club_id);
        setClubName(row.clubs?.name || "");
      } catch (e: any) {
        setError(e?.message || "Club could not be detected for this product.");
      }
    })();
  }, [shopifyProductId]);

  // Load teams based on club + YOB (best-effort)
  useEffect(() => {
    if (!clubId || !yobValid) {
      setTeamOptions([]);
      setSelectedTeam("I don't know / Not assigned yet");
      return;
    }

    void (async () => {
      try {
        // Best-effort assumption: players table exists (you have Players page)
        // and includes club_id, season_year, year_of_birth, team_name.
        const { data, error: teamErr } = await supabase
          .from("players")
          .select("team_name")
          .eq("club_id", clubId)
          .eq("season_year", SEASON_YEAR)
          .eq("year_of_birth", yobNum);

        if (teamErr) {
          // If columns differ, we still provide the default option
          setTeamOptions([]);
          setSelectedTeam("I don't know / Not assigned yet");
          return;
        }

        const uniqueTeams = Array.from(
          new Set((data ?? []).map((r: any) => String(r.team_name || "").trim()).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b));

        setTeamOptions(uniqueTeams);
        setSelectedTeam("I don't know / Not assigned yet");
      } catch (_) {
        setTeamOptions([]);
        setSelectedTeam("I don't know / Not assigned yet");
      }
    })();
  }, [clubId, yobValid, yobNum]);

  // Countdown + auto-expire hold
  useEffect(() => {
    if (!expiresAt) return;

    const timer = setInterval(() => {
      if (Date.now() >= expiresAt) {
        setPickedNumber(null);
        setExpiresAt(null);
        setStatusMessage("");
        window.parent?.postMessage({ type: "h2h:reservation:cleared" }, "*");
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt]);

  const remainingSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
    : 0;

  const teamSelected = Boolean((selectedTeam || "").trim().length > 0);

  const canCheckSuggest = Boolean(
    clubId && selectedSize && yobValid && teamSelected && !loading && !reserving
  );

  const canConfirmReserve = Boolean(
    clubId && selectedSize && yobValid && teamSelected && pickedNumber !== null && !reserving
  );

  const handleCheckSuggest = async () => {
    setError(null);
    setStatusMessage("");
    setSuggestions([]);
    setPickedNumber(null);

    if (!clubId) {
      setError("Club could not be detected for this product.");
      return;
    }
    if (!selectedSize) {
      setError("Please select a size above.");
      return;
    }
    if (!yobValid) {
      setError("Please enter a valid year of birth.");
      return;
    }
    if (!teamSelected) {
      setError("Please select a team (or choose the Not assigned option).");
      return;
    }

    setLoading(true);
    try {
      // 1) Ranked suggestions
      const ranked = await suggestNumbersForClubRanked({
        clubId,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobNum,
        limit: 10,
      });

      let merged = ranked || [];

      // 2) If preferred number provided, check and (if available) include it
      const pref = Number(preferredNumber);
      const prefValid = Number.isFinite(pref);

      if (prefValid) {
        try {
          const check = await smartCheckNumber({
            clubId,
            jerseyNumber: pref,
            size: selectedSize,
            seasonYear: SEASON_YEAR,
          });

          // If available, ensure it appears at the top
          if (check?.available) {
            merged = [
              { jersey_number: pref, total_stock: check.total_stock ?? 1, score: 9999 },
              ...merged.filter((s) => s.jersey_number !== pref),
            ];
          } else {
            setStatusMessage(
              `Preferred #${pref} is not available in size ${selectedSize}. Pick an alternative below.`
            );
          }
        } catch (_) {
          // If smartCheck fails, we still show ranked suggestions
        }
      }

      // De-dupe and keep order
      const seen = new Set<number>();
      const finalList: NumberSuggestion[] = [];
      for (const s of merged) {
        const n = Number(s.jersey_number);
        if (!Number.isFinite(n) || seen.has(n)) continue;
        seen.add(n);
        finalList.push(s);
      }

      setSuggestions(finalList);

      if (finalList.length === 0) {
        setError("No available numbers found for this size. Try another size or contact the club.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmReserve = async () => {
    setError(null);
    setStatusMessage("");

    if (!clubId) return setError("Club could not be detected for this product.");
    if (!selectedSize) return setError("Please select a size above.");
    if (!yobValid) return setError("Please enter a valid year of birth.");
    if (!teamSelected) return setError("Please select a team (or Not assigned).");
    if (pickedNumber === null) return setError("Please select a suggested number first.");

    setReserving(true);
    try {
      const result = await reserveNumberForPurchase({
        clubId,
        jerseyNumber: pickedNumber,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobNum,
        expiresMinutes: 15,
      });

      if (!result.success) {
        setError(result.message);
        return;
      }

      const expiry = Date.now() + 15 * 60 * 1000;
      setExpiresAt(expiry);

      setStatusMessage(`Jersey #${pickedNumber} reserved. Hold expires in 15:00.`);

      // Tell parent page to unlock Add to Cart + write hidden property
      window.parent?.postMessage(
        { type: "h2h:reservation:ready", jerseyNumber: pickedNumber },
        "*"
      );
    } finally {
      setReserving(false);
    }
  };

  const headerLine = clubName
    ? `${clubName} - Size ${selectedSize || "?"}`
    : `Size ${selectedSize || "?"}`;

  return (
    <div className="max-w-[460px]">
      <div className="mb-3">
        <h3 className="text-base font-semibold text-gray-900">Choose your jersey number</h3>
        <div className="text-xs text-gray-600 mt-1">
          {shopifyProductId ? (
            <span className="font-medium">{headerLine}</span>
          ) : (
            <span className="font-medium">Loading product info…</span>
          )}
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">
          {error}
        </div>
      )}

      {statusMessage && (
        <div className="text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded p-3 mb-3">
          <div>{statusMessage}</div>
          {expiresAt && (
            <div className="text-xs mt-1">
              Hold expires in {Math.floor(remainingSeconds / 60)}:
              {(remainingSeconds % 60).toString().padStart(2, "0")}
            </div>
          )}
        </div>
      )}

      <div className="bg-white border rounded p-4 space-y-3">
        {/* YOB */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Year of birth
          </label>
          <input
            type="number"
            className="border rounded px-3 py-2 w-full"
            placeholder="e.g. 2012"
            value={yearOfBirth}
            onChange={(e) => setYearOfBirth(e.target.value)}
          />
        </div>

        {/* Team */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Team
          </label>
          <select
            className="border rounded px-3 py-2 w-full"
            value={selectedTeam}
            onChange={(e) => setSelectedTeam(e.target.value)}
            disabled={!clubId || !yobValid}
          >
            <option value="I don't know / Not assigned yet">I don't know / Not assigned yet</option>
            {teamOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Team list is suggested from your club and year of birth (if available).
          </p>
        </div>

        {/* Preferred number (optional) */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Preferred number (optional)
          </label>
          <input
            type="number"
            className="border rounded px-3 py-2 w-full"
            placeholder="e.g. 12"
            value={preferredNumber}
            onChange={(e) => setPreferredNumber(e.target.value)}
          />
        </div>

        {/* Check & Suggest */}
        <button
          type="button"
          onClick={handleCheckSuggest}
          disabled={!canCheckSuggest}
          className="w-full px-4 py-2 rounded font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-600"
        >
          {loading ? "Checking…" : "Check & Suggest Playing Numbers"}
        </button>

        {/* Small helper if size missing */}
        {!selectedSize && (
          <div className="text-xs text-gray-600">
            Select a <span className="font-semibold">Size</span> above to continue.
          </div>
        )}
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="mt-4 bg-white border rounded p-4">
          <div className="text-sm font-semibold text-gray-900 mb-2">Available options</div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => {
              const isPicked = pickedNumber === s.jersey_number;
              return (
                <button
                  key={s.jersey_number}
                  type="button"
                  onClick={() => setPickedNumber(s.jersey_number)}
                  className={
                    "px-3 py-2 rounded border text-sm font-semibold " +
                    (isPicked
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-gray-900 border-gray-300 hover:border-indigo-400")
                  }
                >
                  #{s.jersey_number}
                </button>
              );
            })}
          </div>

          {/* Confirm & Reserve */}
          <button
            type="button"
            onClick={handleConfirmReserve}
            disabled={!canConfirmReserve}
            className="mt-4 w-full px-4 py-2 rounded font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-300 disabled:text-gray-600"
          >
            {reserving ? "Reserving…" : "Confirm & Reserve"}
          </button>

          <p className="text-xs text-gray-500 mt-2">
            Reserving holds the number for 15 minutes so you can complete checkout.
          </p>
        </div>
      )}

      {/* Debug (optional) */}
      <div className="mt-3 text-[11px] text-gray-400">
        <div>productId: {shopifyProductId || "-"}</div>
        <div>variantId: {shopifyVariantId || "-"}</div>
        <div>size: {selectedSize || "-"}</div>
      </div>
    </div>
  );
};

export default JerseyWidget;
