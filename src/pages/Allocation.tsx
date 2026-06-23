// FILE: src/pages/Allocation.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  smartCheckNumber,
  suggestNumbersForClub,
  ClashPlayer,
  StockBySize,
  NumberSuggestion,
  allocateNumberForClub,
  returnJerseyToStock,
  logAllocationEvent,
} from "../services/allocation";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface ClubPlayer {
  id: string;
  first_name: string;
  last_name: string;
  division_code: string | null; // e.g. "JGC1" or "14B.1"
  team_name: string | null;     // e.g. "BLAZES", null for Seahawks format
  age_group: string | null;     // e.g. "U14"
  final_shirt: number | null;
  year_of_birth: number | null;
}

const SWAP_REASONS = [
  "Size exchange",
  "Damaged jersey",
  "Number preference",
  "Admin correction",
  "Other",
];

const Allocation: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  // Product type (default/mens/womens) -- a dual-product club has a separate stock
  // pool per type. Everything below (sizes, suggestions, checks, allocation,
  // exchange, returns) must operate against the SAME product type consistently.
  const [productTypeOptions, setProductTypeOptions] = useState<string[]>(["default"]);
  const [selectedProductType, setSelectedProductType] = useState<string>("default");

  const [sizes, setSizes] = useState<string[]>([]);
  const [selectedSize, setSelectedSize] = useState<string>("");

  const [clubPlayers, setClubPlayers] = useState<ClubPlayer[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>("");

  // Player search
  const [playerSearch, setPlayerSearch] = useState<string>("");

  const [preferredNumber, setPreferredNumber] = useState<string>("");
  const [yearOfBirth, setYearOfBirth] = useState<string>("");

  const [statusMessage, setStatusMessage] = useState<string>("");
  const [clashes, setClashes] = useState<ClashPlayer[]>([]);
  const [softWarnings, setSoftWarnings] = useState<ClashPlayer[]>([]);
  const [stockBySize, setStockBySize] = useState<StockBySize[]>([]);
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);

  const [loadingClubs, setLoadingClubs] = useState(false);
  const [loadingSizes, setLoadingSizes] = useState(false);
  const [loadingPlayers, setLoadingPlayers] = useState(false);
  const [checking, setChecking] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [allocating, setAllocating] = useState(false);
  const [endingAllocation, setEndingAllocation] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [allocationMessage, setAllocationMessage] = useState<string>("");

  // Return-to-stock state (warehouse)
  const [returnNumber, setReturnNumber] = useState<string>("");
  const [returnSize, setReturnSize] = useState<string>("");
  const [returnBusy, setReturnBusy] = useState(false);
  const [returnMessage, setReturnMessage] = useState<string>("");

  // All configured sizes for the club (used by return-to-stock dropdown)
  const [clubSizes, setClubSizes] = useState<string[]>([]);

  // Exchange / swap workflow state
  const [swapSize, setSwapSize] = useState<string>("");
  const [swapNumber, setSwapNumber] = useState<string>("");
  const [swapReason, setSwapReason] = useState<string>(SWAP_REASONS[0]);
  const [swapSuggestions, setSwapSuggestions] = useState<NumberSuggestion[]>([]);
  const [swapSuggesting, setSwapSuggesting] = useState(false);
  const [swapBusy, setSwapBusy] = useState(false);

  // Helper: current player object
  const currentPlayer =
    clubPlayers.find((p) => p.id === selectedPlayerId) ?? null;

  // Filtered player search results
  const filteredPlayers = useMemo(() => {
    const needle = playerSearch.trim().toLowerCase();
    if (!needle) return [];
    return clubPlayers
      .filter((p) => {
        const fullName = `${p.first_name} ${p.last_name}`.toLowerCase();
        const reversed = `${p.last_name} ${p.first_name}`.toLowerCase();
        const numStr = p.final_shirt != null ? String(p.final_shirt) : "";
        return (
          fullName.includes(needle) ||
          reversed.includes(needle) ||
          numStr === needle
        );
      })
      .slice(0, 10);
  }, [playerSearch, clubPlayers]);

  // Helper: derive team context from the selected player for team-aware clash logic
  const deriveTeamContext = () => {
    if (!currentPlayer) return {};
    return {
      divisionCode: currentPlayer.division_code ?? null,
      teamName: currentPlayer.team_name ?? null,
      ageGroup: currentPlayer.age_group ?? null,
    };
  };

  // Helper: derive the YOB to use for cohort logic (fallback / widget compat)
  const deriveCohortYear = (): number | undefined => {
    if (yearOfBirth) {
      const typed = Number(yearOfBirth);
      if (Number.isFinite(typed)) return typed;
    }
    if (
      currentPlayer &&
      typeof currentPlayer.year_of_birth === "number" &&
      Number.isFinite(currentPlayer.year_of_birth)
    ) {
      return currentPlayer.year_of_birth;
    }
    return undefined;
  };

  // Load client clubs
  useEffect(() => {
    const loadClubs = async () => {
      setLoadingClubs(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from("clubs")
          .select("id, name, is_client")
          .eq("is_client", true)
          .order("name", { ascending: true });

        if (error) {
          console.error("loadClubs error", error);
          setError("Failed to load clubs.");
          return;
        }

        const clubList = (data ?? []) as Club[];
        setClubs(clubList);
        if (clubList.length > 0) setSelectedClubId(clubList[0].id);
      } finally {
        setLoadingClubs(false);
      }
    };

    loadClubs();
  }, []);

  // Load which product types this club actually has Shopify products for
  useEffect(() => {
    const loadProductTypes = async () => {
      if (!selectedClubId) {
        setProductTypeOptions(["default"]);
        setSelectedProductType("default");
        return;
      }
      const { data } = await supabase
        .from("shopify_product_club_map")
        .select("product_type")
        .eq("club_id", selectedClubId);

      const mapped = Array.from(
        new Set((data ?? []).map((r: any) => (r.product_type || "default").trim()))
      );
      const options = Array.from(new Set(["default", ...mapped]));
      setProductTypeOptions(options);
      setSelectedProductType((prev) => (options.includes(prev) ? prev : "default"));
    };
    void loadProductTypes();
  }, [selectedClubId]);

  // Load available sizes for selected club + product type
  useEffect(() => {
    const loadSizes = async () => {
      if (!selectedClubId) {
        setSizes([]);
        setSelectedSize("");
        setSwapSize("");
        return;
      }

      setLoadingSizes(true);
      setError(null);

      try {
        const { data, error } = await supabase
          .from("inventory")
          .select("size")
          .eq("club_id", selectedClubId)
          .eq("product_type", selectedProductType)
          .eq("status", "Available");

        if (error) {
          console.error("loadSizes error", error);
          setError("Failed to load sizes from inventory.");
          return;
        }

        const unique = Array.from(
          new Set((data ?? []).map((row: any) => String(row.size ?? "")))
        )
          .filter((s) => s.length > 0)
          .sort();

        setSizes(unique);
        setSelectedSize(unique[0] ?? "");
        setSwapSize(unique[0] ?? "");
      } finally {
        setLoadingSizes(false);
      }
    };

    loadSizes();
  }, [selectedClubId, selectedProductType]);

  // Load players for selected club
  useEffect(() => {
    const loadPlayers = async () => {
      if (!selectedClubId) {
        setClubPlayers([]);
        setSelectedPlayerId("");
        setPlayerSearch("");
        return;
      }

      setLoadingPlayers(true);
      setError(null);

      try {
        const { data, error } = await supabase
          .from("players")
          .select(
            "id, first_name, last_name, division_code, team_name, age_group, final_shirt, year_of_birth"
          )
          .eq("club_id", selectedClubId)
          .order("last_name", { ascending: true })
          .order("first_name", { ascending: true });

        if (error) {
          console.error("loadPlayers error", error);
          setError("Failed to load players for this club.");
          return;
        }

        const list = (data ?? []) as ClubPlayer[];
        setClubPlayers(list);
        setSelectedPlayerId("");
        setPlayerSearch("");
      } finally {
        setLoadingPlayers(false);
      }
    };

    loadPlayers();
  }, [selectedClubId]);

  // Load all configured sizes for the selected club (for return-to-stock dropdown)
  useEffect(() => {
    const loadClubSizes = async () => {
      if (!selectedClubId) {
        setClubSizes([]);
        setReturnSize("");
        return;
      }

      const { data } = await supabase
        .from("club_sizes")
        .select("size_label, sort_order")
        .eq("club_id", selectedClubId)
        .eq("product_type", selectedProductType)
        .order("sort_order", { ascending: true })
        .order("size_label", { ascending: true });

      const labels = (data ?? []).map((r: any) => String(r.size_label ?? "")).filter(Boolean);
      setClubSizes(labels);
      setReturnSize(labels[0] ?? "");
    };

    void loadClubSizes();
  }, [selectedClubId, selectedProductType]);

  // Clear swap suggestions when size changes
  useEffect(() => {
    setSwapSuggestions([]);
    setSwapNumber("");
  }, [swapSize]);

  const handleClubChange = (clubId: string) => {
    setSelectedClubId(clubId);
    setSelectedPlayerId("");
    setPlayerSearch("");
    setStatusMessage("");
    setClashes([]);
    setSoftWarnings([]);
    setStockBySize([]);
    setSuggestions([]);
    setAllocationMessage("");
    setPreferredNumber("");
    setYearOfBirth("");
    setSwapNumber("");
    setSwapSuggestions([]);
  };

  const selectPlayer = (id: string) => {
    setSelectedPlayerId(id);
    setPlayerSearch("");
    // Reset number entry when switching player
    setPreferredNumber("");
    setStatusMessage("");
    setClashes([]);
    setSoftWarnings([]);
    setStockBySize([]);
    setSuggestions([]);
    setAllocationMessage("");
    setSwapNumber("");
    setSwapSuggestions([]);
  };

  const clearPlayer = () => {
    setSelectedPlayerId("");
    setPlayerSearch("");
    setStatusMessage("");
    setClashes([]);
    setSoftWarnings([]);
    setStockBySize([]);
    setSuggestions([]);
    setAllocationMessage("");
    setSwapNumber("");
    setSwapSuggestions([]);
  };

  const findStockForSelectedSize = (stock: StockBySize[]) => {
    if (!selectedSize) return 0;
    const entry = stock.find((s) => s.size === selectedSize);
    return entry?.count ?? 0;
  };

  const findStockForSize = (stock: StockBySize[], size: string) => {
    if (!size) return 0;
    const entry = stock.find((s) => s.size === size);
    return entry?.count ?? 0;
  };

  const handleCheckNumber = async () => {
    if (!selectedClubId) { setError("Please select a club."); return; }
    if (!selectedSize) { setError("Please select a size."); return; }
    if (!preferredNumber) { setError("Please enter a preferred number."); return; }

    const num = Number(preferredNumber);
    if (!Number.isFinite(num) || num <= 0) {
      setError("Preferred number must be a positive number.");
      return;
    }

    setError(null);
    setChecking(true);
    setStatusMessage("");
    setAllocationMessage("");
    setClashes([]);
    setSoftWarnings([]);
    setStockBySize([]);

    try {
      const yobNum = deriveCohortYear();
      const teamCtx = deriveTeamContext();
      const { clashes, softWarnings, stockBySize, statusMessage } = await smartCheckNumber(
        selectedClubId,
        num,
        { yearOfBirth: yobNum, ...teamCtx, productType: selectedProductType }
      );
      setClashes(clashes);
      setSoftWarnings(softWarnings);
      setStockBySize(stockBySize);
      setStatusMessage(statusMessage);
    } catch (err: any) {
      console.error("handleCheckNumber error", err);
      setError(err.message ?? "Failed to check number.");
    } finally {
      setChecking(false);
    }
  };

  const handleSuggestNumbers = async () => {
    if (!selectedClubId) { setError("Please select a club."); return; }
    if (!selectedSize) { setError("Please select a size."); return; }

    setError(null);
    setSuggesting(true);
    setSuggestions([]);
    setAllocationMessage("");

    try {
      const results = await suggestNumbersForClub(selectedClubId, selectedSize, 10, deriveTeamContext(), selectedProductType);
      setSuggestions(results);

      if (results.length === 0) {
        setStatusMessage(
          `No clash-free numbers with available stock for size ${selectedSize} in this club.`
        );
      } else {
        setStatusMessage(
          `Found ${results.length} clash-free numbers with available stock for size ${selectedSize}.`
        );
      }
    } catch (err: any) {
      console.error("handleSuggestNumbers error", err);
      setError(err.message ?? "Failed to suggest numbers.");
    } finally {
      setSuggesting(false);
    }
  };

  const handleUseSuggestion = (num: number) => {
    setPreferredNumber(String(num));
    setStatusMessage(
      `Selected #${num}. Click "Check Number" to validate or "Confirm Allocation" to reserve.`
    );
  };

  const handleConfirmAllocation = async () => {
    setAllocationMessage("");
    setError(null);

    if (!selectedClubId) { setError("Please select a club before confirming allocation."); return; }
    if (!selectedPlayerId) { setError("Please select a player before confirming allocation."); return; }
    if (!selectedSize) { setError("Please select a size before confirming allocation."); return; }
    if (!preferredNumber) { setError("Please enter a preferred number before confirming allocation."); return; }

    const num = Number(preferredNumber);
    if (!Number.isFinite(num) || num <= 0) {
      setError("Preferred number must be a positive number.");
      return;
    }

    const yobNum = deriveCohortYear();
    const teamCtx = deriveTeamContext();
    setAllocating(true);

    try {
      const { clashes, stockBySize } = await smartCheckNumber(selectedClubId, num, { yearOfBirth: yobNum, ...teamCtx, productType: selectedProductType });
      const stockForSize = findStockForSelectedSize(stockBySize);

      if (clashes.length > 0) {
        setAllocationMessage("Cannot allocate: this number is already worn by a teammate.");
        setAllocating(false);
        return;
      }

      if (stockForSize <= 0) {
        setAllocationMessage(`Cannot allocate: there is no available stock for size ${selectedSize} for this number.`);
        setAllocating(false);
        return;
      }

      const invResult = await allocateNumberForClub(selectedClubId, num, selectedSize, selectedProductType);

      if (!invResult.success || !invResult.inventoryId) {
        setAllocationMessage(invResult.message || "Failed to reserve stock.");
        setAllocating(false);
        return;
      }

      const inventoryId = invResult.inventoryId;
      const playerId = selectedPlayerId;

      const playerUpdate: any = { final_shirt: num };
      if (yobNum && Number.isFinite(yobNum)) playerUpdate.year_of_birth = yobNum;

      const { error: playerError } = await supabase
        .from("players")
        .update(playerUpdate)
        .eq("id", playerId);

      if (playerError) {
        console.error("Player update error", playerError);
        setAllocationMessage("Inventory reserved, but failed to update player record. Please fix player manually.");
        setAllocating(false);
        return;
      }

      const { error: invLinkError } = await supabase
        .from("inventory")
        .update({ allocated_player_id: playerId })
        .eq("id", inventoryId);

      if (invLinkError) {
        console.error("Inventory link error", invLinkError);
        setAllocationMessage("Player updated, but failed to link jersey to player in inventory.");
        setAllocating(false);
        return;
      }

      await logAllocationEvent({
        allocation_type: "new",
        club_id: selectedClubId,
        player_id: playerId,
        jersey_number: num,
        size: selectedSize,
        previous_jersey_number: null,
        previous_size: null,
        note: `New allocation: #${num} (${selectedSize})`,
        productType: selectedProductType,
      });

      setClubPlayers((prev) =>
        prev.map((p) =>
          p.id === playerId
            ? {
                ...p,
                final_shirt: num,
                year_of_birth: yobNum && Number.isFinite(yobNum) ? yobNum : p.year_of_birth,
              }
            : p
        )
      );

      setAllocationMessage(
        `Success: allocated jersey #${num} (${selectedSize}) to this player and reserved stock.`
      );

      setSuggestions([]);
      setStockBySize(stockBySize);
    } catch (err: any) {
      console.error("handleConfirmAllocation error", err);
      setError(err.message ?? "Failed to confirm allocation.");
    } finally {
      setAllocating(false);
    }
  };

  const handleEndAllocation = async () => {
    setError(null);
    setAllocationMessage("");

    if (!selectedClubId) { setError("Please select a club first."); return; }
    if (!selectedPlayerId || !currentPlayer) { setError("Please select a player first."); return; }
    if (currentPlayer.final_shirt == null) {
      setAllocationMessage("This player does not currently have an assigned number to end.");
      return;
    }

    const currentNumber = currentPlayer.final_shirt;
    setEndingAllocation(true);

    try {
      const playerId = currentPlayer.id;

      const { error: invError } = await supabase
        .from("inventory")
        .update({ status: "Available", allocated_player_id: null, allocation_date: null, return_date_due: null })
        .eq("club_id", selectedClubId)
        .eq("allocated_player_id", playerId)
        .eq("status", "Allocated");

      if (invError) {
        console.error("EndAllocation inventory update error", invError);
        setAllocationMessage("Failed to release jersey from inventory. No changes were made to the player.");
        setEndingAllocation(false);
        return;
      }

      const { error: playerError } = await supabase
        .from("players")
        .update({ final_shirt: null })
        .eq("id", playerId);

      if (playerError) {
        console.error("EndAllocation player update error", playerError);
        setAllocationMessage("Inventory jersey released, but failed to clear player number. Please fix player manually.");
        setEndingAllocation(false);
        return;
      }

      await logAllocationEvent({
        allocation_type: "end",
        club_id: selectedClubId,
        player_id: playerId,
        jersey_number: null,
        size: null,
        previous_jersey_number: currentNumber,
        previous_size: null,
        note: `End allocation: freed #${currentNumber}`,
        productType: selectedProductType,
      });

      setClubPlayers((prev) =>
        prev.map((p) => (p.id === playerId ? { ...p, final_shirt: null } : p))
      );

      setAllocationMessage(
        `Ended allocation: jersey #${currentNumber} freed from this player and returned to available stock.`
      );
      setStatusMessage(`Number ${currentNumber} is now free for reuse.`);
    } catch (err: any) {
      console.error("handleEndAllocation error", err);
      setError(err.message ?? "Failed to end allocation.");
    } finally {
      setEndingAllocation(false);
    }
  };

  const handleSwapSuggest = async () => {
    if (!selectedClubId) { setError("Please select a club first."); return; }
    if (!swapSize) { setError("Please choose a new size first."); return; }

    setError(null);
    setSwapSuggesting(true);
    setSwapSuggestions([]);

    try {
      const results = await suggestNumbersForClub(selectedClubId, swapSize, 10, deriveTeamContext(), selectedProductType);
      setSwapSuggestions(results);
      if (results.length === 0) {
        setAllocationMessage(`No clash-free numbers with stock in size ${swapSize} for this club.`);
      }
    } catch (err: any) {
      console.error("handleSwapSuggest error", err);
      setError(err.message ?? "Failed to suggest numbers for exchange.");
    } finally {
      setSwapSuggesting(false);
    }
  };

  const handleSwapJersey = async () => {
    setError(null);
    setAllocationMessage("");

    if (!selectedClubId) { setError("Please select a club first."); return; }
    if (!currentPlayer || !selectedPlayerId) { setError("Please select a player to exchange jerseys for."); return; }
    if (!swapSize) { setError("Please choose a new jersey size."); return; }
    if (!swapNumber) { setError("Please select or enter a new jersey number."); return; }

    const newNumber = Number(swapNumber);
    if (!Number.isFinite(newNumber) || newNumber <= 0) {
      setError("New jersey number must be a positive number.");
      return;
    }

    const yobNum = deriveCohortYear();
    const teamCtx = deriveTeamContext();
    setSwapBusy(true);

    try {
      const { clashes, stockBySize } = await smartCheckNumber(selectedClubId, newNumber, { yearOfBirth: yobNum, ...teamCtx, productType: selectedProductType });
      const stockForNewSize = findStockForSize(stockBySize, swapSize);

      if (clashes.length > 0) {
        setAllocationMessage(`Cannot exchange: new number ${newNumber} is already worn by a teammate.`);
        setSwapBusy(false);
        return;
      }

      if (stockForNewSize <= 0) {
        setAllocationMessage(`Cannot exchange: no available stock for size ${swapSize} with number ${newNumber}.`);
        setSwapBusy(false);
        return;
      }

      const playerId = currentPlayer.id;
      const previousNumber = currentPlayer.final_shirt ?? null;

      const { error: invFreeError } = await supabase
        .from("inventory")
        .update({ status: "Available", allocated_player_id: null, allocation_date: null, return_date_due: null })
        .eq("club_id", selectedClubId)
        .eq("allocated_player_id", playerId)
        .eq("status", "Allocated");

      if (invFreeError) {
        console.error("SwapJersey inventory free error", invFreeError);
        setAllocationMessage("Failed to free existing jersey from inventory. Exchange aborted.");
        setSwapBusy(false);
        return;
      }

      const invResult = await allocateNumberForClub(selectedClubId, newNumber, swapSize, selectedProductType);

      if (!invResult.success || !invResult.inventoryId) {
        setAllocationMessage(
          invResult.message || "Failed to reserve new jersey. Existing jersey has been freed — please re-allocate manually."
        );
        setSwapBusy(false);
        return;
      }

      const newInventoryId = invResult.inventoryId;

      const playerUpdate: any = { final_shirt: newNumber };
      if (yobNum && Number.isFinite(yobNum)) playerUpdate.year_of_birth = yobNum;

      const { error: playerUpdateError } = await supabase
        .from("players")
        .update(playerUpdate)
        .eq("id", playerId);

      if (playerUpdateError) {
        console.error("SwapJersey player update error", playerUpdateError);
        setAllocationMessage("New jersey reserved, but failed to update player record. Please fix player manually.");
        setSwapBusy(false);
        return;
      }

      const { error: invLinkError } = await supabase
        .from("inventory")
        .update({ allocated_player_id: playerId })
        .eq("id", newInventoryId);

      if (invLinkError) {
        console.error("SwapJersey inventory link error", invLinkError);
        setAllocationMessage("Player updated, but failed to link new jersey in inventory.");
        setSwapBusy(false);
        return;
      }

      // Build a descriptive log note so exchange history is readable without extra steps
      const prevDesc = previousNumber != null ? `#${previousNumber}` : "no number";
      const noteText = `${swapReason}: ${prevDesc} → #${newNumber} (${swapSize})`;

      await logAllocationEvent({
        allocation_type: "swap",
        club_id: selectedClubId,
        player_id: playerId,
        jersey_number: newNumber,
        size: swapSize,
        previous_jersey_number: previousNumber,
        previous_size: null,
        note: noteText,
        productType: selectedProductType,
      });

      setClubPlayers((prev) =>
        prev.map((p) =>
          p.id === playerId
            ? {
                ...p,
                final_shirt: newNumber,
                year_of_birth: yobNum && Number.isFinite(yobNum) ? yobNum : p.year_of_birth,
              }
            : p
        )
      );

      setAllocationMessage(
        `Exchange complete: ${currentPlayer.first_name} ${currentPlayer.last_name} now has #${newNumber} (${swapSize}). Old jersey freed, new one reserved.`
      );

      setSwapNumber("");
      setSwapSuggestions([]);
    } catch (err: any) {
      console.error("handleSwapJersey error", err);
      setError(err.message ?? "Failed to process exchange.");
    } finally {
      setSwapBusy(false);
    }
  };

  const handleReturnToStock = async () => {
    setReturnMessage("");
    setError(null);

    if (!selectedClubId) { setError("Please select a club for the return."); return; }
    if (!returnSize) { setError("Please enter the jersey size for the return."); return; }
    if (!returnNumber) { setError("Please enter the jersey number for the return."); return; }

    const num = Number(returnNumber);
    if (!Number.isFinite(num) || num <= 0) {
      setError("Return number must be a positive number.");
      return;
    }

    setReturnBusy(true);
    try {
      const result = await returnJerseyToStock(selectedClubId, num, returnSize, selectedProductType);
      setReturnMessage(result.message);
    } catch (err: any) {
      console.error("handleReturnToStock error", err);
      setError(err.message ?? "Failed to return jersey to stock.");
    } finally {
      setReturnBusy(false);
    }
  };

  const clubName = clubs.find((c) => c.id === selectedClubId)?.name ?? "";

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Jersey Allocation (Admin)</h1>
      <p className="text-sm text-gray-600 mb-6">
        Search for a player, check for number clashes, and commit allocations
        against live inventory. Hard clash = same team already using that number
        (blocked). Advisory warning = adjacent age group, different team (can
        proceed but consider another number). Use the Exchange / Swap section for
        size changes or number changes. Warehouse returns are at the bottom.
      </p>

      {/* Top form */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
        {/* Club */}
        <div>
          <label className="block text-sm font-semibold mb-1">Club</label>
          <select
            value={selectedClubId}
            onChange={(e) => handleClubChange(e.target.value)}
            className="w-full border p-2 rounded"
            disabled={loadingClubs}
          >
            {loadingClubs && <option value="">Loading clubs...</option>}
            {!loadingClubs && clubs.length === 0 && (
              <option value="">No client clubs found</option>
            )}
            {!loadingClubs &&
              clubs.map((club) => (
                <option key={club.id} value={club.id}>
                  {club.name}
                </option>
              ))}
          </select>
        </div>

        {/* Product Type */}
        <div>
          <label className="block text-sm font-semibold mb-1">Product Type</label>
          <select
            value={selectedProductType}
            onChange={(e) => setSelectedProductType(e.target.value)}
            className="w-full border p-2 rounded"
          >
            {productTypeOptions.map((pt) => (
              <option key={pt} value={pt}>
                {pt === "default" ? "Default / Unisex" : pt === "mens" ? "Mens" : pt === "womens" ? "Womens" : pt}
              </option>
            ))}
          </select>
        </div>

        {/* Size */}
        <div>
          <label className="block text-sm font-semibold mb-1">Size</label>
          <select
            value={selectedSize}
            onChange={(e) => setSelectedSize(e.target.value)}
            className="w-full border p-2 rounded"
            disabled={loadingSizes || sizes.length === 0}
          >
            {loadingSizes && <option value="">Loading sizes...</option>}
            {!loadingSizes && sizes.length === 0 && (
              <option value="">No inventory sizes found</option>
            )}
            {!loadingSizes &&
              sizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
          </select>
        </div>

        {/* Year of birth */}
        <div>
          <label className="block text-sm font-semibold mb-1">
            Year of Birth{" "}
            <span className="font-normal text-gray-500">(cohort logic)</span>
          </label>
          <input
            type="number"
            value={yearOfBirth}
            onChange={(e) => setYearOfBirth(e.target.value)}
            placeholder="e.g. 2012"
            className="w-full border p-2 rounded"
          />
          <p className="mt-1 text-xs text-gray-500">
            Leave blank to use the player&apos;s stored YOB. Enter manually to
            override (e.g. when a player is playing up an age group, enter the
            typical birth year of that higher group).
          </p>
        </div>

        {/* Player search */}
        <div>
          <label className="block text-sm font-semibold mb-1">
            Player{" "}
            {clubPlayers.length > 0 && (
              <span className="font-normal text-gray-500">
                ({clubPlayers.length} in club)
              </span>
            )}
          </label>

          {currentPlayer ? (
            /* Selected player chip */
            <div className="flex items-center gap-2 border rounded p-2 bg-indigo-50 border-indigo-200">
              <div className="flex-1 text-sm">
                <span className="font-semibold">
                  {currentPlayer.last_name}, {currentPlayer.first_name}
                </span>
                {(currentPlayer.division_code || currentPlayer.team_name) && (
                  <span className="text-gray-500 ml-1">
                    ({currentPlayer.division_code}{currentPlayer.team_name ? ` · ${currentPlayer.team_name}` : ""})
                  </span>
                )}
                {currentPlayer.final_shirt != null && (
                  <span className="ml-2 text-indigo-700 font-semibold">
                    #{currentPlayer.final_shirt}
                  </span>
                )}
                {currentPlayer.year_of_birth && (
                  <span className="ml-2 text-gray-500 text-xs">
                    b. {currentPlayer.year_of_birth}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={clearPlayer}
                className="text-gray-400 hover:text-gray-700 text-lg leading-none"
                title="Clear player selection"
              >
                ✕
              </button>
            </div>
          ) : (
            /* Search input + results */
            <div className="relative">
              <input
                type="text"
                value={playerSearch}
                onChange={(e) => setPlayerSearch(e.target.value)}
                placeholder={
                  loadingPlayers
                    ? "Loading players..."
                    : "Type name or jersey #..."
                }
                className="w-full border p-2 rounded"
                disabled={loadingPlayers || !selectedClubId}
                autoComplete="off"
              />
              {filteredPlayers.length > 0 && playerSearch.trim() && (
                <div className="absolute z-20 w-full bg-white border border-gray-200 rounded shadow-lg mt-1 max-h-52 overflow-y-auto">
                  {filteredPlayers.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => selectPlayer(p.id)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 border-b border-gray-100 last:border-0"
                    >
                      <span className="font-medium">
                        {p.last_name}, {p.first_name}
                      </span>
                      {(p.division_code || p.team_name) && (
                        <span className="text-gray-500 ml-1 text-xs">
                          ({p.division_code}{p.team_name ? ` · ${p.team_name}` : ""})
                        </span>
                      )}
                      {p.final_shirt != null ? (
                        <span className="ml-2 text-indigo-600 font-semibold">
                          #{p.final_shirt}
                        </span>
                      ) : (
                        <span className="ml-2 text-red-400 text-xs">
                          no number
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {playerSearch.trim() && filteredPlayers.length === 0 && !loadingPlayers && (
                <p className="text-xs text-gray-500 mt-1">
                  No players found matching &quot;{playerSearch}&quot;.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Current allocation + end allocation */}
      <div className="mb-6 border rounded-lg p-4 bg-gray-50 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-sm">
          <div>
            <h2 className="text-sm font-semibold mb-1">Current Allocation</h2>
            {currentPlayer ? (
              <>
                <div>
                  <span className="font-semibold">
                    {currentPlayer.first_name} {currentPlayer.last_name}
                  </span>
                  {(currentPlayer.division_code || currentPlayer.team_name) && (
                    <span className="text-gray-600 ml-2">
                      &mdash; {currentPlayer.division_code}{currentPlayer.team_name ? ` · ${currentPlayer.team_name}` : ""}
                    </span>
                  )}
                </div>
                <div className="text-gray-700 mt-1">
                  Current number:{" "}
                  <span className="font-semibold">
                    {currentPlayer.final_shirt ?? "None assigned"}
                  </span>
                  {currentPlayer.year_of_birth && (
                    <span className="ml-3 text-gray-500">
                      YOB: {currentPlayer.year_of_birth}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Use &quot;End Allocation&quot; to free this player&apos;s
                  number (e.g. player leaving the club). Use the Exchange
                  section below to process size swaps or number changes.
                </div>
              </>
            ) : (
              <p className="text-gray-500 text-sm">
                Search for a player above to view and manage their allocation.
              </p>
            )}
          </div>
          <div className="flex-shrink-0">
            <button
              type="button"
              onClick={handleEndAllocation}
              disabled={
                endingAllocation ||
                !currentPlayer ||
                currentPlayer.final_shirt == null
              }
              className="px-4 py-2 rounded bg-red-600 text-white text-sm disabled:bg-gray-400"
            >
              {endingAllocation ? "Ending..." : "End Allocation (free number)"}
            </button>
          </div>
        </div>

        {/* Exchange / Swap panel */}
        <div className="mt-4 border-t pt-4">
          <h3 className="text-sm font-semibold mb-1">Exchange / Swap Jersey</h3>
          <p className="text-xs text-gray-600 mb-3">
            Process a size exchange or number change. The current jersey is freed,
            clash rules are checked for the new number, and the replacement is
            reserved and linked. The exchange is logged automatically.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end mb-3">
            {/* New size */}
            <div>
              <label className="block text-xs font-semibold mb-1">
                New Size
              </label>
              <select
                value={swapSize}
                onChange={(e) => setSwapSize(e.target.value)}
                className="w-full border p-2 rounded text-sm"
                disabled={loadingSizes || sizes.length === 0}
              >
                {loadingSizes && <option value="">Loading sizes...</option>}
                {!loadingSizes && sizes.length === 0 && (
                  <option value="">No sizes found</option>
                )}
                {!loadingSizes &&
                  sizes.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
              </select>
            </div>

            {/* New number */}
            <div>
              <label className="block text-xs font-semibold mb-1">
                New Number
              </label>
              <input
                type="number"
                value={swapNumber}
                onChange={(e) => setSwapNumber(e.target.value)}
                placeholder="e.g. 23"
                className="w-full border p-2 rounded text-sm"
              />
            </div>

            {/* Reason */}
            <div>
              <label className="block text-xs font-semibold mb-1">
                Reason
              </label>
              <select
                value={swapReason}
                onChange={(e) => setSwapReason(e.target.value)}
                className="w-full border p-2 rounded text-sm"
              >
                {SWAP_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSwapSuggest}
                disabled={swapSuggesting || !selectedClubId || !swapSize}
                className="flex-1 px-3 py-2 bg-slate-600 text-white rounded text-sm disabled:bg-gray-400"
                title="Suggest available clash-free numbers for the selected size"
              >
                {swapSuggesting ? "..." : "Suggest"}
              </button>
              <button
                type="button"
                onClick={handleSwapJersey}
                disabled={swapBusy || !currentPlayer}
                className="flex-1 px-3 py-2 bg-orange-600 text-white rounded text-sm disabled:bg-gray-400"
              >
                {swapBusy ? "Processing..." : "Confirm Exchange"}
              </button>
            </div>
          </div>

          {/* Swap suggestions */}
          {swapSuggestions.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-gray-600 mb-2">
                Available clash-free numbers in size{" "}
                <span className="font-semibold">{swapSize}</span> — click to
                select:
              </p>
              <div className="flex flex-wrap gap-2">
                {swapSuggestions.map((s) => (
                  <button
                    key={s.jersey_number}
                    type="button"
                    onClick={() => setSwapNumber(String(s.jersey_number))}
                    className={`px-3 py-1 rounded border text-sm transition ${
                      swapNumber === String(s.jersey_number)
                        ? "bg-orange-600 text-white border-orange-600"
                        : "border-orange-400 text-orange-700 bg-orange-50 hover:bg-orange-100"
                    }`}
                  >
                    #{s.jersey_number} &mdash; {s.total_stock} in stock
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Number entry + fresh allocation flow */}
      <div className="mb-2">
        <h2 className="text-sm font-semibold mb-3">New Allocation</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 items-end">
        <div>
          <label className="block text-sm font-semibold mb-1">
            Preferred Number
          </label>
          <input
            type="number"
            value={preferredNumber}
            onChange={(e) => setPreferredNumber(e.target.value)}
            placeholder="e.g. 12"
            className="w-full border p-2 rounded"
          />
        </div>

        <div className="flex space-x-2">
          <button
            onClick={handleCheckNumber}
            disabled={checking}
            className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded disabled:bg-gray-400"
          >
            {checking ? "Checking..." : "Check Number"}
          </button>
          <button
            onClick={handleSuggestNumbers}
            disabled={suggesting}
            className="flex-1 px-4 py-2 bg-slate-700 text-white rounded disabled:bg-gray-400"
          >
            {suggesting ? "Suggesting..." : "Suggest Numbers"}
          </button>
        </div>

        <div>
          <button
            onClick={handleConfirmAllocation}
            disabled={allocating}
            className="w-full px-4 py-2 bg-emerald-600 text-white rounded disabled:bg-gray-400"
          >
            {allocating ? "Allocating..." : "Confirm Allocation"}
          </button>
        </div>
      </div>

      {/* Errors / status */}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}
      {statusMessage && (
        <div className="mb-2 text-sm text-indigo-700 bg-indigo-50 border border-indigo-200 rounded p-3">
          {statusMessage}
        </div>
      )}
      {allocationMessage && (
        <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-3">
          {allocationMessage}
        </div>
      )}

      {/* Suggestions (new allocation flow) */}
      {suggestions.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold mb-2">
            Clash-free numbers with stock &mdash; size {selectedSize || "—"}
          </h2>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s.jersey_number}
                onClick={() => handleUseSuggestion(s.jersey_number)}
                className="px-3 py-1 rounded border border-emerald-600 text-emerald-700 text-sm bg-emerald-50 hover:bg-emerald-100"
              >
                #{s.jersey_number} &mdash; {s.total_stock} in stock
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Hard clash details — same team, blocks allocation */}
      {clashes.length > 0 && (
        <div className="mb-4">
          <h2 className="text-sm font-semibold mb-2 text-red-700">
            ⛔ Team clash — cannot allocate (same team already uses this number)
          </h2>
          <div className="overflow-x-auto border border-red-200 rounded">
            <table className="min-w-full text-xs">
              <thead className="bg-red-50">
                <tr>
                  <th className="px-2 py-1 text-left">First Name</th>
                  <th className="px-2 py-1 text-left">Last Name</th>
                  <th className="px-2 py-1 text-left">Division / Team</th>
                  <th className="px-2 py-1 text-left">Age Group</th>
                  <th className="px-2 py-1 text-left">Number</th>
                  <th className="px-2 py-1 text-left">YOB</th>
                </tr>
              </thead>
              <tbody>
                {clashes.map((p) => (
                  <tr key={p.id} className="odd:bg-white even:bg-red-50">
                    <td className="px-2 py-1">{p.first_name}</td>
                    <td className="px-2 py-1">{p.last_name}</td>
                    <td className="px-2 py-1">
                      {p.division_code ?? "—"}
                      {p.team_name ? ` · ${p.team_name}` : ""}
                    </td>
                    <td className="px-2 py-1">{p.age_group ?? "—"}</td>
                    <td className="px-2 py-1">{p.final_shirt ?? "—"}</td>
                    <td className="px-2 py-1">{p.year_of_birth ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Soft warnings — adjacent age group, different team, advisory only */}
      {softWarnings.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold mb-2 text-amber-700">
            ⚠️ Adjacent age group advisory (different team — allocation can proceed, but consider another number)
          </h2>
          <div className="overflow-x-auto border border-amber-200 rounded">
            <table className="min-w-full text-xs">
              <thead className="bg-amber-50">
                <tr>
                  <th className="px-2 py-1 text-left">First Name</th>
                  <th className="px-2 py-1 text-left">Last Name</th>
                  <th className="px-2 py-1 text-left">Division / Team</th>
                  <th className="px-2 py-1 text-left">Age Group</th>
                  <th className="px-2 py-1 text-left">Number</th>
                  <th className="px-2 py-1 text-left">YOB</th>
                </tr>
              </thead>
              <tbody>
                {softWarnings.map((p) => (
                  <tr key={p.id} className="odd:bg-white even:bg-amber-50">
                    <td className="px-2 py-1">{p.first_name}</td>
                    <td className="px-2 py-1">{p.last_name}</td>
                    <td className="px-2 py-1">
                      {p.division_code ?? "—"}
                      {p.team_name ? ` · ${p.team_name}` : ""}
                    </td>
                    <td className="px-2 py-1">{p.age_group ?? "—"}</td>
                    <td className="px-2 py-1">{p.final_shirt ?? "—"}</td>
                    <td className="px-2 py-1">{p.year_of_birth ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Stock details */}
      {stockBySize.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-semibold mb-2">
            Inventory for this number (all sizes) &mdash; {clubName}
          </h2>
          <div className="overflow-x-auto border rounded max-w-md">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-2 py-1 text-left">Size</th>
                  <th className="px-2 py-1 text-left">Available</th>
                </tr>
              </thead>
              <tbody>
                {stockBySize.map((s) => (
                  <tr key={s.size} className="odd:bg-white even:bg-gray-50">
                    <td className="px-2 py-1">{s.size}</td>
                    <td className="px-2 py-1">{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Warehouse: return to stock */}
      <div className="border-t pt-6 mt-6">
        <h2 className="text-lg font-semibold mb-2">
          Return Jersey to Stock (Warehouse)
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          When a jersey is physically returned to the warehouse, mark it back as
          available here for{" "}
          <span className="font-semibold">{clubName || "the selected club"}</span>
          . This does not change any player record — use End Allocation or
          Exchange above if the player is also changing number.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-sm font-semibold mb-1">
              Jersey Size
            </label>
            <select
              value={returnSize}
              onChange={(e) => setReturnSize(e.target.value)}
              className="w-full border p-2 rounded"
              disabled={clubSizes.length === 0}
            >
              {clubSizes.length === 0 && (
                <option value="">No sizes configured for this club</option>
              )}
              {clubSizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1">
              Jersey Number
            </label>
            <input
              type="number"
              value={returnNumber}
              onChange={(e) => setReturnNumber(e.target.value)}
              placeholder="e.g. 12"
              className="w-full border p-2 rounded"
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={handleReturnToStock}
              disabled={returnBusy}
              className="w-full px-4 py-2 bg-slate-800 text-white rounded disabled:bg-gray-400"
            >
              {returnBusy ? "Processing..." : "Return to Stock"}
            </button>
          </div>
        </div>

        {returnMessage && (
          <div className="mb-4 text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded p-3">
            {returnMessage}
          </div>
        )}
      </div>
    </div>
  );
};

export default Allocation;
