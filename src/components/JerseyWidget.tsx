// FILE: src/components/JerseyWidget.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  smartCheckNumber,
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

const JerseyWidget: React.FC = () => {
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

  // Load clubs (demo + Shopify-mapped)
  useEffect(() => {
    const loadClubs = async () => {
      const { data } = await supabase
        .from("clubs")
        .select("id, name, is_client")
        .eq("is_client", true)
        .order("name");

      const list = (data ?? []) as Club[];
      setClubs(list);
      if (list.length > 0) setSelectedClubId(list[0].id);
    };
    loadClubs();
  }, []);

  // Load sizes for club
  useEffect(() => {
    if (!selectedClubId) return;

    const loadSizes = async () => {
      const { data } = await supabase
        .from("inventory")
        .select("size")
        .eq("club_id", selectedClubId)
        .eq("status", "Available");

      const unique = Array.from(
        new Set((data ?? []).map((r: any) => String(r.size)))
      ).sort();

      setSizes(unique);
      setSelectedSize(unique[0] ?? "");
    };

    loadSizes();
  }, [selectedClubId]);

  // Countdown + auto-expire
  useEffect(() => {
    if (!expiresAt) return;

    const timer = setInterval(() => {
      if (Date.now() >= expiresAt) {
        setReservedNumber(null);
        setExpiresAt(null);
        setStatusMessage("");
        window.dispatchEvent(new CustomEvent("h2h:reservation:cleared"));
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt]);

  const remainingSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
    : 0;

  const handleSuggest = async () => {
    setError(null);
    setSuggestions([]);

    if (!selectedClubId || !selectedSize || !yobValid) {
      setError("Please select club, size, and year of birth.");
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
      setStatusMessage(`Jersey #${num} reserved. Hold expires in 15:00.`);

      // 🔥 Tell Shopify Add-to-Cart to unlock
      window.dispatchEvent(
        new CustomEvent("h2h:reservation:ready", {
          detail: { jerseyNumber: num },
        })
      );
    } finally {
      setReserving(false);
    }
  };

  const handleUseSuggestion = (num: number) => {
    setPreferredNumber(String(num));
  };

  return (
    <div style={{ maxWidth: 420 }}>
      <h3 style={{ fontWeight: 600, marginBottom: 8 }}>
        Choose your jersey number
      </h3>

      {error && (
        <div style={{ color: "#b91c1c", marginBottom: 8 }}>{error}</div>
      )}

      {statusMessage && (
        <div
          style={{
            background: "#fff7ed",
            border: "1px solid #fed7aa",
            color: "#9a3412",
            padding: 10,
            borderRadius: 8,
            marginBottom: 10,
          }}
        >
          {statusMessage}
          {expiresAt && (
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Hold expires in {Math.floor(remainingSeconds / 60)}:
              {(remainingSeconds % 60).toString().padStart(2, "0")}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        <input
          type="number"
          placeholder="Year of birth"
          value={yearOfBirth}
          onChange={(e) => setYearOfBirth(e.target.value)}
        />

        <select
          value={selectedSize}
          onChange={(e) => setSelectedSize(e.target.value)}
        >
          {sizes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <input
          type="number"
          placeholder="Preferred number"
          value={preferredNumber}
          onChange={(e) => setPreferredNumber(e.target.value)}
        />

        <button onClick={handleReserve} disabled={reserving}>
          {reserving ? "Reserving…" : "Confirm & Reserve"}
        </button>

        <button onClick={handleSuggest} style={{ fontSize: 13 }}>
          Suggest numbers
        </button>
      </div>

      {suggestions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {suggestions.map((s) => (
            <button
              key={s.jersey_number}
              style={{ marginRight: 6, marginBottom: 6 }}
              onClick={() => handleUseSuggestion(s.jersey_number)}
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
