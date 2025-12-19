// FILE: src/components/JerseyWidget.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  suggestNumbersForClubRanked,
  reserveNumberForPurchase,
} from "../services/allocation";

interface ClubMapRow {
  club_id: string;
}

interface NumberSuggestion {
  jersey_number: number;
  total_stock: number;
  score?: number;
}

const SEASON_YEAR = 2025;

const JerseyWidget: React.FC = () => {
  // Club detection via mapping table
  const [shopifyProductId, setShopifyProductId] = useState<string>("");
  const [clubId, setClubId] = useState<string>("");
  const [clubDetectError, setClubDetectError] = useState<string | null>(null);

  // Size comes from Shopify size pills (postMessage)
  const [selectedSize, setSelectedSize] = useState<string>("");

  // Inputs
  const [yearOfBirth, setYearOfBirth] = useState("");
  const [preferredNumber, setPreferredNumber] = useState("");

  // UI state
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [reserving, setReserving] = useState(false);
  const [reservedNumber, setReservedNumber] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = Number.isFinite(yobNum) && yobNum > 1900;

  // Read productId from iframe URL query (?productId=...)
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const pid = (url.searchParams.get("productId") || "").trim();
      setShopifyProductId(pid);
    } catch (_) {}
  }, []);

  // Lookup club_id from shopify_product_club_map
  useEffect(() => {
    if (!shopifyProductId) {
      setClubDetectError("Missing Shopify product id.");
      setClubId("");
      return;
    }

    void (async () => {
      setClubDetectError(null);
      setClubId("");

      const { data, error } = await supabase
        .from("shopify_product_club_map")
        .select("club_id")
        .eq("shopify_product_id", shopifyProductId)
        .maybeSingle();

      if (error) {
        setClubDetectError(error.message);
        return;
      }

      const row = data as ClubMapRow | null;
      if (!row?.club_id) {
        setClubDetectError("Club could not be detected for this product. Please add a mapping in admin.");
        return;
      }

      setClubId(row.club_id);
    })();
  }, [shopifyProductId]);

  // Listen for Shopify -> widget messages (size pill changes)
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      try {
        const data: any = event?.data;
        if (!data || data.type !== "h2h:variantChanged") return;

        const size = String(data.size || "").trim();
        if (size) setSelectedSize(size);
      } catch (_) {}
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Countdown + auto-expire
  useEffect(() => {
    if (!expiresAt) return;

    const timer = setInterval(() => {
      if (Date.now() >= expiresAt) {
        setReservedNumber(null);
        setExpiresAt(null);
        setStatusMessage("");
        setSuggestions([]);
        // Tell parent (Shopify) to re-lock add to cart
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: "h2h:reservation:cleared" }, "*");
        } else {
          window.dispatchEvent(new CustomEvent("h2h:reservation:cleared"));
        }
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt]);

  const remainingSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
    : 0;

  const canCheckSuggest = Boolean(clubId && selectedSize && yobValid);
  const canReserve = Boolean(canCheckSuggest && Number.isFinite(Number(preferredNumber)));

  const handleSuggest = async () => {
    setError(null);
    setSuggestions([]);
    setStatusMessage("");

    if (!clubId) {
      setError("Club could not be detected for this product.");
      return;
    }
    if (!selectedSize) {
      setError("Please select a size on the product first.");
      return;
    }
    if (!yobValid) {
      setError("Please enter a valid year of birth.");
      return;
    }

    const ranked = await suggestNumbersForClubRanked({
      clubId,
      size: selectedSize,
      seasonYear: SEASON_YEAR,
      yearOfBirth: yobNum,
      limit: 10,
    });

    setSuggestions(ranked);
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
      setError("Invalid jersey number.");
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
      });

      if (!result.success) {
        setError(result.message);
        return;
      }

      const expiry = Date.now() + 15 * 60 * 1000;

      setReservedNumber(num);
      setExpiresAt(expiry);
      setStatusMessage(`Jersey #${num} reserved. Hold expires in 15:00.`);

      // ✅ Tell Shopify to unlock + populate hidden property
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: "h2h:reservation:ready", jerseyNumber: num },
          "*"
        );
      } else {
        window.dispatchEvent(
          new CustomEvent("h2h:reservation:ready", { detail: { jerseyNumber: num } })
        );
      }
    } finally {
      setReserving(false);
    }
  };

  return (
    <div
      style={{
        maxWidth: 520,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: 14,
        background: "white",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h3 style={{ fontWeight: 700, fontSize: 16, margin: 0 }}>Choose your jersey number</h3>
        {selectedSize ? (
          <span style={{ fontSize: 12, color: "#374151" }}>
            Size: <b>{selectedSize}</b>
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#6b7280" }}>Select a size above</span>
        )}
      </div>

      {clubDetectError && (
        <div style={{ marginTop: 10, color: "#b91c1c", fontSize: 13 }}>
          {clubDetectError}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, color: "#b91c1c", fontSize: 13 }}>
          {error}
        </div>
      )}

      {statusMessage && (
        <div
          style={{
            marginTop: 10,
            background: "#fff7ed",
            border: "1px solid #fed7aa",
            color: "#9a3412",
            padding: 10,
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          <div>{statusMessage}</div>
          {expiresAt && (
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Hold expires in {Math.floor(remainingSeconds / 60)}:
              {(remainingSeconds % 60).toString().padStart(2, "0")}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#374151" }}>
            Year of birth
          </div>
          <input
            type="number"
            inputMode="numeric"
            placeholder="e.g. 2012"
            value={yearOfBirth}
            onChange={(e) => setYearOfBirth(e.target.value)}
            style={{
              width: "100%",
              border: "1px solid #d1d5db",
              borderRadius: 10,
              padding: "10px 12px",
              fontSize: 14,
            }}
          />
        </div>

        <button
          type="button"
          onClick={handleSuggest}
          disabled={!canCheckSuggest}
          style={{
            width: "100%",
            borderRadius: 10,
            padding: "10px 12px",
            fontWeight: 700,
            border: "1px solid #111827",
            background: canCheckSuggest ? "#111827" : "#e5e7eb",
            color: canCheckSuggest ? "white" : "#6b7280",
            cursor: canCheckSuggest ? "pointer" : "not-allowed",
          }}
        >
          Check & Suggest Playing Numbers
        </button>

        {suggestions.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: "#374151" }}>
              Available suggestions
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {suggestions.map((s) => (
                <button
                  key={s.jersey_number}
                  type="button"
                  onClick={() => setPreferredNumber(String(s.jersey_number))}
                  style={{
                    border: "1px solid #d1d5db",
                    borderRadius: 999,
                    padding: "8px 10px",
                    fontSize: 13,
                    background: preferredNumber === String(s.jersey_number) ? "#111827" : "white",
                    color: preferredNumber === String(s.jersey_number) ? "white" : "#111827",
                    cursor: "pointer",
                  }}
                >
                  #{s.jersey_number}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#374151" }}>
            Preferred number
          </div>
          <input
            type="number"
            inputMode="numeric"
            placeholder="Type a number or tap a suggestion"
            value={preferredNumber}
            onChange={(e) => setPreferredNumber(e.target.value)}
            style={{
              width: "100%",
              border: "1px solid #d1d5db",
              borderRadius: 10,
              padding: "10px 12px",
              fontSize: 14,
            }}
          />
        </div>

        <button
          type="button"
          onClick={handleReserve}
          disabled={!canReserve || reserving}
          style={{
            width: "100%",
            borderRadius: 10,
            padding: "10px 12px",
            fontWeight: 800,
            border: "1px solid #2563eb",
            background: canReserve && !reserving ? "#2563eb" : "#e5e7eb",
            color: canReserve && !reserving ? "white" : "#6b7280",
            cursor: canReserve && !reserving ? "pointer" : "not-allowed",
          }}
        >
          {reserving ? "Reserving…" : "Confirm & Reserve"}
        </button>

        {reservedNumber !== null && (
          <div style={{ fontSize: 12, color: "#374151" }}>
            Reserved: <b>#{reservedNumber}</b>
          </div>
        )}
      </div>
    </div>
  );
};

export default JerseyWidget;
