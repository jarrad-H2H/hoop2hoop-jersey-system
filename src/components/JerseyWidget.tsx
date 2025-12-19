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

function isUuidLike(v: string): boolean {
  const s = (v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function deriveAgeGroupFromYob(seasonYear: number, yob: number): AgeGroupLabel {
  const age = seasonYear - yob;

  // 2-year bands (common junior structure)
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

  // Accept "U12", "12", "U 12", etc.
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

  // SLG patterns
  if (s.startsWith("SLG") || s.includes(" SLG") || s.includes("SLG.")) return "SLG";

  // 1) Explicit "U12", "U14", etc.
  const mU = s.match(/\bU\s*(10|12|14|16|18|20)\b/);
  if (mU) return mapNumToAgeGroup(Number(mU[1]));

  // 2) Patterns like "14B.1", "12G.3", "10M.2" (digits immediately followed by a letter)
  const mDot = s.match(/(?:^|[^0-9])(10|12|14|16|18|20)(?=[A-Z])/);
  if (mDot) return mapNumToAgeGroup(Number(mDot[1]));

  // 3) Other text like "12 Boys Div 1" (digits as their own token)
  const mTok = s.match(/\b(10|12|14|16|18|20)\b/);
  if (mTok) return mapNumToAgeGroup(Number(mTok[1]));

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

  const remainingSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - tick) / 1000))
    : 0;

  const sizeSelected = Boolean((selectedSize || "").trim());
  const teamSelected = Boolean((teamChoice || "").trim()); // includes "not_sure"

  const canSuggest =
    Boolean(selectedClubId) &&
    sizeSelected &&
    yobValid &&
    teamSelected &&
    !loadingSuggest &&
    !reserving;

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

  // Load all teams for club (STRICT: only query the correct id column)
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

        // Extra guard: never show rows that don't match the detected club
        const filtered = rows.filter((t) => {
          if (useUuid) return String(t.club_id_uuid || "") === selectedClubId;
          return String(t.club_id || "") === selectedClubId;
        });

        setAllTeams(filtered);
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

  // If current selected team isn't in filtered list, reset to not_sure
  useEffect(() => {
    if (!derivedAgeGroup) return;

    if (teamChoice === "not_sure") return;

    const exists = filteredTeams.some((t) => t.id === teamChoice);
    if (!exists) setTeamChoice("not_sure");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedAgeGroup, filteredTeams]);

  const orderedTeamOptions = useM
