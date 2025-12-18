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

function getQueryParam(name: string): string {
  try {
    const url = new URL(window.location.href);
    return (url.searchParams.get(name) || "").trim();
  } catch {
    return "";
  }
}

const JerseyWidget: React.FC = () => {
  const clubFromUrl = useMemo(() => getQueryParam("club"), []);
  const isEmbed = useMemo(() => window.location.pathname.includes("/embed/"), []);

  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  // Size must come from Shopify
  const [selectedSize, setSelectedSize] = useState<string>("");

  const [yearOfBirth, setYearOfBirth] = useState("");
  const [preferredNumber, setPreferredNumber] = useState("");

  const [teamOptions, setTeamOptions] = useState<string[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>("Not sure / not assigned yet");

  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [pickedNumber, setPickedNumber] = useState<number | null>(null);

  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [reserving, setReserving] = useState(false);

  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [reservedNumber, setReservedNumber] = useState<number | null>(null);

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = Number.isFinite(yobNum) && yobNum > 1900;

  const ui = {
    wrap: {
      maxWidth: 560,
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
    pillActive: {
      border: "1px solid #111827",
      background: "#111827",
      color: "#ffffff",
    } as React.CSSProperties,
  };

  const selectedClubName =
    clubs.find((c) => c.id === selectedClubId)?.name ?? "";

  // 1) Load clubs and auto-select from ?club=
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

  // 2) Listen for Shopify variant/size updates (sent from public/widget.js)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      try {
        const data: any = event?.data;
        if (!data || data.type !== "h2h:variantChanged") return;

        const size = String(data.size || "").trim();
        setSelectedSize(size);

        // Changing size should clear suggestions/selection
        setSuggestions([]);
        setPickedNumber(null);
        setError(null);
      } catch (_) {}
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // 3) Team dropdown (optional) - attempts to load based on club + YOB
  useEffect(() => {
    const loadTeams = async () => {
      setTeamOptions([]);

      if (!selectedClubId || !yobValid) return;

      // Best-effort: if you have a players table with team_name, this will work.
      // If not, it fails silently and the dropdown still shows "Not sure".
      try {
        const { data, error } = await supabase
          .from("players")
          .select("team_name")
          .eq("club_id", selectedClubId)
          .eq("season_year", SEASON_YEAR)
          .eq("year_of_birth", yobNum);

        if (error) return;

        const unique = Array.from(
          new Set((data ?? []).map((r: any) => String(r.team_name || "").trim()).filter(Boolean))
        ).sort();

        setTeamOptions(unique);
      } catch (_) {
        // ignore
      }
    };

    void loadTeams();
  }, [selectedClubId, yobValid, yobNum]);

  // Countdown + auto-expire (reservation hold)
  useEffect(() => {
    if (!expiresAt) return;

    const timer = setInterval(() => {
      if (Date.now() >= expiresAt) {
        setReservedNumber(null);
        setExpiresAt(null);
        setStatusMessage("");
        setPickedNumber(null);

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

  // Single primary action: check availability + suggest
  const handleCheckAndSuggest = async () => {
    setError(null);
    setStatusMessage("");
    setSuggestions([]);
    setPickedNumber(null);

    if (!selectedClubId) {
      setError("Club could not be detected for this product.");
      return;
    }

    if (!selectedSize) {
      setError("Please select a size above first.");
      return;
    }

    if (!yobValid) {
      setError("Please enter a valid year of birth.");
      return;
    }

    setChecking(true);
    try {
      // 1) Suggestions (based on club + size + YOB)
      const ranked = await suggestNumbersForClubRanked({
        clubId: selectedClubId,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobNum,
        limit: 10,
      });

      setSuggestions(ranked);

      // 2) If user typed a preferred number, check it and auto-pick if available
      const pref = Number(preferredNumber);
      if (Number.isFinite(pref)) {
        const check = await smartCheckNumber({
          clubId: selectedClubId,
          jerseyNumber: pref,
          size: selectedSize,
          seasonYear: SEASON_YEAR,
          yearOfBirth: yobNum,
        });

        if (check.available) {
          setPickedNumber(pref);
          setStatusMessage(`Nice - #${pref} is available for size ${selectedSize}.`);
          return;
        }

        // Not available: auto pick best suggestion if we have any
        if (ranked.length > 0) {
          setPickedNumber(ranked[0].jersey_number);
          setStatusMessage(
            `#${pref} is not available. We picked the best available option: #${ranked[0].jersey_number}.`
          );
          return;
        }

        setStatusMessage(`#${pref} is not available and there are no suggestions for this size.`);
        return;
      }

      // If no preferred number entered, just show suggestions
      if (ranked.length === 0) {
        setStatusMessage("No numbers available for this club/size combination.");
      } else {
        setStatusMessage("Select a number below, then confirm to reserve.");
      }
    } finally {
      setChecking(false);
    }
  };

  const handleReserve = async () => {
    setError(null);
    setStatusMessage("");

    if (!selectedClubId || !selectedSize || !yobValid) {
      setError("Missing required information.");
      return;
    }

    if (pickedNumber === null) {
      setError("Please choose a number first.");
      return;
    }

    setReserving(true);
    try {
      const result = await reserveNumberForPurchase({
        clubId: selectedClubId,
        jerseyNumber: pickedNumber,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobNum,
        expiresMinutes: 15,
        // NOTE: team is not wired into services yet - we’ll do that next after size is correct.
      } as any);

      if (!result.success) {
        setError(result.message);
        return;
      }

      const expiry = Date.now() + 15 * 60 * 1000;
      setReservedNumber(pickedNumber);
      setExpiresAt(expiry);
      setStatusMessage(`Jersey #${pickedNumber} reserved.`);

      try {
        window.parent?.postMessage(
          { type: "h2h:reservation:ready", jerseyNumber: pickedNumber },
          "*"
        );
      } catch (_) {}
    } finally {
      setReserving(false);
    }
  };

  return (
    <div style={ui.wrap}>
      <div style={ui.title}>Choose your jersey number</div>

      {isEmbed && selectedClubName && (
        <div style={{ marginBottom: 10 }}>
          <div style={ui.label}>Club</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{selectedClubName}</div>
        </div>
      )}

      {/* Size readout (no dropdown - comes from Shopify pills) */}
      <div style={{ marginBottom: 10 }}>
        <div style={ui.label}>Selected size</div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          {selectedSize ? selectedSize : "Please select a size above."}
        </div>
        <div style={ui.helper}>
          Size is read from the product’s size buttons.
        </div>
      </div>

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

        {/* Team dropdown (optional) */}
        <div>
          <div style={ui.label}>Team (optional)</div>
          <select
            style={ui.select}
            value={selectedTeam}
            onChange={(e) => setSelectedTeam(e.target.value)}
          >
            <option value="Not sure / not assigned yet">Not sure / not assigned yet</option>
            {teamOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <div style={ui.helper}>
            If you know your team it helps us allocate better when stock is tight.
          </div>
        </div>

        <div>
          <div style={ui.label}>Preferred number (optional)</div>
          <input
            style={ui.input}
            type="number"
            inputMode="numeric"
            placeholder="e.g. 23"
            value={preferredNumber}
            onChange={(e) => setPreferredNumber(e.target.value)}
          />
          <div style={ui.helper}>
            Enter one if you have a preference - we’ll validate it and auto-suggest if unavailable.
          </div>
        </div>

        <button
          onClick={handleCheckAndSuggest}
          disabled={checking}
          style={{
            ...ui.btnPrimary,
            opacity: checking ? 0.7 : 1,
            cursor: checking ? "not-allowed" : "pointer",
          }}
        >
          {checking ? "Checking…" : "Check & Suggest Playing Numbers"}
        </button>

        {/* Only show reserve once a number is chosen */}
        {pickedNumber !== null && (
          <button
            onClick={handleReserve}
            disabled={reserving}
            style={{
              ...ui.btnSecondary,
              opacity: reserving ? 0.7 : 1,
              cursor: reserving ? "not-allowed" : "pointer",
            }}
          >
            {reserving ? "Reserving…" : `Confirm & Reserve #${pickedNumber}`}
          </button>
        )}
      </div>

      {suggestions.length > 0 && (
        <div style={ui.pillRow}>
          {suggestions.map((s) => {
            const active = pickedNumber === s.jersey_number;
            return (
              <button
                key={s.jersey_number}
                style={{
                  ...ui.pill,
                  ...(active ? ui.pillActive : null),
                }}
                type="button"
                onClick={() => setPickedNumber(s.jersey_number)}
              >
                #{s.jersey_number}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default JerseyWidget;
