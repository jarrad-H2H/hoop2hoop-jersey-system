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

const SEASON_YEAR = 2025;

const JerseyWidget: React.FC = () => {
  // ---- Shopify context passed in via iframe query params / postMessage ----
  const [shopifyProductId, setShopifyProductId] = useState<string>("");
  const [selectedSize, setSelectedSize] = useState<string>("");

  // ---- Club detection (via mapping table) ----
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [clubDetectError, setClubDetectError] = useState<string | null>(null);

  // ---- Inputs ----
  const [yearOfBirth, setYearOfBirth] = useState<string>("");
  const [teamChoice, setTeamChoice] = useState<string>(""); // required (including "not sure")
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

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = Number.isFinite(yobNum) && yobNum >= 1900 && yobNum <= 2100;

  const remainingSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - tick) / 1000))
    : 0;

  const sizeSelected = Boolean((selectedSize || "").trim());

  // Require Team dropdown selection (including the "not sure" option)
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
      // Shopify iframe usage
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type, ...(payload || {}) }, "*");
      }
      // Admin demo usage (same window)
      window.dispatchEvent(new CustomEvent(type, { detail: payload || {} }));
    } catch (_) {
      // no-op
    }
  };

  // ---- 1) Read initial query params (best-effort) ----
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const pid = (params.get("productId") || params.get("product_id") || "").trim();
      if (pid) setShopifyProductId(pid);
    } catch (_) {
      // ignore
    }

    // Default Team dropdown option (required)
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

          // If user changes size after suggestions were loaded, reset downstream selections.
          setSuggestions([]);
          setSelectedNumber(null);
          setError(null);
        }

        // If your widget.js is later updated to pass productId too, we’ll accept it.
        const pid = (data.productId || data.product_id || "").toString().trim();
        if (pid) setShopifyProductId(pid);
      } catch (_) {
        // ignore
      }
    };

    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // ---- 3) Detect club via mapping table: shopify_product_club_map ----
  useEffect(() => {
    const run = async () => {
      setClubDetectError(null);
      setSelectedClubId("");

      const pid = (shopifyProductId || "").trim();
      if (!pid) {
        // Don’t throw hard error yet - the size pill message often arrives first.
        return;
      }

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

  // ---- 4) Countdown tick ----
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  // ---- 5) Auto-expire reservation ----
  useEffect(() => {
    if (!expiresAt) return;

    const timer = setInterval(() => {
      if (Date.now() >= expiresAt) {
        setExpiresAt(null);
        setStatusMessage("");
        setSelectedNumber(null);
        notifyShopify("h2h:reservation:cleared");
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt]);

  // ---- Helpers ----
  const clearMessages = () => {
    setError(null);
    setStatusMessage("");
  };

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
        // team is not enforced in allocation logic yet - captured for future improvements
      });

      // Optional: if preferred number entered, check it and float it to the top if valid
      const pref = Number(preferredNumber);
      if (Number.isFinite(pref)) {
        try {
          const check = await smartCheckNumber({
            clubId: selectedClubId,
            size: selectedSize,
            seasonYear: SEASON_YEAR,
            jerseyNumber: pref,
            yearOfBirth: yobNum,
          });

          // If smartCheck says "available", add it to the front if it isn't already present
          if ((check as any)?.ok === true || (check as any)?.available === true) {
            const exists = ranked.some((r: any) => r.jersey_number === pref);
            const boosted: NumberSuggestion[] = exists
              ? ranked
              : [{ jersey_number: pref, total_stock: 1, score: 999 }, ...ranked];
            setSuggestions(boosted);
          } else {
            setSuggestions(ranked);
          }
        } catch (_) {
          // If smartCheck fails, just show ranked list
          setSuggestions(ranked);
        }
      } else {
        setSuggestions(ranked);
      }

      if (!ranked || ranked.length === 0) {
        setError(
          "No available numbers found for this size. Try another size or contact the club."
        );
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
      const result = await reserveNumberForPurchase({
        clubId: selectedClubId,
        jerseyNumber: selectedNumber,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobNum,
        expiresMinutes: 15,
      });

      if (!result.success) {
        setError(result.message || "Could not reserve that number.");
        return;
      }

      const expiry = Date.now() + 15 * 60 * 1000;
      setExpiresAt(expiry);

      // Put the success message at the bottom near the buttons (as requested)
      setStatusMessage(`Jersey #${selectedNumber} reserved. Hold expires in 15:00.`);

      // IMPORTANT: tell Shopify parent page to unlock Add to cart
      notifyShopify("h2h:reservation:ready", { jerseyNumber: selectedNumber });
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

      {/* Errors */}
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">
          {error}
        </div>
      )}

      {/* Club detect issues (soft display) */}
      {clubDetectError && !selectedClubId && (
        <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-3 mb-3">
          {clubDetectError}
          {!shopifyProductId && (
            <div className="mt-1">
              (Waiting for product context from Shopify.)
            </div>
          )}
        </div>
      )}

      <div className="bg-white border rounded p-4 space-y-3">
        {/* Size (read-only indicator, comes from Shopify size pills) */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Size
          </label>
          <div className="border rounded px-3 py-2 text-sm bg-gray-50">
            {sizeSelected ? selectedSize : "Select a size above to continue"}
          </div>
        </div>

        {/* YOB */}
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
        </div>

        {/* Team dropdown (placeholder for now - we’ll wire it to real teams next) */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Team
          </label>
          <select
            className="border rounded px-3 py-2 w-full"
            value={teamChoice}
            onChange={(e) => setTeamChoice(e.target.value)}
          >
            <option value="">Select a team</option>
            <option value="not_sure">I don&apos;t know / Not assigned yet</option>
          </select>
        </div>

        {/* Preferred number (optional) - ABOVE suggest button */}
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

        {/* Suggest button */}
        <button
          type="button"
          onClick={handleSuggest}
          disabled={!canSuggest}
          className="w-full px-4 py-2 rounded font-semibold text-sm bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-600"
        >
          {loadingSuggest ? "Checking…" : "Check & Suggest Playing Numbers"}
        </button>

        {/* Suggested numbers */}
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

        {/* Confirm button (bottom, only meaningful once a number is selected) */}
        <button
          type="button"
          onClick={handleReserve}
          disabled={!canConfirm}
          className="w-full px-4 py-2 rounded font-semibold text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-300 disabled:text-gray-600"
        >
          {reserving ? "Reserving…" : "Confirm & Reserve"}
        </button>

        {/* Status message at the BOTTOM near actions (as requested) */}
        {statusMessage && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded text-sm">
            <div>{statusMessage}</div>
            {expiresAt && (
              <div className="text-xs mt-1">
                Hold expires in {Math.floor(remainingSeconds / 60)}:
                {(remainingSeconds % 60).toString().padStart(2, "0")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default JerseyWidget;
