// FILE: src/components/JerseyWidget.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import {
  smartCheckNumber,
  suggestNumbersForClubRanked,
  reserveNumberForPurchase,
  lookupPlayerByName,
  isAgeGroupCrossPool,
  ageGroupBucketSiblings,
} from "../services/allocation";

interface MappingRow {
  shopify_product_id: string;
  club_id: string;
  product_type: string | null;
}

/** Maps the demo-mode "gender" prop to the DB's product_type values. */
function genderToProductType(g: string): string {
  if (g === "mens") return "mens";
  if (g === "womens") return "womens";
  return "default";
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

const AGE_GROUP_LADDER: AgeGroupLabel[] = ["U10", "U12", "U14", "U16", "U18", "U20", "SLG"];

/**
 * Smoothly scrolls a section into view when it appears as a result of the customer
 * answering a previous question -- never on the widget's initial mount, even if a
 * section (e.g. the gender prompt, for unisex-product clubs) happens to already be
 * visible from the very first render. Without this guard, that first-render-visible
 * section was treated as "newly revealed" and the page auto-scrolled straight past
 * the size/name fields on load, before the customer had touched anything.
 */
function useScrollIntoViewOnReveal<T extends HTMLElement>(ref: React.RefObject<T>, active: boolean) {
  const wasActive = useRef(active);
  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      wasActive.current = active;
      return;
    }
    if (active && !wasActive.current) {
      // Defer one frame so the newly-rendered content has a real layout/height
      // before we ask the browser to scroll to it.
      requestAnimationFrame(() => {
        ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    wasActive.current = active;
  }, [active, ref]);
}

function nextAgeGroup(ag: AgeGroupLabel | null): AgeGroupLabel | null {
  if (!ag) return null;
  const idx = AGE_GROUP_LADDER.indexOf(ag);
  if (idx === -1 || idx >= AGE_GROUP_LADDER.length - 1) return null;
  return AGE_GROUP_LADDER[idx + 1];
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

interface WidgetAgeGroupBracket {
  label: string;
  max_age?: number | null;
}

interface WidgetConfig {
  order_mode?: string;
  collect_surname?: boolean;
  collect_prefs?: boolean;
  allow_reclaim?: boolean;
  collect_gender?: boolean;
  age_group_mode?: "auto_yob" | "customer_select" | "window_set" | null;
  age_groups?: WidgetAgeGroupBracket[];
  current_window_age_group?: string | null;
}

interface JerseyWidgetProps {
  /** Demo mode: bypass postMessage/product-ID detection and use these directly */
  clubId?: string;
  size?: string | null;
  demoMode?: boolean;
  /** Gender segment for this Shopify product: 'mens' | 'womens' | 'unisex' (default) */
  gender?: "mens" | "womens" | "unisex";
}

const JerseyWidget: React.FC<JerseyWidgetProps> = ({ clubId: propClubId, size: propSize, demoMode, gender = "unisex" }) => {
  const SEASON_YEAR = new Date().getFullYear();

  // Shopify context
  const [shopifyProductId, setShopifyProductId] = useState<string>("");
  const [selectedSize, setSelectedSize] = useState<string>(propSize ?? "");

  // Club detection
  const [selectedClubId, setSelectedClubId] = useState<string>(propClubId ?? "");
  const [clubDetectError, setClubDetectError] = useState<string | null>(null);

  // Product type (mens/womens/default) — resolved from shopify_product_club_map in
  // production, or from the demoMode `gender` prop. Drives which inventory pool is
  // checked and which product the reservation is created against (dual-product clubs).
  const [selectedProductType, setSelectedProductType] = useState<string>(
    demoMode ? genderToProductType(gender) : "default"
  );

  const [preorderMode, setPreorderMode] = useState<"off" | "open" | "closed" | "locked">("off");
  const [allocationTypeState, setAllocationTypeState] = useState<"fcfs" | "pre_allocated">("fcfs");
  const [widgetConfig, setWidgetConfig] = useState<WidgetConfig | null>(null);

  // Player gender — needed to find Gold Coast's girls-only Junior/Open Girls teams,
  // which the standard YOB-derived age ladder (U10/U12/.../U18) can never match on its
  // own. For mens/womens-labeled products this is known automatically from the Shopify
  // product the customer is buying — no need to ask. For any other product_type (the
  // single-product/unisex case, INCLUDING clubs with multiple unisex stock pools from
  // different suppliers, e.g. Warriors' old-supplier vs new-supplier products -- those
  // are still both unisex, just separate stock pools) there's no gender signal from the
  // product alone, so the widget asks directly. Checking "not mens/womens" rather than
  // "=== 'default'" means this stays correct no matter what label a unisex pool uses.
  const [playerGenderAnswer, setPlayerGenderAnswer] = useState<"Male" | "Female" | null>(null);
  const isGenderedProductType = selectedProductType === "mens" || selectedProductType === "womens";
  const effectivePlayerGender: "Male" | "Female" | null =
    selectedProductType === "mens" ? "Male"
    : selectedProductType === "womens" ? "Female"
    : playerGenderAnswer;
  const needsGenderPrompt = !isGenderedProductType && playerGenderAnswer === null;

  // ── Player identity (new) ──────────────────────────────────────────────────
  const [firstName, setFirstName] = useState<string>("");
  const [lastName, setLastName] = useState<string>("");
  const [isNewPlayer, setIsNewPlayer] = useState<boolean | null>(null);
  const [lookingUpPlayer, setLookingUpPlayer] = useState(false);
  const [existingPlayerJersey, setExistingPlayerJersey] = useState<number | null>(null);
  const [existingPlayerInventoryId, setExistingPlayerInventoryId] = useState<string | null>(null);
  const [keepExistingJersey, setKeepExistingJersey] = useState<boolean | null>(null);
  const [playingUp, setPlayingUp] = useState<boolean | null>(null);
  const [matchedPlayerId, setMatchedPlayerId] = useState<string | null>(null);
  const [matchedPlayerDisplayName, setMatchedPlayerDisplayName] = useState<string | null>(null);
  const [matchedPlayerDivisionCode, setMatchedPlayerDivisionCode] = useState<string | null>(null);
  const [matchedPlayerTeamName, setMatchedPlayerTeamName] = useState<string | null>(null);
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

  // Cross-pool check: true when the player's age group has cross-pool jersey uniqueness
  const [crossPoolCheck, setCrossPoolCheck] = useState<boolean>(false);

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

  // Pre-allocated form state (only used when preorderMode === "open" && allocationTypeState === "pre_allocated")
  interface PreAllocCandidate {
    id: string;
    firstName: string;
    lastName: string;
    assignedNumber: number;
    defaultJerseyName: string;
    alreadyConfirmed: boolean;
  }
  const [paFirstName, setPaFirstName] = useState<string>("");
  const [paLastName, setPaLastName] = useState<string>("");
  const [paYob, setPaYob] = useState<string>("");
  const [paSeasonParam, setPaSeasonParam] = useState<string>("");
  const [paLookupDone, setPaLookupDone] = useState<boolean>(false);
  const [paLooking, setPaLooking] = useState<boolean>(false);
  const [paCandidates, setPaCandidates] = useState<PreAllocCandidate[]>([]);
  const [paSelected, setPaSelected] = useState<PreAllocCandidate | null>(null);
  const [paJerseyName, setPaJerseyName] = useState<string>("");
  const [paSize, setPaSize] = useState<string>("");
  const [paSubmitting, setPaSubmitting] = useState<boolean>(false);
  const [paSubmitted, setPaSubmitted] = useState<boolean>(false);
  const [paError, setPaError] = useState<string | null>(null);

  // Pre-order preference form state (only used when preorderMode === "open" && allocationTypeState === "fcfs")
  const [pref1, setPref1] = useState<string>("");
  const [pref2, setPref2] = useState<string>("");
  const [pref3, setPref3] = useState<string>("");
  const [anyNumber, setAnyNumber] = useState<boolean>(false);
  const [claimedCurrentChecked, setClaimedCurrentChecked] = useState<boolean>(false);
  const [claimedCurrentNum, setClaimedCurrentNum] = useState<string>("");
  const [preorderSubmitted, setPreorderSubmitted] = useState<boolean>(false);
  // FCFS widget_config-driven state
  const [fcfsJerseyName, setFcfsJerseyName] = useState<string>("");
  const [customerSelectedAgeGroup, setCustomerSelectedAgeGroup] = useState<string>("");
  const [yobOverflowConfirmed, setYobOverflowConfirmed] = useState<boolean | null>(null);

  const yobNum = useMemo(() => Number(yearOfBirth), [yearOfBirth]);
  const yobValid = Number.isFinite(yobNum) && yobNum >= 1900 && yobNum <= 2100;

  const derivedAgeGroup: AgeGroupLabel | null = useMemo(() => {
    if (!yobValid) return null;
    return deriveAgeGroupFromYob(SEASON_YEAR, yobNum);
  }, [SEASON_YEAR, yobNum, yobValid]);

  // When player is playing up, search against the age group ABOVE their YOB-derived group
  const effectiveAgeGroup: AgeGroupLabel | null = useMemo(() => {
    if (keepExistingJersey === true && playingUp === true) {
      return nextAgeGroup(derivedAgeGroup);
    }
    return derivedAgeGroup;
  }, [derivedAgeGroup, keepExistingJersey, playingUp]);

  const remainingSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - tick) / 1000))
    : 0;

  // ── widget_config derived values ──────────────────────────────────────────
  const wc = widgetConfig;

  const resolvedFcfsAgeGroup: string | null = useMemo(() => {
    const mode = wc?.age_group_mode;
    if (!mode) return derivedAgeGroup; // fallback to Seahawks-style YOB derivation
    if (mode === "window_set") return wc?.current_window_age_group ?? null;
    if (mode === "customer_select") return customerSelectedAgeGroup || null;
    if (mode === "auto_yob") {
      if (!yobValid) return null;
      const age = SEASON_YEAR - yobNum;
      const groups = wc?.age_groups ?? [];
      for (const g of groups) {
        if (g.max_age == null || age <= g.max_age) return g.label;
      }
      return groups.length > 0 ? groups[groups.length - 1].label : derivedAgeGroup;
    }
    return derivedAgeGroup;
  }, [wc, customerSelectedAgeGroup, yobValid, yobNum, SEASON_YEAR, derivedAgeGroup]);

  // Label of the oldest age group if current YOB overflows all brackets (auto_yob only)
  const fcfsYobOverflowGroupLabel: string | null = useMemo(() => {
    if (wc?.age_group_mode !== "auto_yob" || !yobValid) return null;
    const groups = wc?.age_groups ?? [];
    if (!groups.length) return null;
    const last = groups[groups.length - 1];
    if (last.max_age == null) return null; // no upper bound on last group = catch-all
    return SEASON_YEAR - yobNum > last.max_age ? last.label : null;
  }, [wc, yobValid, yobNum, SEASON_YEAR]);
  // ─────────────────────────────────────────────────────────────────────────

  const sizeSelected = Boolean((selectedSize || "").trim());
  const teamSelected = Boolean((teamChoice || "").trim());
  const namesFilled = firstName.trim().length > 0 && lastName.trim().length > 0;

  // Whether identity confirmation is needed (player found but not yet confirmed)
  const needsIdentityConfirm =
    isNewPlayer === false && matchedPlayerDisplayName !== null && identityConfirmed === null && !lookingUpPlayer;

  // Whether the "keeping jersey" prompt needs to be answered (only after identity confirmed)
  const needsKeepPrompt =
    isNewPlayer === false && identityConfirmed === true && existingPlayerJersey !== null;

  // Whether the "playing up?" prompt needs to be answered
  // Only shown when: returning player, confirmed identity, keeping their jersey,
  // AND there is a valid age group above their YOB-derived one
  const needsPlayingUpPrompt =
    isNewPlayer === false &&
    identityConfirmed === true &&
    existingPlayerJersey !== null &&
    keepExistingJersey === true &&
    playingUp === null &&
    nextAgeGroup(derivedAgeGroup) !== null;

  const canSuggest =
    Boolean(selectedClubId) &&
    sizeSelected &&
    namesFilled &&
    yobValid &&
    !needsGenderPrompt &&
    isNewPlayer !== null &&
    (matchedPlayerDisplayName === null || identityConfirmed !== null) &&
    (!needsKeepPrompt || keepExistingJersey !== null) &&
    !needsPlayingUpPrompt &&
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
    type: "h2h:reservation:ready" | "h2h:reservation:cleared" | "h2h:preallocated:ready",
    payload?: any
  ) => {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type, ...(payload || {}) }, "*");
      }
      window.dispatchEvent(new CustomEvent(type, { detail: payload || {} }));
    } catch (_) {}
  };

  // Reports the widget's real content height to the parent Shopify page whenever it
  // changes, so the theme can resize the iframe to fit instead of showing its own
  // internal scrollbar -- customers were missing newly-revealed questions because they
  // had to discover and scroll a separate scroll area inside a fixed-height iframe.
  // Requires a small addition on the Shopify theme side to consume "h2h:resize" and
  // actually set the iframe's height (see buy-buttons.liquid).
  const widgetRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = widgetRootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const postHeight = () => {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(
            { type: "h2h:resize", height: el.scrollHeight },
            "*"
          );
        }
      } catch (_) {}
    };
    const observer = new ResizeObserver(postHeight);
    observer.observe(el);
    postHeight();
    return () => observer.disconnect();
  }, []);

  // Tell widget.js the moment a valid club is confirmed so it can reveal the iframe.
  // This is the authoritative reveal signal — widget.js never reveals based on height alone.
  useEffect(() => {
    if (!selectedClubId) return;
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "h2h:clubConfirmed" }, "*");
      }
    } catch (_) {}
  }, [selectedClubId]);

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

  // Read query params (production: ?productId=... in iframe URL, or ?clubId=... for standalone pre-allocated form)
  useEffect(() => {
    if (demoMode) return; // skip in demo mode — club comes from props
    try {
      const params = new URLSearchParams(window.location.search);
      const pid = (params.get("productId") || params.get("product_id") || "").trim();
      if (pid) setShopifyProductId(pid);

      // Standalone pre-allocated access: ?clubId=<uuid> bypasses Shopify product lookup
      const directSeasonParam = (params.get("season") || "").trim();
      if (directSeasonParam) setPaSeasonParam(directSeasonParam);

      const directClubId = (params.get("clubId") || params.get("club_id") || "").trim();
      if (directClubId && !pid) {
        void (async () => {
          const { data } = await supabase
            .from("clubs")
            .select("id, preorder_mode, allocation_type, is_client, widget_config")
            .eq("id", directClubId)
            .limit(1);
          const club = (data?.[0] as { id: string; preorder_mode: string; allocation_type: string; is_client: boolean; widget_config: WidgetConfig | null } | undefined);
          if (!club?.is_client) return;
          setSelectedClubId(club.id);
          setPreorderMode((club.preorder_mode as "off" | "open" | "closed" | "locked") ?? "off");
          setAllocationTypeState((club.allocation_type as "fcfs" | "pre_allocated") ?? "fcfs");
          setWidgetConfig(club.widget_config ?? null);
        })();
      }
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

    // Tell the parent page's widget.js we're ready to receive variant state now.
    // Without this, a customer who taps a size before this listener attaches (the
    // iframe's own load event firing is not the same moment as this effect running)
    // has that selection silently dropped -- widget.js has no way of knowing nobody
    // was listening yet, and never retries on its own. Asking explicitly the moment
    // we're actually ready closes that race regardless of which side is slower.
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "h2h:requestState" }, "*");
      }
    } catch (_) {}

    return () => window.removeEventListener("message", onMsg);
  }, [demoMode]);

  // Detect club via mapping table (production: productId → club lookup)
  useEffect(() => {
    if (demoMode) return; // skip in demo mode — club set directly from propClubId
    const run = async () => {
      setClubDetectError(null);
      setSelectedClubId("");
      setPreorderMode("off");
      const pid = (shopifyProductId || "").trim();
      if (!pid) return;
      const { data, error } = await supabase
        .from("shopify_product_club_map")
        .select("shopify_product_id, club_id, product_type, bundle_jersey_property, clubs(preorder_mode, allocation_type, is_client, widget_config)")
        .eq("shopify_product_id", pid)
        .limit(1);
      if (error) { setClubDetectError(error.message); return; }
      const row = (data?.[0] as (MappingRow & { clubs?: { preorder_mode?: string; is_client?: boolean } | { preorder_mode?: string; is_client?: boolean }[] | null }) | undefined) ?? undefined;
      if (!row?.club_id) {
        setClubDetectError("Club could not be detected for this product.");
        return;
      }
      const clubJoin = Array.isArray(row.clubs) ? row.clubs[0] : row.clubs;
      if (!clubJoin?.is_client) {
        // Club exists but is not active — stay hidden, no error shown to customer
        return;
      }
      setSelectedClubId(row.club_id);
      setSelectedProductType(row.product_type ?? "default");
      setPreorderMode((clubJoin?.preorder_mode as "off" | "open" | "closed" | "locked") ?? "off");
      setAllocationTypeState(((clubJoin as any)?.allocation_type as "fcfs" | "pre_allocated") ?? "fcfs");
      const resolvedWc = ((clubJoin as any)?.widget_config as WidgetConfig | null) ?? null;
      setWidgetConfig(resolvedWc);
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({
            type: "h2h:config",
            bundleJerseyProperty: (row as any).bundle_jersey_property ?? null,
            currentWindowAgeGroup: resolvedWc?.current_window_age_group ?? null,
          }, "*");
        }
      } catch (_) {}
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

  // Auto-populate FCFS jersey name from last name when collect_surname is on
  useEffect(() => {
    if (wc?.collect_surname) {
      setFcfsJerseyName(lastName.trim().toUpperCase());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastName]);

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

  // Cross-pool flag: recompute when club or effective age group changes
  // Uses effectiveAgeGroup so playing-up searches check cross-pool for the target group
  useEffect(() => {
    if (!selectedClubId || !effectiveAgeGroup) {
      setCrossPoolCheck(false);
      return;
    }
    void isAgeGroupCrossPool(selectedClubId, effectiveAgeGroup).then(setCrossPoolCheck);
  }, [selectedClubId, effectiveAgeGroup]);

  // Reset all lookup + question state whenever identity inputs change.
  // Lookup itself is triggered by the "Find Available Numbers" button, not auto-fired.
  useEffect(() => {
    setExistingPlayerJersey(null);
    setExistingPlayerInventoryId(null);
    setKeepExistingJersey(null);
    setPlayingUp(null);
    setMatchedPlayerId(null);
    setMatchedPlayerDisplayName(null);
    setMatchedPlayerDivisionCode(null);
    setMatchedPlayerTeamName(null);
    setIdentityConfirmed(null);
    setSuggestions([]);
    setSelectedNumber(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewPlayer, selectedClubId, firstName, lastName, yobNum]);

  const clearMessages = () => {
    setError(null);
    setStatusMessage("");
  };

  // Filter by effectiveAgeGroup, not derivedAgeGroup -- when playing up, the team being
  // selected for THIS purchase is in the higher age group, not the player's own raw-YOB band.
  //
  // Gold Coast's girls-only Junior (=U14+U16 merged) and Open Girls (=U18+Open merged)
  // divisions can never match the standard ladder tag (normalizeAgeGroup/
  // inferTeamAgeGroupFromName can't parse "Junior"/"Open Girls" at all), so those teams
  // would otherwise never appear here for ANY buyer. Widen the match to also include
  // raw-label merge-bucket siblings of effectiveAgeGroup, gated on the player's gender
  // being known and Female (these divisions are girls-only). Also narrow by team gender
  // so a Male buyer never sees Female-only teams and vice versa (Mixed/unset always shown).
  const filteredTeams = useMemo(() => {
    if (!effectiveAgeGroup) return [];
    const bucketSiblingsLower = ageGroupBucketSiblings(effectiveAgeGroup).map((s) => s.toLowerCase());
    return (allTeams ?? []).filter((t) => {
      const fromAgeGroupCol = normalizeAgeGroup(t.age_group);
      const fromName = inferTeamAgeGroupFromName(t.name);
      const tag = fromAgeGroupCol ?? fromName;
      const standardMatch = tag === effectiveAgeGroup;
      const bucketMatch =
        effectivePlayerGender === "Female" &&
        !!t.age_group &&
        bucketSiblingsLower.includes(t.age_group.trim().toLowerCase());
      if (!standardMatch && !bucketMatch) return false;

      if (!effectivePlayerGender) return true;
      const teamGender = (t.gender || "").trim();
      if (!teamGender || teamGender === "Mixed") return true;
      return effectivePlayerGender === "Female" ? teamGender === "Female" : teamGender === "Male";
    });
  }, [allTeams, effectiveAgeGroup, effectivePlayerGender]);

  useEffect(() => {
    if (!effectiveAgeGroup || teamChoice === "not_sure") return;
    const exists = filteredTeams.some((t) => t.id === teamChoice);
    if (!exists) setTeamChoice("not_sure");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveAgeGroup, filteredTeams]);

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

  // Clear stale suggestions whenever the inputs that determine the number pool change.
  // This ensures the grid is always in sync with what the user has entered.
  useEffect(() => {
    setSuggestions([]);
    setSelectedNumber(null);
    setError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClubId, selectedSize, yobNum]);

  // Triggered by "Find Available Numbers" button.
  // For returning players who haven't been looked up yet, runs lookup first;
  // if that surfaces prompts (identity confirm, keep jersey, playing up) we
  // return early and let the UI questions appear before the next click.
  const handleFindNumbers = async () => {
    clearMessages();
    if (!selectedClubId) { setError(clubDetectError || "Club could not be detected for this product."); return; }
    if (!namesFilled) { setError("Please enter first name and surname."); return; }
    if (!yobValid) { setError("Please enter a valid year of birth."); return; }
    if (isNewPlayer === null) { setError("Please answer whether you're new to this club."); return; }

    // If returning player and lookup not yet done, run it now
    if (isNewPlayer === false && matchedPlayerId === null && !lookingUpPlayer) {
      setLookingUpPlayer(true);
      try {
        const ageGroup = yobNum ? deriveAgeGroupFromYob(SEASON_YEAR, yobNum) : null;
        const result = await lookupPlayerByName({
          clubId: selectedClubId,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          yearOfBirth: yobNum,
          ageGroup,
          productType: selectedProductType,
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
          // Plan B: store team identifiers for team-aware clash checking after identity confirmed
          setMatchedPlayerDivisionCode(result.divisionCode ?? null);
          setMatchedPlayerTeamName(result.teamName ?? null);
          // Stop here — let the identity confirm / keep jersey prompts appear
          return;
        }
      } catch (_) {
        // Non-fatal — fall through to suggest
      } finally {
        setLookingUpPlayer(false);
      }
    }

    // If prompts are still pending, stop — user must answer them first
    if (needsIdentityConfirm) return;
    if (needsKeepPrompt && keepExistingJersey === null) {
      setError("Please answer whether you're keeping your current jersey number."); return;
    }
    if (needsPlayingUpPrompt) return;

    await handleSuggest();
  };

  const handleSuggest = async () => {
    clearMessages();
    if (!selectedClubId) { setError(clubDetectError || "Club could not be detected for this product."); return; }
    if (!sizeSelected) { setError("Please select a size above to continue."); return; }
    if (!namesFilled) { setError("Please enter first name and surname."); return; }
    if (!yobValid) { setError("Please enter a valid year of birth."); return; }
    if (needsGenderPrompt) { setError("Please confirm the player's gender before continuing."); return; }
    if (isNewPlayer === null) { setError("Please answer whether you're new to this club."); return; }
    if (needsKeepPrompt && keepExistingJersey === null) {
      setError("Please answer whether you're keeping your current jersey number."); return;
    }
    if (!teamSelected) { setError("Please select a team (or choose Not sure/Not assigned yet)."); return; }

    // The buyer's actual YOB is always safe to pass through: when a real team is
    // selected, clash-checking is purely team-vs-team and ignores YOB entirely; when
    // no team is known (e.g. "playing up" but "not sure" which higher team), this
    // correctly falls back to the standard ±1-year YOB window for the buyer's real
    // age, rather than leaving YOB undefined (which previously fell through to an
    // incorrect "treat as 18+/Open" default).
    const yobForSearch = yobNum;

    // Plan B: returning player with confirmed identity and a known team.
    // Passing divisionCode + teamName switches the allocation functions from the
    // conservative YOB-window path to team-aware logic: only same-team numbers
    // are hard-blocked; different-team numbers (even within ±1 YOB) are allowed.
    const planBDivisionCode =
      isNewPlayer === false &&
      identityConfirmed === true &&
      matchedPlayerId !== null &&
      matchedPlayerDivisionCode !== null
        ? matchedPlayerDivisionCode
        : undefined;
    const planBTeamName =
      planBDivisionCode !== undefined ? matchedPlayerTeamName ?? undefined : undefined;

    // New (or unconfirmed) players who picked an actual team from the dropdown still
    // need same-team clash protection — teamChoice was previously only used to tag the
    // reservation record (teamId) and never passed into clash checking, so a new player
    // could be shown a number already worn by a teammate. Resolve the chosen team's
    // name here and fall back to it whenever Plan B's team identity isn't available.
    const selectedTeamName =
      teamChoice !== "not_sure"
        ? allTeams.find((t) => t.id === teamChoice)?.name ?? undefined
        : undefined;
    // Playing up: Plan B's matched team is the player's PRIMARY (lower) team, which does
    // NOT apply to this purchase — they're buying a second jersey for a DIFFERENT, higher
    // team selected from the dropdown. Prioritise that dropdown selection in this case.
    const effectiveDivisionCode = playingUp === true ? undefined : planBDivisionCode;
    const effectiveTeamName =
      playingUp === true ? selectedTeamName : planBTeamName ?? selectedTeamName;

    setLoadingSuggest(true);
    setSuggestions([]);
    setSelectedNumber(null);

    try {
      const ranked = await suggestNumbersForClubRanked({
        clubId: selectedClubId,
        size: selectedSize,
        seasonYear: SEASON_YEAR,
        yearOfBirth: yobForSearch,
        ageGroup: effectiveAgeGroup ?? undefined,
        divisionCode: effectiveDivisionCode,
        teamName: effectiveTeamName,
        crossPoolCheck,
        productType: selectedProductType,
        excludePlayerId: matchedPlayerId,
        limit: 30,
      });

      const pref = Number(preferredNumber);
      if (Number.isFinite(pref)) {
        try {
          const check = await smartCheckNumber(selectedClubId, pref, {
            seasonYear: SEASON_YEAR,
            yearOfBirth: yobForSearch,
            ageGroup: effectiveAgeGroup ?? undefined,
            divisionCode: effectiveDivisionCode,
            teamName: effectiveTeamName,
            crossPoolCheck,
            productType: selectedProductType,
            excludePlayerId: matchedPlayerId,
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
        expiresMinutes: 30,
        // Player identity
        playerFirstName: firstName.trim(),
        playerLastName: lastName.trim(),
        isNewPlayer: isNewPlayer,
        keepExistingJersey: keepExistingJersey,
        previousJerseyNumber: existingPlayerJersey ?? null,
        previousInventoryId: existingPlayerInventoryId ?? null,
        productType: selectedProductType,
      });

      if (!result.success) {
        setError(result.message || "Could not reserve that number.");
        return;
      }

      const expiry = Date.now() + 30 * 60 * 1000;
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

  // ── Pre-allocated mode handlers ──────────────────────────────────────────────

  const handlePreAllocLookup = async () => {
    setPaError(null);
    if (!paFirstName.trim() || !paLastName.trim()) { setPaError("Please enter the player's first name and surname."); return; }
    const yobRaw = paYob.trim();
    const yob = yobRaw ? Number(yobRaw) : null;
    if (yob !== null && (!Number.isFinite(yob) || yob < 1900 || yob > 2100)) { setPaError("Year of birth doesn't look right — leave it blank if you're not sure."); return; }
    setPaLooking(true);
    setPaLookupDone(false);
    setPaCandidates([]);
    setPaSelected(null);
    try {
      const res = await fetch("/api/preorder/lookup-preallocated", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubId: selectedClubId, season: paSeasonParam || null, productType: selectedProductType || null, firstName: paFirstName.trim(), lastName: paLastName.trim(), yearOfBirth: yob }),
      });
      const json = await res.json();
      if (!json.ok) { setPaError(json.error ?? "Lookup failed."); return; }
      setPaCandidates(json.candidates ?? []);
    } catch {
      setPaError("Could not reach the server. Please try again.");
    } finally {
      setPaLooking(false);
      setPaLookupDone(true);
    }
  };

  const handlePreAllocSelectCandidate = (candidate: PreAllocCandidate) => {
    setPaSelected(candidate);
    setPaJerseyName(candidate.defaultJerseyName);
    setPaError(null);
  };

  const JERSEY_NAME_RE = /^[A-Za-z'\-]+$/;

  const handlePreAllocConfirm = async () => {
    setPaError(null);
    if (!paSelected) return;
    if (!paJerseyName.trim()) { setPaError("Jersey name cannot be blank."); return; }
    if (!JERSEY_NAME_RE.test(paJerseyName.trim())) { setPaError("Jersey name may only contain letters, hyphens, and apostrophes — no spaces."); return; }
    if (paJerseyName.trim().length > 25) { setPaError("Jersey name must be 25 characters or fewer."); return; }
    const size = selectedSize || paSize.trim();
    if (!size) { setPaError("Please enter your jersey size."); return; }
    setPaSubmitting(true);
    try {
      const res = await fetch("/api/preorder/confirm-size", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preorderRequestId: paSelected.id, jerseyName: paJerseyName.trim().toUpperCase(), size }),
      });
      const json = await res.json();
      if (!json.ok) { setPaError(json.error ?? "Could not save your details. Please try again."); return; }
      setPaSubmitted(true);
      notifyShopify("h2h:preallocated:ready", {
        jerseyNumber: paSelected.assignedNumber,
        jerseyName: paJerseyName.trim().toUpperCase(),
        preorderRequestId: paSelected.id,
      });
    } catch {
      setPaError("Could not reach the server. Please try again.");
    } finally {
      setPaSubmitting(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────

  const handlePreorderSubmit = () => {
    setError(null);
    if (!selectedClubId) { setError(clubDetectError || "Club could not be detected for this product."); return; }
    if (!sizeSelected) { setError("Please select a size above to continue."); return; }
    if (!namesFilled) { setError("Please enter first name and surname."); return; }
    if (!yobValid) { setError("Please enter a valid year of birth."); return; }

    const collectPrefs = wc?.collect_prefs !== false;
    const allowReclaim = wc?.allow_reclaim ?? true;
    const collectGender = wc?.collect_gender ?? true;
    const collectSurname = wc?.collect_surname === true;

    if (collectSurname) {
      const jn = fcfsJerseyName.trim();
      if (!jn) { setError("Please enter your surname for jersey printing."); return; }
      if (!/^[A-Za-z'\-]+$/.test(jn)) { setError("Surname to be printed may only contain letters, hyphens, and apostrophes."); return; }
      if (jn.length > 25) { setError("Surname to be printed must be 25 characters or fewer."); return; }
    }
    if (wc?.age_group_mode === "customer_select" && !customerSelectedAgeGroup) {
      setError("Please select your age group."); return;
    }
    if (collectGender && !playerGenderAnswer) { setError("Please select a gender."); return; }

    const parsePref = (s: string): number | null => {
      if (!s.trim()) return null;
      const n = Number(s.trim());
      return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 99 && n !== 69 ? n : null;
    };
    const p1 = collectPrefs ? parsePref(pref1) : null;
    const p2 = collectPrefs ? parsePref(pref2) : null;
    const p3 = collectPrefs ? parsePref(pref3) : null;
    const claimedCurrent = (collectPrefs && allowReclaim && claimedCurrentChecked) ? parsePref(claimedCurrentNum) : null;

    if (collectPrefs) {
      if (!anyNumber && p1 === null && p2 === null && p3 === null && !claimedCurrentChecked) {
        setError("Please enter at least one number preference, or check 'Any number is fine'.");
        return;
      }
      if ([pref1, pref2, pref3].some(s => s.trim() && parsePref(s) === null)) {
        setError("Preferences must be valid jersey numbers (0–99, not 69).");
        return;
      }
      if (allowReclaim && claimedCurrentChecked && !claimedCurrentNum.trim()) {
        setError("Please enter your current jersey number, or uncheck the keep-my-number option.");
        return;
      }
      if (allowReclaim && claimedCurrentChecked && claimedCurrent === null) {
        setError("Current jersey number must be valid (0–99, not 69).");
        return;
      }
    }

    const payload = {
      type: "h2h:preorder:ready",
      pref1: p1, pref2: p2, pref3: p3,
      anyNumber: collectPrefs ? anyNumber : true,
      claimedCurrent,
      firstName: firstName.trim(), lastName: lastName.trim(),
      jerseyName: collectSurname ? fcfsJerseyName.trim() || null : null,
      yob: yobNum, ageGroup: resolvedFcfsAgeGroup,
      clubId: selectedClubId, size: selectedSize,
      gender: playerGenderAnswer,
    };
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, "*");
      }
      window.dispatchEvent(new CustomEvent("h2h:preorder:ready", { detail: payload }));
    } catch (_) {}
    setPreorderSubmitted(true);
  };

  // ── Auto-scroll: nudge the customer to each newly-revealed section instead of
  // relying on them to notice and scroll manually (see useScrollIntoViewOnReveal). ──
  const genderPromptRef = useRef<HTMLDivElement>(null);
  const identityConfirmRef = useRef<HTMLDivElement>(null);
  const keepPromptRef = useRef<HTMLDivElement>(null);
  const playingUpPromptRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  useScrollIntoViewOnReveal(genderPromptRef, needsGenderPrompt);
  useScrollIntoViewOnReveal(identityConfirmRef, needsIdentityConfirm);
  useScrollIntoViewOnReveal(keepPromptRef, needsKeepPrompt && !lookingUpPlayer);
  useScrollIntoViewOnReveal(playingUpPromptRef, needsPlayingUpPrompt);
  useScrollIntoViewOnReveal(suggestionsRef, suggestions.length > 0);
  // Deliberately no auto-scroll when a number is picked: the suggestions grid, the
  // disclaimer checkbox, and the Confirm & Reserve button are already all visible
  // together on screen at that point -- scrolling here risked carrying the disclaimer
  // checkbox off-screen past the customer's eye line, right before the one step they
  // must not skip.

  // Production: render nothing until a club mapping is confirmed.
  // The iframe starts at opacity:0 in widget.js and only reveals on h2h:resize
  // with height > 80px. Returning an empty div here keeps scrollHeight = 0,
  // so non-H2H product pages stay invisible throughout (no flash, no layout shift).
  if (!demoMode && !selectedClubId) {
    return <div ref={widgetRootRef} />;
  }

  return (
    <div ref={widgetRootRef} className="w-full max-w-[440px]">
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

        {/* Pre-order: window closed or locked */}
        {(preorderMode === "closed" || preorderMode === "locked") && (
          <div className="py-6 text-center">
            <div className="text-3xl mb-2">🏀</div>
            <p className="font-semibold text-gray-900">Pre-orders are now closed</p>
            <p className="text-sm text-gray-500 mt-2">
              Jersey number preferences are being allocated. Your club will notify you of the outcome soon.
            </p>
          </div>
        )}

        {/* Pre-allocated: window open — player confirms size + jersey name */}
        {preorderMode === "open" && allocationTypeState === "pre_allocated" && (
          paSubmitted && paSelected ? (
            <div className="py-6 text-center">
              <div className="text-3xl mb-2">✅</div>
              <p className="font-semibold text-gray-900">All done!</p>
              <p className="text-sm text-gray-600 mt-2">
                Your jersey number is <span className="font-bold text-indigo-700">#{paSelected.assignedNumber}</span> and
                will be printed as <span className="font-bold">{paJerseyName}</span> in size <span className="font-bold">{selectedSize || paSize}</span>.
              </p>
              <p className="text-xs text-gray-500 mt-2">Please continue to checkout to complete your order.</p>
            </div>
          ) : (
            <>
              {paError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
                  {paError}
                </div>
              )}

              {/* Step 1: Name + DOB entry */}
              {!paSelected && (
                <>
                  <p className="text-xs text-gray-500">Your jersey number has already been allocated by the club. Enter your details below to confirm your size.</p>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Player's First Name</label>
                    <input type="text" className="border rounded px-3 py-2 w-full text-base" placeholder="First name" value={paFirstName} onChange={e => { setPaFirstName(e.target.value); setPaLookupDone(false); setPaCandidates([]); }} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Player's Surname</label>
                    <input type="text" className="border rounded px-3 py-2 w-full text-base" placeholder="Last name" value={paLastName} onChange={e => { setPaLastName(e.target.value); setPaLookupDone(false); setPaCandidates([]); }} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Year of Birth <span className="normal-case font-normal text-gray-400">(optional)</span></label>
                    <input type="number" className="border rounded px-3 py-2 w-full text-base" placeholder="e.g. 2008" value={paYob} onChange={e => { setPaYob(e.target.value); setPaLookupDone(false); setPaCandidates([]); }} />
                  </div>

                  <button
                    type="button"
                    onClick={handlePreAllocLookup}
                    disabled={paLooking}
                    className="w-full px-4 py-2 rounded font-semibold text-sm bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                  >
                    {paLooking ? "Searching…" : "Find My Record"}
                  </button>

                  {/* Lookup results */}
                  {paLookupDone && paCandidates.length === 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-900">
                      We couldn't find a match in our records. Please check the spelling, or make sure you're entering the <strong>player's</strong> name (not a parent's name).
                    </div>
                  )}
                  {paLookupDone && paCandidates.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">We found the following — is one of these the player?</p>
                      <div className="space-y-2">
                        {paCandidates.map(c => (
                          <div key={c.id} className="flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded p-3">
                            <div>
                              <span className="font-semibold text-gray-900">{c.firstName} {c.lastName}</span>
                              <span className="ml-2 text-indigo-700 font-bold">#{c.assignedNumber}</span>
                              {c.alreadyConfirmed && <span className="ml-2 text-xs text-green-700">(size already confirmed)</span>}
                            </div>
                            <button
                              type="button"
                              onClick={() => handlePreAllocSelectCandidate(c)}
                              className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded hover:bg-indigo-700"
                            >
                              Yes, that's me
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => { setPaLookupDone(false); setPaCandidates([]); }}
                          className="text-xs text-gray-500 underline"
                        >
                          None of these are me — try again
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Step 2: Confirm number + jersey name + size */}
              {paSelected && (
                <>
                  <div className="bg-indigo-50 border border-indigo-200 rounded p-3">
                    <p className="text-sm font-semibold text-indigo-900">Your jersey number is <span className="text-2xl font-bold">#{paSelected.assignedNumber}</span></p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
                      Name on Jersey <span className="font-normal text-gray-400 normal-case">(last name only)</span>
                    </label>
                    <input
                      type="text"
                      className="border rounded px-3 py-2 w-full text-base uppercase"
                      value={paJerseyName}
                      onChange={e => {
                        const v = e.target.value.replace(/[^A-Za-z'\-]/g, "");
                        setPaJerseyName(v.toUpperCase());
                      }}
                      maxLength={25}
                      placeholder="SMITH"
                    />
                    <p className="text-xs text-gray-500 mt-1">Correct the spelling if needed. Letters, hyphens, and apostrophes only.</p>
                  </div>

                  {/* Size: use Shopify variant if available, otherwise show input */}
                  {!selectedSize && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Size</label>
                      <input
                        type="text"
                        className="border rounded px-3 py-2 w-full text-base"
                        placeholder="e.g. S, M, L, XL, 2XL"
                        value={paSize}
                        onChange={e => setPaSize(e.target.value)}
                      />
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setPaSelected(null); setPaJerseyName(""); setPaSize(""); setPaError(null); }}
                      className="px-4 py-2 border border-gray-300 text-gray-700 rounded text-sm font-medium hover:bg-gray-50"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={handlePreAllocConfirm}
                      disabled={paSubmitting}
                      className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                    >
                      {paSubmitting ? "Saving…" : "Confirm"}
                    </button>
                  </div>
                </>
              )}
            </>
          )
        )}

        {/* Pre-order FCFS: window open */}
        {preorderMode === "open" && allocationTypeState === "fcfs" && (
          preorderSubmitted ? (
            <div className="py-6 text-center">
              <div className="text-3xl mb-2">✅</div>
              <p className="font-semibold text-gray-900">Preferences submitted!</p>
              <p className="text-sm text-gray-500 mt-2">
                Your jersey number preferences have been recorded. The club will allocate numbers and let you know before jerseys are produced.
              </p>
            </div>
          ) : (
            <>
              {/* First name */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">First Name</label>
                <input type="text" className="border rounded px-3 py-2 w-full text-base" placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
              </div>

              {/* Surname */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Surname</label>
                <input type="text" className="border rounded px-3 py-2 w-full text-base" placeholder="Surname" value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </div>

              {/* Surname to be printed (optional — only when collect_surname is on) */}
              {wc?.collect_surname && (
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Surname to be printed</label>
                  <input
                    type="text"
                    className="border rounded px-3 py-2 w-full text-base uppercase"
                    placeholder="SMITH"
                    value={fcfsJerseyName}
                    onChange={(e) => setFcfsJerseyName(e.target.value.replace(/[^A-Za-z'\-]/g, "").toUpperCase())}
                    maxLength={25}
                  />
                  <p className="text-xs text-gray-500 mt-1">Will be printed on the back of your jersey. Edit if needed. Letters, hyphens, and apostrophes only.</p>
                </div>
              )}

              {/* Year of Birth */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Year of Birth</label>
                <input
                  type="number"
                  className="border rounded px-3 py-2 w-full text-base"
                  placeholder="e.g. 2013"
                  value={yearOfBirth}
                  onChange={(e) => { setYearOfBirth(e.target.value); setYobOverflowConfirmed(null); }}
                />
              </div>

              {/* YOB overflow prompt (auto_yob mode — age exceeds all configured brackets) */}
              {fcfsYobOverflowGroupLabel && yobOverflowConfirmed === null && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-3">
                  <p className="text-sm text-amber-900">
                    Is your year of birth <strong>{yearOfBirth}</strong> correct? This would place you above our oldest age group (<strong>{fcfsYobOverflowGroupLabel}</strong>). Would you like to continue?
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setYobOverflowConfirmed(true)}
                      className="px-4 py-2 rounded border text-sm font-semibold bg-amber-700 border-amber-800 text-white hover:bg-amber-800"
                    >Yes, continue</button>
                    <button
                      type="button"
                      onClick={() => { setYearOfBirth(""); setYobOverflowConfirmed(null); }}
                      className="px-4 py-2 rounded border text-sm font-semibold bg-white border-gray-300 text-gray-800 hover:bg-gray-50"
                    >No, re-enter</button>
                  </div>
                </div>
              )}

              {/* Customer selects age group (customer_select mode) */}
              {wc?.age_group_mode === "customer_select" && (
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Age Group</label>
                  <select
                    className="border rounded px-3 py-2 w-full text-sm"
                    value={customerSelectedAgeGroup}
                    onChange={(e) => setCustomerSelectedAgeGroup(e.target.value)}
                  >
                    <option value="">Select your age group</option>
                    {(wc.age_groups ?? []).map((g) => (
                      <option key={g.label} value={g.label}>{g.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Gender (conditional — collect_gender defaults to true for backwards compat) */}
              {(wc?.collect_gender ?? true) && (
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Gender</label>
                  <div className="flex gap-4">
                    {(["Male", "Female"] as const).map((g) => (
                      <label key={g} className="flex items-center gap-1.5 text-sm cursor-pointer">
                        <input type="radio" name="preorder-gender" checked={playerGenderAnswer === g} onChange={() => setPlayerGenderAnswer(g)} />
                        {g}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Number preferences (conditional — collect_prefs defaults to true) */}
              {(wc?.collect_prefs !== false) && (
                <div className="border-t pt-3">
                  <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Jersey Number Preferences</div>
                  <p className="text-xs text-gray-500 mb-3">Enter up to three choices in order. Numbers are allocated first-come-first-served by payment time — earlier payers get higher priority.</p>
                  {[
                    { label: "1st choice", val: pref1, set: setPref1 },
                    { label: "2nd choice", val: pref2, set: setPref2 },
                    { label: "3rd choice", val: pref3, set: setPref3 },
                  ].map(({ label, val, set }) => (
                    <div key={label} className="flex items-center gap-2 mb-2">
                      <label className="text-xs text-gray-600 w-24 flex-shrink-0">{label}</label>
                      <input
                        type="number"
                        className="border rounded px-3 py-1.5 text-sm w-20 disabled:bg-gray-100"
                        placeholder="0–99"
                        value={val}
                        onChange={(e) => set(e.target.value)}
                        min={0}
                        max={99}
                        disabled={anyNumber}
                      />
                    </div>
                  ))}
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer mt-1">
                    <input type="checkbox" checked={anyNumber} onChange={(e) => { setAnyNumber(e.target.checked); if (e.target.checked) { setPref1(""); setPref2(""); setPref3(""); } }} />
                    Any number is fine — I have no preference
                  </label>
                </div>
              )}

              {/* Reclaim current number (conditional — allow_reclaim defaults to true) */}
              {(wc?.allow_reclaim ?? true) && (
                <div>
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={claimedCurrentChecked} onChange={(e) => { setClaimedCurrentChecked(e.target.checked); if (!e.target.checked) setClaimedCurrentNum(""); }} />
                    I have a current jersey number I'd like to request again (not guaranteed)
                  </label>
                  {claimedCurrentChecked && (
                    <div className="flex items-center gap-2 mt-2">
                      <label className="text-xs text-gray-600">My current number:</label>
                      <input type="number" className="border rounded px-3 py-1.5 text-sm w-20" placeholder="0–99" value={claimedCurrentNum} onChange={(e) => setClaimedCurrentNum(e.target.value)} min={0} max={99} />
                    </div>
                  )}
                </div>
              )}

              <button type="button" onClick={handlePreorderSubmit} className="w-full px-4 py-2 rounded font-semibold text-sm bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
                Submit Preferences
              </button>
            </>
          )
        )}

        {/* Normal mode — not a pre-order window */}
        {preorderMode === "off" && <>

        {/* First Name */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            First Name
          </label>
          <input
            type="text"
            className="border rounded px-3 py-2 w-full text-base"
            placeholder="First name"
            value={firstName}
            onChange={(e) => {
              setFirstName(e.target.value);
              // Reset lookup if name changes
              setIsNewPlayer(null);
              setExistingPlayerJersey(null);
              setExistingPlayerInventoryId(null);
              setKeepExistingJersey(null);
              setPlayingUp(null);
              setMatchedPlayerId(null);
              setMatchedPlayerDisplayName(null);
              setMatchedPlayerDivisionCode(null);
              setMatchedPlayerTeamName(null);
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
            className="border rounded px-3 py-2 w-full text-base"
            placeholder="Surname"
            value={lastName}
            onChange={(e) => {
              setLastName(e.target.value);
              setIsNewPlayer(null);
              setExistingPlayerJersey(null);
              setExistingPlayerInventoryId(null);
              setKeepExistingJersey(null);
              setPlayingUp(null);
              setMatchedPlayerId(null);
              setMatchedPlayerDisplayName(null);
              setMatchedPlayerDivisionCode(null);
              setMatchedPlayerTeamName(null);
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
            className="border rounded px-3 py-2 w-full text-base"
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

        {/* Player gender — only asked for single/unisex-product clubs. Dual-product
            (mens/womens) clubs already know this from which Shopify product was bought. */}
        {needsGenderPrompt && (
          <div ref={genderPromptRef}>
            <label className="block text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              Player's Gender
            </label>
            <div className="flex gap-2">
              {(["Female", "Male"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setPlayerGenderAnswer(g)}
                  className={[
                    "px-5 py-2 rounded border text-sm font-semibold transition-colors",
                    playerGenderAnswer === g
                      ? "bg-indigo-600 border-indigo-700 text-white"
                      : "bg-white border-gray-300 text-gray-800 hover:bg-gray-50",
                  ].join(" ")}
                >
                  {g}
                </button>
              ))}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Needed to find the right team — some divisions (e.g. Junior, Open Girls) are girls-only and named differently from the standard age groups.
            </div>
          </div>
        )}

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
          <div ref={identityConfirmRef} className="bg-amber-50 border border-amber-200 rounded p-3">
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
                  setMatchedPlayerDivisionCode(null);
                  setMatchedPlayerTeamName(null);
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
          <div ref={keepPromptRef} className="bg-blue-50 border border-blue-200 rounded p-3">
            <div className="text-sm font-semibold text-blue-900 mb-2">
              Our records show you already have jersey #{existingPlayerJersey}.
            </div>
            <label className="block text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              Still keeping #{existingPlayerJersey}?
            </label>
            <YesNoButtons
              value={keepExistingJersey}
              onChange={(v) => {
                setKeepExistingJersey(v);
                if (v === false) setPlayingUp(null);
              }}
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

        {/* Playing up? — only shown after keeping existing jersey is confirmed */}
        {needsPlayingUpPrompt && (
          <div ref={playingUpPromptRef} className="bg-violet-50 border border-violet-200 rounded p-3">
            <div className="text-sm font-semibold text-violet-900 mb-1">
              Are you also playing up an age group?
            </div>
            <div className="text-xs text-violet-700 mb-2">
              e.g. a U14 player also playing in U16 games and needing a separate jersey for those games.
            </div>
            <YesNoButtons
              value={playingUp}
              onChange={(v) => setPlayingUp(v)}
              yesLabel="Yes, playing up"
              noLabel="No, just need a spare"
            />
          </div>
        )}

        {/* Team */}
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Team
          </label>
          <select
            className="border rounded px-3 py-2 w-full text-base"
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
            className="border rounded px-3 py-2 w-full text-base"
            placeholder="e.g. 23"
            value={preferredNumber}
            onChange={(e) => setPreferredNumber(e.target.value)}
          />
        </div>

        {/* Check & Suggest */}
        <button
          type="button"
          onClick={() => void handleFindNumbers()}
          disabled={loadingSuggest || lookingUpPlayer}
          className="w-full px-4 py-2 rounded font-semibold text-sm bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-600 transition-colors"
        >
          {loadingSuggest || lookingUpPlayer ? "Checking…" : suggestions.length > 0 ? "Refresh Numbers" : "Find Available Numbers"}
        </button>

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div ref={suggestionsRef} className="pt-1">
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

        {/* Disclaimer — shown once suggestions are available */}
        {suggestions.length > 0 && (
          <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={disclaimerChecked}
              onChange={(e) => setDisclaimerChecked(e.target.checked)}
            />
            <span>
              I accept responsibility for ensuring my playing number won't clash with other players in my team.
            </span>
          </label>
        )}

        {/* Confirm & Reserve */}
        {selectedNumber !== null && (
          <button
            type="button"
            onClick={handleReserve}
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

        </>}
      </div>
    </div>
  );
};

export default JerseyWidget;
