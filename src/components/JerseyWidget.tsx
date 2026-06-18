// FILE: src/components/JerseyWidget.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  smartCheckNumber,
  suggestNumbersForClubRanked,
  reserveNumberForPurchase,
  lookupPlayerByName,
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

function isUuidLike(v: string): boolean {
  const s = (v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function deriveAgeGroupFromYob(seasonYear: number, yob: number): AgeGroupLabel {
  const age = seasonYear - yob;
  if (age <= 9) return "U10";
  if (age <= 11) return "U12";
  if (age <= 13) return "U14";
  if (age <= 15) return "U16";
  if (age <= 17) return "U18";
  if (age <= 19) return "U20";
  return "SLG";
}

function normalizeAgeGroup(raw: unknown): AgeGroupLabel | null {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s || s === "N/A") return null;
  if (s.includes("SLG")) return "SLG";
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

function mapNumToAgeGroup(n: number): AgeGroupLabel | null {
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
  const mU = s.match(/\bU\s*(10|12|14|16|18|20)\b/);
  if (mU) return mapNumToAgeGroup(Number(mU[1]));
  const mDot = s.match(/(?:^|[^0-9])(10|12|14|16|18|20)(?=[A-Z])/);
  if (mDot) return mapNumToAgeGroup(Number(mDot[1]));
  const mTok = s.match(/\b(10|12|14|16|18|20)\b/);
  if (mTok) return mapNumToAgeGroup(Number(mTok[1]));
  return null;
}

const YesNoButtons: React.FC<{
  value: boolean | null;
  onChange: (v: boolean) => void;
  yesLabel?: string;
  noLabel?: string;
}> = ({ value, onChange, yesLabel = "Yes", noLabel = "No" }) => (
  <div className="flex gap-2">
    {([true, false] as const).map((v) => (
      <button
        key={String(v)}
        type="button"
        onClick={() => onChange(v)}
        className={[
          "px-5 py-2 rounded border text-sm font-semibold transition-colors",
          value === v
            ? "bg-indigo-600 border-indigo-700 text-white"
            : "bg-white border-gray-300 text-gray-800 hover:bg-gray-50",
        ].join(" ")}
      >
        {v ? yesLabel : noLabel}
      </button>
    ))}
  </div>
);

interface JerseyWidgetProps {
  /** Demo mode: bypass postMessage/product-ID detection and use these directly */
  clubId?: string;
  size?: string | null;
  demoMode?: boolean;
}

const JerseyWidget: React.FC<JerseyWidgetProps> = ({ clubId: propClubId, size: propSize, demoMode }) => {
  const SEASON_YEAR = new Date().getFullYear();

  // Shopify context
  const [shopifyProductId, setShopifyProductId] = useState<string>("");
  const [selectedSize, setSelectedSize] = useState<string>(propSize ?? "");

  // Club detection
  const [selectedClubId, setSelectedClubId] = useState<string>(propClubId ?? "");
  const [clubDetectError, setClubDetectError] = useState<string | null>(null);

  // ── Player identity (new) ──────────────────────────────────────────────────
  const [firstName, setFirstName] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");
  const [isNewPlayer, setIsNewPlayer] = useState<boolean | null>(null);
  const [lookingUpPlayer, setLookingUpPlayer] = useState(false);
  const [existingPlayerJersey, setExistingPlayerJersey] = useState<number | null>(null);
  const [existingPlayerInventoryId, setExistingPlayerInventoryId] = useState<string | null>(null);
  const [keepExistingJersey, setKeepExistingJersey] = useState<boolean | null>(null);
  const [matchedPlayerId, setMatchedPlayerId] = useState<string | null>(null);
  const [matchedPlayerDisplayName, setMatchedPlayerDisplayName] = useState<string | null>(null);
  const [identityConfirmed, setIdentityConfirmed] = useState<boolean | null>(null);
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);
  // ──────────────────────────────────────────────────────────────────────────

  // Core inputs
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
  const [pendingAllocationId, setPendingAllocationId] = useState<string>("");

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = Number.isFinite(yobNum) && yobNum >= 1900 && yobNum <= 2100;

  const derivedAgeGroup: AgeGroupLabel | null = useMemo(() => {
    if (!yobValid) return null;
    return deriveAgeGroupFromYob(SEASON_YEAR, yobNum);
  }, [SEASON_YEAR, yobNum, yobValid]);

  const remainingSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - tick) / 1000))
    : 0;

  const sizeSelected = Boolean((selectedSize || "").trim());
  const teamSelected = Boolean((teamChoice || "").trim());
  const namesFilled = firstName.trim().length > 0 && lastName.trim().length > 0;

  // Whether identity confirmation is needed (player found but not yet confirmed)
  const needsIdentityConfirm =
    isNewPlayer === false && matchedPlayerDisplayName !== null && identityConfirmed === null && !lookingUpPlayer;

  // Whether the "keeping jersey" prompt needs to be answered (only after identity confirmed)
  const needsKeepPrompt =
    isNewPlayer === false && identityConfirmed === true && existingPlayerJersey !== null;

  const canSuggest =
    Boolean(selectedClubId) &&
    sizeSelected &&
    namesFilled &&
    yobValid &&
    isNewPlayer !== null &&
    (matchedPlayerDisplayName === null || identityConfirmed !== null) &&
    (!needsKeepPrompt || keepExistingJersey !== null) &&
    teamSelected &&
    !loadingSuggest &&
    !reserving &&
    !lookingUpPlayer;

  const canConfirm =
    canSuggest &&
    selectedNumber !== null &&
    disclaimerChecked &&
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

  // Demo mode: sync club + size from props when they change
  useEffect(() => {
    if (!demoMode) return;
    if (propClubId) {
      setSelectedClubId(propClubId);
      setClubDetectError(null);
    }
  }, [demoMode, propClubId]);

  useEffect(() => {
    if (!demoMode) return;
    setSelectedSize(propSize ?? "");
    setSuggestions([]);
    setSelectedNumber(null);
    setError(null);
  }, [demoMode, propSize]);

  // Read query params (production: ?productId=... in iframe URL)
  useEffect(() => {
    if (demoMode) return; // skip in demo mode — club comes from props
    try {
      const params = new URLSearchParams(window.location.search);
      const pid = (params.get("productId") || params.get("product_id") || "").trim();
      if (pid) setShopifyProductId(pid);
    } catch (_) {}
    setTeamChoice("not_sure");
  }, [demoMode]);

  // Listen for Shopify variant changes (production iframe only)
  useEffect(() => {
    if (demoMode) return; // skip in demo mode — size comes from props
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
  }, [demoMode]);

  // Detect club via mapping table (production: productId → club lookup)
  useEffect(() => {
    if (demoMode) return; // skip in demo mode — club set directly from propClubId
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
      if (error) { setClubDetectError(error.message); return; }
      const row = (data?.[0] as MappingRow | undefined) ?? undefined;
      if (!row?.club_id) {
        setClubDetectError("Club could not be detected for this product.");
        return;
      }
      setSelectedClubId(row.club_id);
    };
    void run();
  }, [demoMode, shopifyProductId]);

  // Countdown tick
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  // Auto-clear when expired
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

  // Load teams for club
  useEffect(() => {
    const load = async () => {
      setAllTeams([]);
      if (!selectedClubId) return;
      setLoadingTeams(true);
      try {
        const useUuid = isUuidLike(selectedClubId);
        const q = supabase
          .from("teams")
          .select("id, name, club_id, club_id_uuid, age_group, gender")
          .order("name");
        const { data, error } = useUuid
          ? await q.eq("club_id_uuid", selectedClubId)
          : await q.eq("club_id", selectedClubId);
        if (error) throw error;
        const rows = (data ?? []) as TeamRow[];
        const filtered = rows.filter((t) =>
          useUuid
            ? String(t.club_id_uuid || "") === selectedClubId
            : String(t.club_id || "") === selectedClubId
        );
        setAllTeams(filtered);
      } catch (e: any) {
        setAllTeams([]);
      } finally {
        setLoadingTeams(false);
      }
    };
    void load();
  }, [selectedClubId]);

  // When isNewPlayer set to false AND we have club+name+yob, look up the player
  useEffect(() => {
    if (isNewPlayer !== false) {
      // Reset lookup state whenever user flips to "new"
      setExistingPlayerJersey(null);
      setExistingPlayerInventoryId(null);
      setKeepExistingJersey(null);
      setMatchedPlayerId(null);
      setMatchedPlayerDisplayName(null);
      setIdentityConfirmed(null);
      return;
    }
    if (!selectedClubId || !namesFilled || !yobValid) return;

    const run = async () => {
      setLookingUpPlayer(true);
      setExistingPlayerJersey(null);
      setExistingPlayerInventoryId(null);
      setKeepExistingJersey(null);
      setMatchedPlayerId(null);
      setMatchedPlayerDisplayName(null);
      setIdentityConfirmed(null);
      try {
        const ageGroup = yobNum ? deriveAgeGroupFromYob(SEASON_YEAR, yobNum) : null;
        const result = await lookupPlayerByName({
          clubId: selectedClubId,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          yearOfBirth: yobNum,
          ageGroup, // fallback for BC-imported players who have no YOB stored
        });
        if (result.found) {
          setMatchedPlayerId(result.playerId ?? null);
          const displayName = [result.matchedFirstName, result.matchedLastName]
            .filter(Boolean).join(" ");
          setMatchedPlayerDisplayName(displayName || null);
          if (result.currentJerseyNumber != null) {
            setExistingPlayerJersey(result.currentJerseyNumber);
            setExistingPlayerInventoryId(result.previousInventoryId ?? null);
          }
        }
      } catch (_) {
        // Non-fatal — user can still proceed
      } finally {
        setLookingUpPlayer(false);
      }
    };
    void run();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewPlayer, selectedClubId, firstName, lastName, yobNum, yobValid]);

  const clearMessages = () => {
    setError(null);
    setStatusMessage("");
  };

  const filteredTeams = useMemo(() => {
    if (!derivedAgeGroup) return [];
    return (allTeams ?? []).filter((t) => {
      const fromAgeGroupCol = normalizeAgeGroup(t.age_group);
      const fromName = inferTeamAgeGroupFromName(t.name);
      const tag = fromAgeGroupCol ?? fromName;
      return tag === derivedAgeGroup;
    });
  }, [allTeams, derivedAgeGroup]);

  useEffect(() => {
    if (!derivedAgeGroup || teamChoice === "not_sure") return;
    const exists = filteredTeams.some((t) => t.id === teamChoice);
    if (!exists) setTeamChoice("not_sure");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedAgeGroup, filteredTeams]);

  const orderedTeamOptions = useMemo(() => {
    const notSure: TeamRow[] = [{
      id: "not_sure",
      name: "I don't know / Not assigned yet",
      club_id: null,
      club_id_uuid: null,
      age_group: derivedAgeGroup ?? null,
      gender: null,
    }];
    if (!derivedAgeGroup || !filteredTeams.length) return notSure;
    return [...notSure, ...filteredTeams];
  }, [filteredTeams, derivedAgeGroup]);

  const handleSuggest = async () => {
    clearMessages();
    if (!selectedClubId) { setError(clubDetectError || "Club could not be detected for this product."); return; }
    if (!sizeSelected) { setError("Please select a size above to continue."); return; }
    if (!namesFilled) { setError("Please enter first name and surname."); return; }
    if (!yobValid) { setError("Please enter a valid year of birth."); return; }
    if (isNewPlayer === null) { setError("Please answer whether you're new to this club."); return; }
    if (needsKeepPrompt && keepExistingJersey === null) {
      setError("Please answer whether you're keeping your current jersey number."); return;
    }
    if (!teamSelected) { setError("Please select a team (or choose Not sure/Not assigned yet)."); return; }

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
    if (!selectedClubId) { setError(clubDetectError || "Club could not be detected for this product."); return; }
    if (!sizeSelected) { setError("Please select a size above to continue."); return; }
    if (!namesFilled) { setError("Please enter first name and surname."); return; }
    if (!yobValid) { setError("Please enter a valid year of birth."); return; }
    if (isNewPlayer === null) { setError("Please answer whether you're new to this club."); return; }
    if (needsKeepPrompt && keepExistingJersey === null) {
      setError("Please answer whether you're keeping your current jersey number."); return;
    }
    if (!teamSelected) { setError("Please select a team (or choose Not sure/Not assigned yet)."); return; }
    if (selectedNumber === null) { setError("Please choose a suggested number before confirming."); return; }
    if (!disclaimerChecked) { setError("Please accept the disclaimer before reserving."); return; }

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
        // Player identity
        playerFirstName: firstName.trim(),
        playerLastName: lastName.trim(),
        isNewPlayer: isNewPlayer,
        keepExistingJersey: keepExistingJersey,
        previousJerseyNumber: existingPlayerJersey ?? null,
        previousInventoryId: existingPlayerInventoryId ?? null,
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

      <div className="bg-white border rounded p-4 space-y-4">

        {/* Size (read-only from Shopify variant selector) */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Size
          </label>
          <div className="border rounded px-3 py-2 text-sm bg-gray-50">
            {sizeSelected ? selectedSize : "Select a size above to continue"}
          </div>
        </div>

        {/* First Name */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            First Name
          </label>
          <input
            type="text"
            className="border rounded px-3 py-2 w-full text-sm"
            placeholder="e.g. Michael"
            value={firstName}
            onChange={(e) => {
              setFirstName(e.target.value);
              // Reset lookup if name changes
              setIsNewPlayer(null);
              setExistingPlayerJersey(null);
              setExistingPlayerInventoryId(null);
              setKeepExistingJersey(null);
              setMatchedPlayerId(null);
              setMatchedPlayerDisplayName(null);
              setIdentityConfirmed(null);
            }}
          />
        </div>

        {/* Surname */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Surname
          </label>
          <input
            type="text"
            className="border rounded px-3 py-2 w-full text-sm"
            placeholder="e.g. Smith"
            value={lastName}
            onChange={(e) => {
              setLastName(e.target.value);
              setIsNewPlayer(null);
              setExistingPlayerJersey(null);
              setExistingPlayerInventoryId(null);
              setKeepExistingJersey(null);
              setMatchedPlayerId(null);
              setMatchedPlayerDisplayName(null);
              setIdentityConfirmed(null);
            }}
          />
        </div>

        {/* Year of Birth */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Year of Birth
          </label>
          <input
            type="number"
            className="border rounded px-3 py-2 w-full text-sm"
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

        {/* New to club? */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
            New to this club?
          </label>
          <YesNoButtons value={isNewPlayer} onChange={(v) => setIsNewPlayer(v)} />
        </div>

        {/* Player lookup spinner */}
        {lookingUpPlayer && (
          <div className="text-xs text-indigo-600">Looking up player record…</div>
        )}

        {/* Identity confirmation — shown when a matching player record is found */}
        {needsIdentityConfirm && (
          <div className="bg-amber-50 border border-amber-200 rounded p-3">
            <div className="text-sm font-semibold text-amber-900 mb-1">
              We found <span className="font-bold">{matchedPlayerDisplayName}</span> in our records.
            </div>
            <div className="text-xs text-amber-800 mb-2">Is that you?</div>
            <YesNoButtons
              value={identityConfirmed}
              onChange={(v) => {
                setIdentityConfirmed(v);
                if (!v) {
                  // Player said "No" — treat as genuinely new; clear matched state
                  setMatchedPlayerId(null);
                  setExistingPlayerJersey(null);
                  setExistingPlayerInventoryId(null);
                  setKeepExistingJersey(null);
                }
              }}
              yesLabel="Yes, that's me"
              noLabel="No, I'm someone else"
            />
          </div>
        )}

        {/* Keeping jersey? — only shown if existing player has a jersey */}
        {needsKeepPrompt && !lookingUpPlayer && (
          <div className="bg-blue-50 border border-blue-200 rounded p-3">
            <div className="text-sm font-semibold text-blue-900 mb-2">
              Our records show you already have jersey #{existingPlayerJersey}.
            </div>
            <label className="block text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              Still keeping #{existingPlayerJersey}?
            </label>
            <YesNoButtons
              value={keepExistingJersey}
              onChange={(v) => setKeepExistingJersey(v)}
              yesLabel={`Yes, keep #${existingPlayerJersey}`}
              noLabel="No, replacing it"
            />
            {keepExistingJersey === false && (
              <div className="text-xs text-blue-800 mt-2">
                Your old number will be released back to available stock once your purchase is complete.
              </div>
            )}
          </div>
        )}

        {/* Team */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Team
          </label>
          <select
            className="border rounded px-3 py-2 w-full text-sm"
            value={teamChoice}
            onChange={(e) => setTeamChoice(e.target.value)}
            disabled={loadingTeams}
          >
            {orderedTeamOptions.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {derivedAgeGroup && !loadingTeams && filteredTeams.length === 0 && (
            <div className="text-xs text-amber-800 mt-1">
              No teams found for {derivedAgeGroup} (for this club). You can still proceed with "Not assigned yet".
            </div>
          )}
        </div>

        {/* Preferred number */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Preferred Number (optional)
          </label>
          <input
            type="number"
            className="border rounded px-3 py-2 w-full text-sm"
            placeholder="e.g. 23"
            value={preferredNumber}
            onChange={(e) => setPreferredNumber(e.target.value)}
          />
        </div>

        {/* Check & Suggest */}
        <button
          type="button"
          onClick={handleSuggest}
          disabled={!canSuggest}
          className="w-full px-4 py-2 rounded font-semibold text-sm bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-600 transition-colors"
        >
          {loadingSuggest ? "Checking…" : "Check & Suggest Playing Numbers"}
        </button>

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div className="pt-1">
            <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">
              Suggested Numbers
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
                      "px-3 py-2 rounded border text-sm font-semibold transition-colors",
                      active
                        ? "bg-emerald-600 border-emerald-700 text-white"
                        : "bg-white border-gray-300 text-gray-900 hover:bg-gray-50",
                    ].join(" ")}
                  >
                    #{s.jersey_number}
                    {s.reason && (
                      <span className="block text-[10px] font-normal">{s.reason}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Disclaimer */}
        {selectedNumber !== null && (
          <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={disclaimerChecked}
              onChange={(e) => setDisclaimerChecked(e.target.checked)}
            />
            <span>
              I understand this number is reserved for 15 minutes. My reservation
              will be confirmed once payment is complete.
            </span>
          </label>
        )}

        {/* Confirm & Reserve */}
        {selectedNumber !== null && (
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="w-full px-4 py-2 rounded font-semibold text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-gray-300 disabled:text-gray-600 transition-colors"
          >
            {reserving ? "Reserving…" : `Confirm & Reserve #${selectedNumber}`}
          </button>
        )}

        {/* Status / countdown */}
        {statusMessage && (
          <div className="text-sm text-emerald-700 font-medium">{statusMessage}</div>
        )}

        {expiresAt !== null && remainingSeconds > 0 && (
          <div className="text-xs text-gray-500">
            Reservation expires in {Math.floor(remainingSeconds / 60)}:
            {String(remainingSeconds % 60).padStart(2, "0")}
          </div>
        )}

        {pendingAllocationId && (
          <div className="text-[11px] mt-1 text-amber-900/80">
            Reservation ID saved for checkout.
          </div>
        )}
      </div>
    </div>
  );
};

export default JerseyWidget;
