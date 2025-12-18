// FILE: src/components/JerseyWidget.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  suggestNumbersForClubRanked,
  reserveNumberForPurchase,
} from "../services/allocation";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface NumberSuggestion {
  jersey_number: number;
  total_stock: number;
  score?: number;
}

const SEASON_YEAR = 2025;

function getQueryParam(name: string): string {
  try {
    const url = new URL(window.location.href);
    return (url.searchParams.get(name) || "").trim();
  } catch {
    return "";
  }
}

const JerseyWidget: React.FC = () => {
  // If loaded in Shopify iframe, we pass ?club=... (from public/widget.js)
  const clubFromUrl = useMemo(() => getQueryParam("club"), []);
  const isEmbed = useMemo(() => {
    // Embed route is /embed/widget-demo (or similar)
    return window.location.pathname.includes("/embed/");
  }, []);

  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  const [sizes, setSizes] = useState<string[]>([]);
  const [selectedSize, setSelectedSize] = useState<string>("");

  const [yearOfBirth, setYearOfBirth] = useState("");
  const [preferredNumber, setPreferredNumber] = useState("");

  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [reserving, setReserving] = useState(false);
  const [reservedNumber, setReservedNumber] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = Number.isFinite(yobNum) && yobNum > 1900;

  // Styles (so embed looks decent even without Tailwind/Layout)
  const ui = {
    wrap: {
      maxWidth: 520,
      fontFamily:
        'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
      color: "#111827",
    } as React.CSSProperties,
    title: { fontWeight: 700, fontSize: 16, marginBottom: 10 } as React.CSSProperties,
    helper: { fontSize: 12, color: "#6b7280", marginTop: 4 } as React.CSSProperties,
    error: {
      color: "#b91c1c",
      background: "#fef2f2",
      border: "1px solid #fecaca",
      padding: "10px 12px",
      borderRadius: 10,
      marginBottom: 10,
      fontSize: 13,
    } as React.CSSProperties,
    status: {
      background: "#fff7ed",
      border: "1px solid #fed7aa",
      color: "#9a3412",
      padding: "10px 12px",
      borderRadius: 10,
      marginBottom: 10,
      fontSize: 13,
      lineHeight: 1.35,
    } as React.CSSProperties,
    grid: { display: "grid", gap: 10 } as React.CSSProperties,
    label: { fontSize: 12, fontWeight: 600, color: "#374151" } as React.CSSProperties,
    input: {
      width: "100%",
      padding: "10px 12px",
      borderRadius: 10,
      border: "1px solid #d1d5db",
      fontSize: 14,
      outline: "none",
      background: "#ffffff",
    } as React.CSSProperties,
    select: {
      width: "100%",
      padding: "10px 12px",
      borderRadius: 10,
      border: "1px solid #d1d5db",
      fontSize: 14,
      background: "#ffffff",
    } as React.CSSProperties,
    btnPrimary: {
      width: "100%",
      padding: "12px 14px",
      borderRadius: 12,
      border: "1px solid #111827",
      background: "#111827",
      color: "#ffffff",
      fontWeight: 700,
      fontSize: 14,
      cursor: "pointer",
    } as React.CSSProperties,
    btnSecondary: {
      width: "100%",
      padding: "10px 14px",
      borderRadius: 12,
      border: "1px solid #d1d5db",
      background: "#ffffff",
      color: "#111827",
      fontWeight: 700,
      fontSize: 13,
      cursor: "pointer",
    } as React.CSSProperties,
    pillRow: { marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 } as React.CSSProperties,
    pill: {
      padding: "8px 10px",
      borderRadius: 999,
      border: "1px solid #d1d5db",
      background: "#ffffff",
      fontSize: 13,
      cursor: "pointer",
    } as React.CSSProperties,
  };

  // Load clubs
  useEffect(() => {
    const loadClubs = async () => {
      const { data, error } = await supabase
        .from("clubs")
        .select("id, name, is_client")
        .eq("is_client", true)
        .order("name");

      if (error) {
        setError("Unable to load clubs.");
        return;
      }

      const list = (data ?? []) as Club[];
      setClubs(list);

      // Auto-select club in embed by matching club name (case-insensitive)
      if (list.length > 0) {
        if (clubFromUrl) {
          const match = list.find(
            (c) => c.name.trim().toLowerCase() === clubFromUrl.trim().toLowerCase()
          );
          setSelectedClubId(match?.id ?? list[0].id);
        } else {
          setSelectedClubId(list[0].id);
        }
      }
    };

    void loadClubs();
  }, [clubFromUrl]);

  // Load sizes for club
  useEffect(() => {
    if (!selectedClubId) return;

    const loadSizes = async () => {
      setError(null);

      const { data, error } = await supabase
        .from("inventory")
        .select("size")
        .eq("club_id", selectedClubId)
        .eq("status", "Available");

      if (error) {
        setSizes([]);
        setSelectedSize("");
        setError("Unable to load available sizes for this club.");
        return;
      }

      const unique = Array.from(
        new Set((data ?? []).map((r: any) => String(r.size)))
      ).sort();

      setSizes(unique);
      setSelectedSize(unique[0] ?? "");
    };

    void loadSizes();
  }, [selectedClubId]);

  // Countdown + auto-expire
  useEffect(() => {
    if (!expiresAt) return;

    const timer = setInterval(() => {
      if (Date.now() >= expiresAt) {
        setReservedNumber(null);
        setExpiresAt(null);
        setStatusMessage("");

        // Tell parent (Shopify) to re-lock ATC
        try {
          window.parent?.postMessage({ type: "h2h:reservation:cleared" }, "*");
        } catch (_) {}
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt]);

  const remainingSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
    : 0;

  const selectedClubName =
    clubs.find((c) => c.id === selectedClubId)?.name ?? "";

  const handleSuggest = async () => {
    setError(null);
    setSuggestions([]);

    if (!selectedClubId || !selectedSize || !yobValid) {
      setError("Please select a size and enter year of birth.");
      return;
    }

    const ranked = await suggestNumbersForClubRanked({
      clubId: selectedClubId,
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

    if (!selectedClubId || !selectedSize || !yobValid) {
      setError("Please select a size and enter year of birth.");
      return;
    }

    const num = Number(preferredNumber);
    if (!Number.isFinite(num)) {
      setError("Please enter a valid preferred number.");
      return;
    }

    setReserving(true);
    try {
      const result = await reserveNumberForPurchase({
        clubId: selectedClubId,
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
      setStatusMessage(`Jersey #${num} reserved.`);

      // Tell parent (Shopify) to unlock ATC + set hidden property
      try {
        window.parent?.postMessage(
          { type: "h2h:reservation:ready", jerseyNumber: num },
          "*"
        );
      } catch (_) {}
    } finally {
      setReserving(false);
    }
  };

  const handleUseSuggestion = (num: number) => {
    setPreferredNumber(String(num));
  };

  return (
    <div style={ui.wrap}>
      <div style={ui.title}>Choose your jersey number</div>

      {/* Show club name in embed (read-only) */}
      {isEmbed && selectedClubName && (
        <div style={{ marginBottom: 10 }}>
          <div style={ui.label}>Club</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{selectedClubName}</div>
        </div>
      )}

      {/* Keep club selector in admin demo (non-embed) */}
      {!isEmbed && (
        <div style={{ marginBottom: 10 }}>
          <div style={ui.label}>Club</div>
          <select
            style={ui.select}
            value={selectedClubId}
            onChange={(e) => setSelectedClubId(e.target.value)}
          >
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && <div style={ui.error}>{error}</div>}

      {statusMessage && (
        <div style={ui.status}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{statusMessage}</div>
          {reservedNumber !== null && (
            <div style={{ fontSize: 13 }}>
              Reserved number: <b>#{reservedNumber}</b>
            </div>
          )}
          {expiresAt && (
            <div style={{ fontSize: 12, marginTop: 6 }}>
              Hold expires in {Math.floor(remainingSeconds / 60)}:
              {(remainingSeconds % 60).toString().padStart(2, "0")}
            </div>
          )}
        </div>
      )}

      <div style={ui.grid}>
        <div>
          <div style={ui.label}>Year of birth</div>
          <input
            style={ui.input}
            type="number"
            inputMode="numeric"
            placeholder="e.g. 2013"
            value={yearOfBirth}
            onChange={(e) => setYearOfBirth(e.target.value)}
          />
        </div>

        <div>
          <div style={ui.label}>Size</div>
          <select
            style={ui.select}
            value={selectedSize}
            onChange={(e) => setSelectedSize(e.target.value)}
          >
            {sizes.length === 0 ? (
              <option value="">No sizes available</option>
            ) : (
              sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))
            )}
          </select>
          <div style={ui.helper}>Only sizes currently in stock are shown.</div>
        </div>

        <div>
          <div style={ui.label}>Preferred number</div>
          <input
            style={ui.input}
            type="number"
            inputMode="numeric"
            placeholder="e.g. 23"
            value={preferredNumber}
            onChange={(e) => setPreferredNumber(e.target.value)}
          />
        </div>

        <button
          onClick={handleReserve}
          disabled={reserving}
          style={{
            ...ui.btnPrimary,
            opacity: reserving ? 0.7 : 1,
            cursor: reserving ? "not-allowed" : "pointer",
          }}
        >
          {reserving ? "Reserving…" : "Confirm & Reserve"}
        </button>

        <button onClick={handleSuggest} style={ui.btnSecondary}>
          Suggest numbers
        </button>
      </div>

      {suggestions.length > 0 && (
        <div style={ui.pillRow}>
          {suggestions.map((s) => (
            <button
              key={s.jersey_number}
              style={ui.pill}
              onClick={() => handleUseSuggestion(s.jersey_number)}
              type="button"
            >
              #{s.jersey_number}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default JerseyWidget;
