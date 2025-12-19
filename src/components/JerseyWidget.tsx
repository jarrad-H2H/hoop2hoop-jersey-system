import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { suggestNumbersForClubRanked, reserveNumberForPurchase } from "../services/allocation";

interface Club {
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
  // Shopify-provided state (from public/widget.js postMessage)
  const [shopifyProductId, setShopifyProductId] = useState<string>("");
  const [selectedSize, setSelectedSize] = useState<string>("");
  const [variantId, setVariantId] = useState<string>("");

  // Detected club from mapping table
  const [clubId, setClubId] = useState<string>("");
  const [clubName, setClubName] = useState<string>("");

  // Inputs
  const [yearOfBirth, setYearOfBirth] = useState("");
  const [preferredNumber, setPreferredNumber] = useState("");
  const [teamChoice, setTeamChoice] = useState("Not sure / Not assigned yet"); // UI placeholder for now
  const [teamText, setTeamText] = useState(""); // optional free text fallback

  // Results / state
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [reserving, setReserving] = useState(false);

  const [reservedNumber, setReservedNumber] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = Number.isFinite(yobNum) && yobNum > 1900;

  // Listen for Shopify -> widget messages
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      try {
        const data: any = event?.data;
        if (!data || data.type !== "h2h:variantChanged") return;

        if (typeof data.productId === "string" && data.productId.trim()) {
          setShopifyProductId(data.productId.trim());
        }
        if (typeof data.size === "string") {
          setSelectedSize(data.size.trim());
        }
        if (typeof data.variantId === "string") {
          setVariantId(data.variantId.trim());
        }
      } catch (_) {}
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Detect club from product mapping
  useEffect(() => {
    if (!shopifyProductId) return;

    const detect = async () => {
      setError(null);
      setClubId("");
      setClubName("");

      const { data, error } = await supabase
        .from("shopify_product_club_map")
        .select("club_id")
        .eq("shopify_product_id", shopifyProductId)
        .maybeSingle();

      if (error) {
        setError("Could not read product mapping (Supabase permissions issue).");
        return;
      }

      if (!data?.club_id) {
        setError(
          "Club could not be detected for this product. Admin: go to /admin/product-mapping and map this product to a club."
        );
        return;
      }

      const detectedClubId = String(data.club_id);
      setClubId(detectedClubId);

      const { data: clubData } = await supabase
        .from("clubs")
        .select("id, name")
        .eq("id", detectedClubId)
        .maybeSingle();

      if (clubData?.name) setClubName(String(clubData.name));
    };

    void detect();
  }, [shopifyProductId]);

