// FILE: src/pages/Allocation.tsx
import React, { useEffect, useState } from "react";
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
  team_id: string | null;
  final_shirt: number | null;
  year_of_birth: number | null;
}

const Allocation: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  const [sizes, setSizes] = useState<string[]>([]);
  const [selectedSize, setSelectedSize] = useState<string>("");

  const [clubPlayers, setClubPlayers] = useState<ClubPlayer[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>("");

  const [preferredNumber, setPreferredNumber] = useState<string>("");
  const [yearOfBirth, setYearOfBirth] = useState<string>("");

  const [statusMessage, setStatusMessage] = useState<string>("");
  const [clashes, setClashes] = useState<ClashPlayer[]>([]);
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

  // Swap workflow state (admin)
  const [swapSize, setSwapSize] = useState<string>("");
  const [swapNumber, setSwapNumber] = useState<string>("");
  const [swapBusy, setSwapBusy] = useState(false);

  // Helper: current player object
  const currentPlayer =
    clubPlayers.find((p) => p.id === selectedPlayerId) ?? null;

  // Helper: derive the YOB to use for cohort logic
  const deriveCohortYear = (): number | undefined => {
    // 1) Prefer typed YOB
    if (yearOfBirth) {
      const typed = Number(yearOfBirth);
      if (Number.isFinite(typed)) {
        return typed;
      }
    }

    // 2) Fall back to player's stored YOB
    if (
      currentPlayer &&
      typeof currentPlayer.year_of_birth === "number" &&
      Number.isFinite(currentPlayer.year_of_birth)
    ) {
      return currentPlayer.year_of_birth;
    }

    // 3) No YOB → cohort logic disabled, use club-wide fallback
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

        if (clubList.length > 0) {
          setSelectedClubId(clubList[0].id);
        }
      } finally {
        setLoadingClubs(false);
      }
    };

    loadClubs();
  }, []);

  // Load available sizes for selected club (from inventory)
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
          .eq("status", "Available");

        if (error) {
          console.error("loadSizes error", error);
          setError("Failed to load sizes from inventory.");
          return;
        }

        const unique = Array.from(
          new Set((data ?? []).map((row: any) => String(row.size ?? "")))
        ).filter((s) => s.length > 0);

        unique.sort();

        setSizes(unique);
        setSelectedSize(unique[0] ?? "");
        setSwapSize(unique[0] ?? "");
      } finally {
        setLoadingSizes(false);
      }
    };

    loadSizes();
  }, [selectedClubId]);

  // Load players for selected club
  useEffect(() => {
    const loadPlayers = async () => {
      if (!selectedClubId) {
        setClubPlayers([]);
        setSelectedPlayerId("");
        return;
      }

      setLoadingPlayers(true);
      setError(null);

      try {
        const { data, error } = await supabase
          .from("players")
          .select(
            "id, first_name, last_name, team_id, final_shirt, year_of_birth"
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
        setSelectedPlayerId(list[0]?.id ?? "");
      } finally {
        setLoadingPlayers(false);
      }
    };

    loadPlayers();
  }, [selectedClubId]);

  const handleClubChange = (clubId: string) => {
    setSelectedClubId(clubId);

    // Reset state when club changes
    setSelectedPlayerId("");
    setStatusMessage("");
    setClashes([]);
    setStockBySize([]);
    setSuggestions([]);
    setAllocationMessage("");
    setPreferredNumber("");
    setYearOfBirth("");
    setSwapNumber("");
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
    if (!selectedClubId) {
      setError("Please select a club.");
      return;
    }
    if (!selectedSize) {
      setError("Please select a size.");
      return;
    }
    if (!preferredNumber) {
      setError("Please enter a preferred number.");
      return;
    }

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
    setStockBySize([]);

    try {
      const yobNum = deriveCohortYear();

      const { clashes, stockBySize, statusMessage } =
        await smartCheckNumber(selectedClubId, num, {
          yearOfBirth: yobNum,
          // seasonYear: 2025 // optional: could be configurable later
        });

      setClashes(clashes);
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
    if (!selectedClubId) {
      setError("Please select a club.");
      return;
    }
    if (!selectedSize) {
      setError("Please select a size.");
      return;
    }

    setError(null);
    setSuggesting(true);
    setSuggestions([]);
    setAllocationMessage("");

    try {
      const results = await suggestNumbersForClub(
        selectedClubId,
        selectedSize,
        10
      );
      setSuggestions(results);

      if (results.length === 0) {
        setStatusMessage(
          `There are no clash-free numbers with available stock for size ${selectedSize} in this club.`
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
      `Using suggested number ${num}. Click "Check Number" to validate or "Confirm Allocation" to reserve stock.`
    );
  };

  const handleConfirmAllocation = async () => {
    setAllocationMessage("");
    setError(null);

    if (!selectedClubId) {
      setError("Please select a club before confirming allocation.");
      return;
    }
    if (!selectedPlayerId) {
      setError("Please select a player before confirming allocation.");
      return;
    }
    if (!selectedSize) {
      setError("Please select a size before confirming allocation.");
      return;
    }
    if (!preferredNumber) {
      setError("Please enter a preferred number before confirming allocation.");
      return;
    }

    const num = Number(preferredNumber);
    if (!Number.isFinite(num) || num <= 0) {
      setError("Preferred number must be a positive number.");
      return;
    }

    const yobNum = deriveCohortYear();

    setAllocating(true);

    try {
      // Re-check clashes + stock at commit time to keep it safe
      const { clashes, stockBySize } = await smartCheckNumber(
        selectedClubId,
        num,
        {
          yearOfBirth: yobNum,
        }
      );

      const stockForSize = findStockForSelectedSize(stockBySize);

      if (clashes.length > 0) {
        setAllocationMessage(
          `Cannot allocate: this number still clashes in the effective cohort.`
        );
        setAllocating(false);
        return;
      }

      if (stockForSize <= 0) {
        setAllocationMessage(
          `Cannot allocate: there is no available stock for size ${selectedSize} for this number.`
        );
        setAllocating(false);
        return;
      }

      // 1) Reserve inventory row
      const invResult = await allocateNumberForClub(
        selectedClubId,
        num,
        selectedSize
      );

      if (!invResult.success || !invResult.inventoryId) {
        setAllocationMessage(invResult.message || "Failed to reserve stock.");
        setAllocating(false);
        return;
      }

      const inventoryId = invResult.inventoryId;
      const playerId = selectedPlayerId;

      // 2) Update player final_shirt and optionally year_of_birth
      const playerUpdate: any = { final_shirt: num };
      if (yobNum && Number.isFinite(yobNum)) {
        playerUpdate.year_of_birth = yobNum;
      }

      const { error: playerError } = await supabase
        .from("players")
        .update(playerUpdate)
        .eq("id", playerId);

      if (playerError) {
        console.error("Player update error", playerError);
        setAllocationMessage(
          "Inventory reserved, but failed to update player record. Please fix player manually."
        );
        setAllocating(false);
        return;
      }

      // 3) Attach inventory row to player
      const { error: invLinkError } = await supabase
        .from("inventory")
        .update({ allocated_player_id: playerId })
        .eq("id", inventoryId);

      if (invLinkError) {
        console.error("Inventory link error", invLinkError);
        setAllocationMessage(
          "Player updated, but failed to link jersey to player in inventory."
        );
        setAllocating(false);
        return;
      }

      // 4) Log allocation event
      await logAllocationEvent({
        allocation_type: "new",
        club_id: selectedClubId,
        player_id: playerId,
        jersey_number: num,
        size: selectedSize,
        previous_jersey_number: null,
        previous_size: null,
        note: "New allocation from admin panel",
      });

      // Update local snapshot so UI reflects latest number/YOB
      setClubPlayers((prev) =>
        prev.map((p) =>
          p.id === playerId
            ? {
                ...p,
                final_shirt: num,
                year_of_birth:
                  yobNum && Number.isFinite(yobNum)
                    ? yobNum
                    : p.year_of_birth,
              }
            : p
        )
      );

      setAllocationMessage(
        `Success: allocated jersey #${num} (${selectedSize}) to this player and reserved stock in inventory.`
      );

      // Clear suggestions (stock changed) and refresh stock view for this number
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

    if (!selectedClubId) {
      setError("Please select a club first.");
      return;
    }

    if (!selectedPlayerId || !currentPlayer) {
      setError("Please select a player first.");
      return;
    }

    if (currentPlayer.final_shirt == null) {
      setAllocationMessage(
        "This player does not currently have an assigned number to end."
      );
      return;
    }

    const currentNumber = currentPlayer.final_shirt;

    setEndingAllocation(true);
    try {
      const playerId = currentPlayer.id;

      // 1) Free any inventory rows allocated to this player in this club
      const { error: invError } = await supabase
        .from("inventory")
        .update({
          status: "Available",
          allocated_player_id: null,
          allocation_date: null,
          return_date_due: null,
        })
        .eq("club_id", selectedClubId)
        .eq("allocated_player_id", playerId)
        .eq("status", "Allocated");

      if (invError) {
        console.error("EndAllocation inventory update error", invError);
        setAllocationMessage(
          "Failed to release jersey from inventory. No changes were made to the player."
        );
        setEndingAllocation(false);
        return;
      }

      // 2) Clear the player's final_shirt
      const { error: playerError } = await supabase
        .from("players")
        .update({ final_shirt: null })
        .eq("id", playerId);

      if (playerError) {
        console.error("EndAllocation player update error", playerError);
        setAllocationMessage(
          "Inventory jersey released, but failed to clear player number. Please fix player manually."
        );
        setEndingAllocation(false);
        return;
      }

      // 3) Log event
      await logAllocationEvent({
        allocation_type: "end",
        club_id: selectedClubId,
        player_id: playerId,
        jersey_number: null,
        size: null,
        previous_jersey_number: currentNumber,
        previous_size: null,
        note: "End allocation from admin panel",
      });

      // 4) Update local state so UI reflects the change
      setClubPlayers((prev) =>
        prev.map((p) =>
          p.id === playerId
            ? {
                ...p,
                final_shirt: null,
              }
            : p
        )
      );

      setAllocationMessage(
        `Ended allocation: jersey #${currentNumber} has been freed from this player and returned to stock.`
      );

      setStatusMessage(
        `Number ${currentNumber} is now free for reuse once stock and cohort checks pass.`
      );
    } catch (err: any) {
      console.error("handleEndAllocation error", err);
      setError(err.message ?? "Failed to end allocation.");
    } finally {
      setEndingAllocation(false);
    }
  };

  const handleSwapJersey = async () => {
    setError(null);
    setAllocationMessage("");

    if (!selectedClubId) {
      setError("Please select a club first.");
      return;
    }

    if (!currentPlayer || !selectedPlayerId) {
      setError("Please select a player to swap jerseys for.");
      return;
    }

    if (!swapSize) {
      setError("Please choose a new jersey size for the swap.");
      return;
    }

    if (!swapNumber) {
      setError("Please enter a new jersey number for the swap.");
      return;
    }

    const newNumber = Number(swapNumber);
    if (!Number.isFinite(newNumber) || newNumber <= 0) {
      setError("New jersey number must be a positive number.");
      return;
    }

    // Decide which YOB to use for cohort logic (same rules as check/allocation)
    const yobNum = deriveCohortYear();

    setSwapBusy(true);

    try {
      // 1) Check cohort clashes + stock for the *new* number
      const { clashes, stockBySize } = await smartCheckNumber(
        selectedClubId,
        newNumber,
        {
          yearOfBirth: yobNum,
        }
      );

      const stockForNewSize = findStockForSize(stockBySize, swapSize);

      if (clashes.length > 0) {
        setAllocationMessage(
          `Cannot swap: new number ${newNumber} clashes within the effective cohort.`
        );
        setSwapBusy(false);
        return;
      }

      if (stockForNewSize <= 0) {
        setAllocationMessage(
          `Cannot swap: there is no available stock for size ${swapSize} in number ${newNumber}.`
        );
        setSwapBusy(false);
        return;
      }

      const playerId = currentPlayer.id;
      const previousNumber = currentPlayer.final_shirt ?? null;

      // 2) Free any existing inventory rows for this player
      const { error: invFreeError } = await supabase
        .from("inventory")
        .update({
          status: "Available",
          allocated_player_id: null,
          allocation_date: null,
          return_date_due: null,
        })
        .eq("club_id", selectedClubId)
        .eq("allocated_player_id", playerId)
        .eq("status", "Allocated");

      if (invFreeError) {
        console.error("SwapJersey inventory free error", invFreeError);
        setAllocationMessage(
          "Failed to free existing jersey from inventory. Swap aborted."
        );
        setSwapBusy(false);
        return;
      }

      // 3) Reserve new inventory row for the new size/number
      const invResult = await allocateNumberForClub(
        selectedClubId,
        newNumber,
        swapSize
      );

      if (!invResult.success || !invResult.inventoryId) {
        setAllocationMessage(
          invResult.message ||
            "Failed to reserve new jersey row during swap. Existing jersey has been freed; please re-allocate manually."
        );
        setSwapBusy(false);
        return;
      }

      const newInventoryId = invResult.inventoryId;

      // 4) Update player with new final_shirt (+ optionally YOB)
      const playerUpdate: any = { final_shirt: newNumber };
      if (yobNum && Number.isFinite(yobNum)) {
        playerUpdate.year_of_birth = yobNum;
      }

      const { error: playerUpdateError } = await supabase
        .from("players")
        .update(playerUpdate)
        .eq("id", playerId);

      if (playerUpdateError) {
        console.error("SwapJersey player update error", playerUpdateError);
        setAllocationMessage(
          "New jersey reserved, but failed to update player record. Please fix player manually."
        );
        setSwapBusy(false);
        return;
      }

      // 5) Link the new inventory row to this player
      const { error: invLinkError } = await supabase
        .from("inventory")
        .update({ allocated_player_id: playerId })
        .eq("id", newInventoryId);

      if (invLinkError) {
        console.error("SwapJersey inventory link error", invLinkError);
        setAllocationMessage(
          "Player updated, but failed to link new jersey to player in inventory."
        );
        setSwapBusy(false);
        return;
      }

      // 6) Log swap event
      await logAllocationEvent({
        allocation_type: "swap",
        club_id: selectedClubId,
        player_id: playerId,
        jersey_number: newNumber,
        size: swapSize,
        previous_jersey_number: previousNumber,
        previous_size: null,
        note: "Swap via admin panel",
      });

      // 7) Update local state snapshot
      setClubPlayers((prev) =>
        prev.map((p) =>
          p.id === playerId
            ? {
                ...p,
                final_shirt: newNumber,
                year_of_birth:
                  yobNum && Number.isFinite(yobNum)
                    ? yobNum
                    : p.year_of_birth,
              }
            : p
        )
      );

      setAllocationMessage(
        `Swap complete: player now has jersey #${newNumber} (${swapSize}). Old jersey has been freed and new one reserved & linked.`
      );

      // Clear swap inputs
      setSwapNumber("");
      // Keep swapSize as-is for future swaps
    } catch (err: any) {
      console.error("handleSwapJersey error", err);
      setError(err.message ?? "Failed to swap jersey.");
    } finally {
      setSwapBusy(false);
    }
  };

  const handleReturnToStock = async () => {
    setReturnMessage("");
    setError(null);

    if (!selectedClubId) {
      setError("Please select a club for the return.");
      return;
    }

    if (!returnSize) {
      setError("Please enter the jersey size for the return.");
      return;
    }

    if (!returnNumber) {
      setError("Please enter the jersey number for the return.");
      return;
    }

    const num = Number(returnNumber);
    if (!Number.isFinite(num) || num <= 0) {
      setError("Return number must be a positive number.");
      return;
    }

    setReturnBusy(true);
    try {
      const result = await returnJerseyToStock(
        selectedClubId,
        num,
        returnSize
      );

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
      <h1 className="text-2xl font-bold mb-4">
        Jersey Number Allocation (Admin)
      </h1>
      <p className="text-sm text-gray-600 mb-6">
        Use this tool to select a player, check for cohort-aware clashes, and
        commit jersey allocations against live inventory. Use the End Allocation
        action to free a player&apos;s number, or the Swap Jersey flow to move
        them to a new size/number. Returns can also be processed by warehouse
        below.
      </p>

      {/* Top form */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
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

        <div>
          <label className="block text-sm font-semibold mb-1">
            Year of Birth (optional, enables cohort logic)
          </label>
          <input
            type="number"
            value={yearOfBirth}
            onChange={(e) => setYearOfBirth(e.target.value)}
            placeholder="e.g. 2012"
            className="w-full border p-2 rounded"
          />
          <p className="mt-1 text-xs text-gray-500">
            If left blank, we use the player&apos;s stored year of birth (if
            available) for cohort checks.
          </p>
        </div>

        <div>
          <label className="block text-sm font-semibold mb-1">
            Player (this club)
          </label>
          <select
            value={selectedPlayerId}
            onChange={(e) => setSelectedPlayerId(e.target.value)}
            className="w-full border p-2 rounded"
            disabled={loadingPlayers || clubPlayers.length === 0}
          >
            {loadingPlayers && <option value="">Loading players...</option>}
            {!loadingPlayers && clubPlayers.length === 0 && (
              <option value="">No players found for this club</option>
            )}
            {!loadingPlayers &&
              clubPlayers.map((p) => {
                const labelParts = [
                  `${p.last_name}, ${p.first_name}`,
                  p.team_id ? `(${p.team_id})` : "",
                  p.final_shirt != null ? `#${p.final_shirt}` : "",
                ].filter(Boolean);
                return (
                  <option key={p.id} value={p.id}>
                    {labelParts.join(" ")}
                  </option>
                );
              })}
          </select>
        </div>
      </div>

      {/* Current allocation + actions */}
      <div className="mb-6 border rounded-lg p-4 bg-gray-50 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 text-sm">
          <div>
            <h2 className="text-sm font-semibold mb-1">Current Allocation</h2>
            {currentPlayer ? (
              <>
                <div>
                  <span className="font-semibold">
                    {currentPlayer.first_name} {currentPlayer.last_name}
                  </span>{" "}
                  {currentPlayer.team_id && (
                    <span className="text-gray-600">
                      &mdash; {currentPlayer.team_id}
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
                  Use &quot;End Allocation&quot; when this player leaves or you
                  are deliberately freeing this number for reuse. Use &quot;Swap
                  Jersey&quot; below to move them to a new size or number while
                  keeping history consistent.
                </div>
              </>
            ) : (
              <p className="text-gray-600">
                Select a player above to view and manage their allocation.
              </p>
            )}
          </div>
          <div className="flex-shrink-0">
            <button
              type="button"
              onClick={handleEndAllocation}
              disabled={
                endingAllocation || !currentPlayer || currentPlayer.final_shirt == null
              }
              className="px-4 py-2 rounded bg-red-600 text-white text-sm disabled:bg-gray-400"
            >
              {endingAllocation
                ? "Ending Allocation..."
                : "End Allocation (free number)"}
            </button>
          </div>
        </div>

        {/* Swap Jersey panel */}
        <div className="mt-4 border-t pt-4">
          <h3 className="text-sm font-semibold mb-2">Swap Jersey</h3>
          <p className="text-xs text-gray-600 mb-3">
            Use this when the player is changing size and/or number. The current
            jersey will be freed back to stock, cohort rules checked for the new
            number, and a new jersey will be reserved and linked.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
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
            <div>
              <button
                type="button"
                onClick={handleSwapJersey}
                disabled={swapBusy || !currentPlayer}
                className="w-full px-4 py-2 bg-orange-600 text-white rounded text-sm disabled:bg-gray-400"
              >
                {swapBusy
                  ? "Swapping..."
                  : "Swap Jersey (free old + allocate new)"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Number entry + actions (fresh allocation flow) */}
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

        <div className="flex">
          <button
            onClick={handleConfirmAllocation}
            disabled={allocating}
            className="w-full px-4 py-2 bg-emerald-600 text-white rounded disabled:bg-gray-400"
          >
            {allocating ? "Allocating..." : "Confirm Allocation (reserve + link)"}
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

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold mb-2">
            Suggested clash-free numbers with available stock (size{" "}
            {selectedSize || "—"})
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

      {/* Clash details */}
      {clashes.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold mb-2">
            Clashing players (effective cohort view)
          </h2>
          <div className="overflow-x-auto border rounded">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-2 py-1 text-left">First Name</th>
                  <th className="px-2 py-1 text-left">Last Name</th>
                  <th className="px-2 py-1 text-left">Team</th>
                  <th className="px-2 py-1 text-left">Number</th>
                  <th className="px-2 py-1 text-left">Year of Birth</th>
                </tr>
              </thead>
              <tbody>
                {clashes.map((p) => (
                  <tr key={p.id} className="odd:bg-white even:bg-gray-50">
                    <td className="px-2 py-1">{p.first_name}</td>
                    <td className="px-2 py-1">{p.last_name}</td>
                    <td className="px-2 py-1">{p.team_id ?? "—"}</td>
                    <td className="px-2 py-1">
                      {p.final_shirt ?? "—"}
                    </td>
                    <td className="px-2 py-1">
                      {p.year_of_birth ?? "—"}
                    </td>
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
            Inventory for this number (all sizes) – {clubName}
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
                  <tr
                    key={s.size}
                    className="odd:bg-white even:bg-gray-50"
                  >
                    <td className="px-2 py-1">{s.size}</td>
                    <td className="px-2 py-1">{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Return to stock section (for warehouse) */}
      <div className="border-t pt-6 mt-6">
        <h2 className="text-lg font-semibold mb-2">
          Return Jersey to Stock (Warehouse)
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          When a jersey is physically returned to the warehouse, use this
          section to mark it back as Available in inventory for{" "}
          <span className="font-semibold">
            {clubName || "the selected club"}
          </span>
          . This does not change the player record – use End Allocation or Swap
          Jersey above if the player is actually changing number.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-sm font-semibold mb-1">
              Jersey Size
            </label>
            <input
              type="text"
              value={returnSize}
              onChange={(e) => setReturnSize(e.target.value)}
              placeholder="e.g. Youth 12"
              className="w-full border p-2 rounded"
            />
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
