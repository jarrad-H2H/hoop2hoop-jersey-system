// FILE: src/components/JerseyWidget.tsx
import React, { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import {
  smartCheckNumber,
  suggestNumbersForClub,
  StockBySize,
  NumberSuggestion,
  reserveNumberForPurchase,
} from "../services/allocation";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

const JerseyWidget: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [sizes, setSizes] = useState<string[]>([]);
  const [selectedSize, setSelectedSize] = useState<string>("");

  const [yearOfBirth, setYearOfBirth] = useState<string>("");
  const [preferredNumber, setPreferredNumber] = useState<string>("");

  const [statusMessage, setStatusMessage] = useState<string>("");
  const [stockBySize, setStockBySize] = useState<StockBySize[]>([]);
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [reserving, setReserving] = useState(false);

  const [reservationResult, setReservationResult] = useState<{
    pendingAllocationId?: string;
    inventoryId?: string;
  }>({});

  useEffect(() => {
    const loadClubs = async () => {
      setError(null);

      const { data, error } = await supabase
        .from("clubs")
        .select("id, name, is_client")
        .eq("is_client", true)
        .order("name", { ascending: true });

      if (error) {
        console.error("JerseyWidget loadClubs error", error);
        setError("Failed to load clubs for demo.");
        return;
      }

      const list = (data ?? []) as Club[];
      setClubs(list);

      if (list.length > 0) {
        setSelectedClubId(list[0].id);
      }
    };

    void loadClubs();
  }, []);

  useEffect(() => {
    const loadSizes = async () => {
      if (!selectedClubId) {
        setSizes([]);
        setSelectedSize("");
        return;
      }

      setError(null);

      const { data, error } = await supabase
        .from("inventory")
        .select("size")
        .eq("club_id", selectedClubId)
        .eq("status", "Available");

      if (error) {
        console.error("JerseyWidget loadSizes error", error);
        setError("Failed to load sizes for this club.");
        return;
      }

      const unique = Array.from(
        new Set((data ?? []).map((row: any) => String(row.size ?? "")))
      ).filter((s) => s.length > 0);

      unique.sort();
      setSizes(unique);
      setSelectedSize(unique[0] ?? "");
    };

    void loadSizes();
  }, [selectedClubId]);

  const resetOutputs = () => {
    setStatusMessage("");
    setStockBySize([]);
    setSuggestions([]);
    setReservationResult({});
  };

  const validateInputs = (): { yobNum: number; num: number } | null => {
    if (!selectedClubId) {
      setError("Please choose a club.");
      return null;
    }
    if (!selectedSize) {
      setError("Please choose a size.");
      return null;
    }
    if (yearOfBirth.trim().length === 0) {
      setError("Please enter year of birth.");
      return null;
    }
    if (preferredNumber.trim().length === 0) {
      setError("Please enter a preferred number.");
      return null;
    }

    const yobNum = Number(yearOfBirth);
    const num = Number(preferredNumber);

    if (!Number.isFinite(yobNum) || yobNum < 1900) {
      setError("Year of birth looks invalid.");
      return null;
    }

    // allow 0 as valid jersey number
    if (!Number.isFinite(num) || num < 0) {
      setError("Preferred number must be 0 or a positive number.");
      return null;
    }

    return { yobNum, num };
  };

  const handleCheckNumber = async () => {
    setError(null);
    resetOutputs();

    const validated = validateInputs();
    if (!validated) return;

    const { yobNum, num } = validated;

    setChecking(true);
    try {
      const { stockBySize, statusMessage } = await smartCheckNumber(selectedClubId, num, {
        seasonYear: 2025,
        yearOfBirth: yobNum,
        cohortWindowYears: 0,
      });

      setStockBySize(stockBySize);
      setStatusMessage(statusMessage);
    } catch (err: any) {
      console.error("JerseyWidget handleCheckNumber error", err);
      setError(err.message ?? "Failed to check this number.");
    } finally {
      setChecking(false);
    }
  };

  const handleSuggestNumbers = async () => {
    setError(null);
    resetOutputs();

    if (!selectedClubId) {
      setError("Please choose a club.");
      return;
    }
    if (!selectedSize) {
      setError("Please choose a size.");
      return;
    }

    setSuggesting(true);
    try {
      const result = await suggestNumbersForClub(selectedClubId, selectedSize, 10);
      setSuggestions(result);

      if (result.length === 0) {
        setStatusMessage(
          `There are no clash-free numbers with available stock for size ${selectedSize} in this club.`
        );
      } else {
        setStatusMessage(`Here are clash-free numbers with stock in size ${selectedSize}.`);
      }
    } catch (err: any) {
      console.error("JerseyWidget handleSuggestNumbers error", err);
      setError(err.message ?? "Failed to suggest numbers.");
    } finally {
      setSuggesting(false);
    }
  };

  const handleReserve = async () => {
    setError(null);
    resetOutputs();

    const validated = validateInputs();
    if (!validated) return;

    const { yobNum, num } = validated;

    setReserving(true);
    try {
      const result = await reserveNumberForPurchase({
        clubId: selectedClubId,
        jerseyNumber: num,
        size: selectedSize,
        seasonYear: 2025,
        yearOfBirth: yobNum,
        expiresMinutes: 15,
      });

      if (!result.success) {
        setError(result.message);
        return;
      }

      setReservationResult({
        pendingAllocationId: result.pendingAllocationId,
        inventoryId: result.inventoryId,
      });

      setStatusMessage(
        `Reserved jersey #${num} (${selectedSize}). Pending allocation created (15 min hold).`
      );
    } catch (err: any) {
      console.error("JerseyWidget handleReserve error", err);
      setError(err.message ?? "Failed to reserve this number.");
    } finally {
      setReserving(false);
    }
  };

  const handleUseSuggestion = (num: number) => {
    setPreferredNumber(String(num));
    setStatusMessage(`Using suggested number ${num}. You can now reserve this number.`);
  };

  const clubName = clubs.find((c) => c.id === selectedClubId)?.name ?? "Selected club";

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Widget Demo</h1>
      <p className="text-sm text-gray-600 mb-6">
        This is an internal preview of the jersey number widget logic. In Shopify, the widget will
        auto-detect club + size from the product; here you pick a club and size manually for testing.
      </p>

      <div className="bg-white rounded-xl shadow p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Demo club
            </label>
            <select
              value={selectedClubId}
              onChange={(e) => setSelectedClubId(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
            >
              {clubs.length === 0 && <option value="">No client clubs found</option>}
              {clubs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Jersey size (demo)
            </label>
            <select
              value={selectedSize}
              onChange={(e) => setSelectedSize(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              disabled={sizes.length === 0}
            >
              {sizes.length === 0 && <option value="">No sizes in inventory</option>}
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Year of birth
            </label>
            <input
              type="number"
              value={yearOfBirth}
              onChange={(e) => setYearOfBirth(e.target.value)}
              placeholder="e.g. 2013"
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Preferred jersey number
            </label>
            <input
              type="number"
              value={preferredNumber}
              onChange={(e) => setPreferredNumber(e.target.value)}
              placeholder="e.g. 12"
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex flex-col md:flex-row gap-3">
          <button
            type="button"
            onClick={handleCheckNumber}
            disabled={checking}
            className="flex-1 px-4 py-2 rounded bg-indigo-600 text-white text-sm font-semibold disabled:bg-gray-400"
          >
            {checking ? "Checking…" : "Check this number"}
          </button>

          <button
            type="button"
            onClick={handleSuggestNumbers}
            disabled={suggesting}
            className="flex-1 px-4 py-2 rounded bg-slate-800 text-white text-sm font-semibold disabled:bg-gray-400"
          >
            {suggesting ? "Finding options…" : "Suggest numbers with stock"}
          </button>
        </div>

        <div className="flex flex-col md:flex-row gap-3">
          <button
            type="button"
            onClick={handleReserve}
            disabled={reserving}
            className="flex-1 px-4 py-2 rounded bg-emerald-600 text-white text-sm font-semibold disabled:bg-gray-400"
          >
            {reserving ? "Reserving…" : "Confirm and Reserve (creates pending allocation)"}
          </button>
        </div>

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
            {error}
          </div>
        )}

        {statusMessage && (
          <div className="text-sm text-indigo-700 bg-indigo-50 border border-indigo-200 rounded p-3">
            {statusMessage}
          </div>
        )}

        {(reservationResult.pendingAllocationId || reservationResult.inventoryId) && (
          <div className="text-[12px] text-gray-700 bg-gray-50 border border-gray-200 rounded p-3">
            <div>
              <strong>Pending Allocation ID:</strong>{" "}
              {reservationResult.pendingAllocationId ?? "—"}
            </div>
            <div>
              <strong>Inventory ID:</strong> {reservationResult.inventoryId ?? "—"}
            </div>
          </div>
        )}

        {suggestions.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              Suggested clash-free numbers with stock ({clubName}, size {selectedSize || "—"})
            </h2>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.jersey_number}
                  type="button"
                  onClick={() => handleUseSuggestion(s.jersey_number)}
                  className="px-3 py-1 rounded-full text-xs border border-emerald-500 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                >
                  #{s.jersey_number} · {s.total_stock} in stock
                </button>
              ))}
            </div>
          </div>
        )}

        {stockBySize.length > 0 && preferredNumber.trim().length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              Internal view: inventory for #{preferredNumber} in {clubName}
            </h2>
            <div className="text-[11px] text-gray-600">
              {stockBySize.map((s) => `${s.size}: ${s.count} available`).join(" • ")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default JerseyWidget;