  // Countdown + auto-expire (and tell Shopify to re-lock)
  useEffect(() => {
    if (!expiresAt) return;

    const timer = setInterval(() => {
      if (Date.now() >= expiresAt) {
        setReservedNumber(null);
        setExpiresAt(null);
        setStatusMessage("");
        try {
          window.parent?.postMessage({ type: "h2h:reservation:cleared" }, "*");
        } catch (_) {}
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt]);

  const remainingSeconds = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;

  const handleCheckAndSuggest = async () => {
    setError(null);
    setStatusMessage("");
    setSuggestions([]);

    if (!clubId) {
      setError("Club could not be detected for this product.");
      return;
    }
    if (!selectedSize) {
      setError("Please select a size above (Shopify size option).");
      return;
    }
    if (!yobValid) {
      setError("Please enter a valid year of birth.");
      return;
    }

    setChecking(true);
    try {
      const ranked = await suggestNumbersForClubRanked({
        clubId,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobNum,
        limit: 10,
      });

      setSuggestions(ranked || []);

      // If they haven't entered a preferred number, auto-fill the top suggestion
      if ((!preferredNumber || !preferredNumber.trim()) && ranked && ranked.length > 0) {
        setPreferredNumber(String(ranked[0].jersey_number));
      }

      // If preferred number was entered but not in suggestions, still allow reserve attempt - reserve will validate
      setStatusMessage("Suggestions loaded. Choose a number then confirm and reserve.");
    } catch (e: any) {
      setError("Could not fetch suggestions.");
    } finally {
      setChecking(false);
    }
  };

  const handleReserve = async () => {
    setError(null);
    setStatusMessage("");

    if (!clubId || !selectedSize || !yobValid) {
      setError("Missing required information.");
      return;
    }

    const num = Number(preferredNumber);
    if (!Number.isFinite(num)) {
      setError("Please choose a valid jersey number.");
      return;
    }

    setReserving(true);
    try {
      const result = await reserveNumberForPurchase({
        clubId,
        jerseyNumber: num,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobNum,
        expiresMinutes: 15,
        // Note: team is not currently used by service; we collect it now for later enhancement.
      });

      if (!result.success) {
        setError(result.message || "Could not reserve that number.");
        return;
      }

      const expiry = Date.now() + 15 * 60 * 1000;

      setReservedNumber(num);
      setExpiresAt(expiry);
      setStatusMessage(`Jersey #${num} reserved. Hold expires in 15:00.`);

      // Tell Shopify page to unlock ATC and set hidden property via public/widget.js
      try {
        window.parent?.postMessage({ type: "h2h:reservation:ready", jerseyNumber: num }, "*");
      } catch (_) {}
    } finally {
      setReserving(false);
    }
  };

  const handleUseSuggestion = (num: number) => {
    setPreferredNumber(String(num));
  };

  const showConfirm = suggestions.length > 0;

  return (
    <div className="max-w-[520px]">
      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <div className="mb-3">
          <div className="text-lg font-semibold">Choose your jersey number</div>
          <div className="text-xs text-gray-600 mt-1">
            {clubName ? (
              <span>
                Club: <span className="font-semibold">{clubName}</span>
              </span>
            ) : (
              <span className="text-gray-500">Detecting club…</span>
            )}
            {selectedSize ? (
              <span className="ml-3">
                Size: <span className="font-semibold">{selectedSize}</span>
              </span>
            ) : (
              <span className="ml-3 text-gray-500">Size: not selected</span>
            )}
          </div>
          {/* optional debug */}
          <div className="text-[11px] text-gray-400 mt-1">
            ProductId: {shopifyProductId || "?"} | VariantId: {variantId || "?"}
          </div>
        </div>

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-3">
            {error}
          </div>
        )}

        {statusMessage && (
          <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded p-3 mb-3">
            {statusMessage}
            {expiresAt && (
              <div className="text-xs text-amber-900 mt-1">
                Hold expires in {Math.floor(remainingSeconds / 60)}:
                {(remainingSeconds % 60).toString().padStart(2, "0")}
              </div>
            )}
          </div>
        )}

        <div className="grid gap-3">
          {/* Team capture (basic for now - we can upgrade to real options later) */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Team</label>
            <select
              className="border rounded px-3 py-2 w-full"
              value={teamChoice}
              onChange={(e) => setTeamChoice(e.target.value)}
            >
              <option>Not sure / Not assigned yet</option>
            </select>
            <input
              className="border rounded px-3 py-2 w-full mt-2"
              placeholder="Optional: type your team name if you know it"
              value={teamText}
              onChange={(e) => setTeamText(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Year of birth
            </label>
            <input
              className="border rounded px-3 py-2 w-full"
              type="number"
              placeholder="e.g. 2014"
              value={yearOfBirth}
              onChange={(e) => setYearOfBirth(e.target.value)}
            />
          </div>

          <button
            type="button"
            onClick={handleCheckAndSuggest}
            disabled={checking}
            className="w-full px-4 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-400"
          >
            {checking ? "Checking…" : "Check & Suggest Playing Numbers"}
          </button>

          {suggestions.length > 0 && (
            <div className="mt-1">
              <div className="text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
                Suggested numbers
              </div>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s.jersey_number}
                    type="button"
                    onClick={() => handleUseSuggestion(s.jersey_number)}
                    className="px-3 py-2 rounded border bg-white hover:bg-gray-50 text-sm"
                  >
                    #{s.jersey_number}
                  </button>
                ))}
              </div>
            </div>
          )}

          {showConfirm && (
            <div className="mt-2">
              <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
                Chosen number
              </label>
              <input
                className="border rounded px-3 py-2 w-full"
                type="number"
                placeholder="Enter number"
                value={preferredNumber}
                onChange={(e) => setPreferredNumber(e.target.value)}
              />

              <button
                type="button"
                onClick={handleReserve}
                disabled={reserving}
                className="w-full mt-3 px-4 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-400"
              >
                {reserving ? "Reserving…" : "Confirm & Reserve"}
              </button>
            </div>
          )}

          {reservedNumber !== null && (
            <div className="text-xs text-gray-600 mt-2">
              Reserved: <span className="font-semibold">#{reservedNumber}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default JerseyWidget;
