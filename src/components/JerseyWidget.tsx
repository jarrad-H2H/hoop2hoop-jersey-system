// FILE: src/components/JerseyWidget.tsx
import React, { useEffect, useState } from "react";
import {
  smartCheckNumber,
  suggestNumbersForClub,
  ClashPlayer,
  StockBySize,
  NumberSuggestion,
} from "../services/allocation";

interface JerseyWidgetProps {
  /** Club this product belongs to – in Shopify this will come from metafields */
  clubId: string;
  /** Variant size selected on the Shopify product (e.g. "Youth 12") */
  size?: string | null;
  /** Optional: flag so we can tweak text slightly in the demo */
  demoMode?: boolean;
}

const JerseyWidget: React.FC<JerseyWidgetProps> = ({ clubId, size, demoMode }) => {
  const [clubName, setClubName] = useState<string>("");
  const [loadingClub, setLoadingClub] = useState(false);

  const [numberInput, setNumberInput] = useState<string>("");
  const [yobInput, setYobInput] = useState<string>("");

  const [checking, setChecking] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  const [statusMessage, setStatusMessage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const [clashes, setClashes] = useState<ClashPlayer[]>([]);
  const [stockBySize, setStockBySize] = useState<StockBySize[]>([]);
  const [suggestions, setSuggestions] = useState<NumberSuggestion[]>([]);

  // Normalised size string we will use in logic
  const effectiveSize = (size ?? "").trim() || null;

  // 1) Optional: load club name for nicer text
  useEffect(() => {
    const loadClubName = async () => {
      if (!clubId) {
        setClubName("");
        return;
      }

      try {
        setLoadingClub(true);
        setError(null);

        const resp = await fetch(
          `/supabase/club-name?club_id=${encodeURIComponent(clubId)}`
        ).catch(() => null);

        // If you don't have a small API route for this yet, we just fall back to generic text.
        if (!resp || !resp.ok) {
          setClubName("");
          return;
        }

        const json = await resp.json();
        if (json?.name) {
          setClubName(json.name as string);
        }
      } finally {
        setLoadingClub(false);
      }
    };

    void loadClubName();
  }, [clubId]);

  const resetOutput = () => {
    setStatusMessage("");
    setError(null);
    setClashes([]);
    setStockBySize([]);
    setSuggestions([]);
  };

  const handleCheck = async () => {
    resetOutput();

    if (!clubId) {
      setError("Please select the correct club for this product.");
      return;
    }

    if (!numberInput) {
      setError("Please enter your preferred playing number.");
      return;
    }

    const jerseyNumber = Number(numberInput);
    if (!Number.isFinite(jerseyNumber) || jerseyNumber <= 0) {
      setError("Playing number must be a positive number.");
      return;
    }

    let yearOfBirth: number | undefined;
    if (yobInput && Number.isFinite(Number(yobInput))) {
      yearOfBirth = Number(yobInput);
    }

    setChecking(true);

    try {
      const { clashes, stockBySize, statusMessage } = await smartCheckNumber(
        clubId,
        jerseyNumber,
        {
          yearOfBirth,
          cohortWindowYears: 1,
        }
      );

      setClashes(clashes);
      setStockBySize(stockBySize);

      // If we know the size, tailor the message to that size.
      if (effectiveSize) {
        const stockForSize =
          stockBySize.find((s) => s.size === effectiveSize)?.count ?? 0;

        if (clashes.length === 0 && stockForSize > 0) {
          setStatusMessage(
            `Good news – ${jerseyNumber} is available in ${effectiveSize} for this club.`
          );
        } else if (clashes.length === 0 && stockForSize === 0) {
          setStatusMessage(
            `No clash found, but there is no stock in ${effectiveSize} for #${jerseyNumber}. Try the suggestions.`
          );
        } else if (clashes.length > 0) {
          setStatusMessage(
            `This number clashes within your age group for this club. Please choose another number or use the suggestions below.`
          );
        } else {
          setStatusMessage(statusMessage);
        }
      } else {
        // Fallback: generic message if we don’t know the size
        setStatusMessage(statusMessage);
      }
    } catch (err: any) {
      console.error("JerseyWidget handleCheck error", err);
      setError(err.message ?? "Failed to check this number.");
    } finally {
      setChecking(false);
    }
  };

  const handleSuggest = async () => {
    resetOutput();

    if (!clubId) {
      setError("Please select the correct club for this product.");
      return;
    }

    if (!effectiveSize) {
      setError(
        "Please select your jersey size on the product first before using suggestions."
      );
      return;
    }

    setSuggesting(true);

    try {
      const results = await suggestNumbersForClub(clubId, effectiveSize, 10);
      setSuggestions(results);

      if (results.length === 0) {
        setStatusMessage(
          `We couldn't find any clash-free numbers with stock in ${effectiveSize} for this club.`
        );
      } else {
        setStatusMessage(
          `Here are clash-free numbers available in ${effectiveSize} for this club.`
        );
      }
    } catch (err: any) {
      console.error("JerseyWidget handleSuggest error", err);
      setError(err.message ?? "Failed to suggest numbers.");
    } finally {
      setSuggesting(false);
    }
  };

  const handleUseSuggestion = (num: number) => {
    setNumberInput(String(num));
    setStatusMessage(
      `Using suggested number #${num}. You can proceed with this number, or check another if you prefer.`
    );
  };

  return (
    <div className="border border-slate-200 rounded-xl p-4 bg-white shadow-sm text-sm space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-900">
            Jersey Number Check
          </h3>
          <p className="text-xs text-slate-500">
            We help your club avoid duplicate playing numbers.
          </p>
        </div>
        {clubName && (
          <div className="text-right text-xs text-slate-500">
            <div className="font-semibold text-slate-700">{clubName}</div>
            <div>Jersey allocation system</div>
          </div>
        )}
      </div>

      {/* Size indicator from Shopify */}
      {effectiveSize && (
        <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          Size selected on product:{" "}
          <span className="font-semibold">{effectiveSize}</span>
        </div>
      )}

      {/* Inputs */}
      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="block text-xs font-semibold mb-1">
            Preferred jersey number
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            value={numberInput}
            onChange={(e) => setNumberInput(e.target.value)}
            placeholder="e.g. 7 or 23"
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold mb-1">
            Year of birth (optional)
          </label>
          <input
            type="number"
            inputMode="numeric"
            value={yobInput}
            onChange={(e) => setYobInput(e.target.value)}
            placeholder="e.g. 2015"
            className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            We use this to check for clashes in your age group for this club.
          </p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col sm:flex-row gap-2">
        <button
          type="button"
          onClick={handleCheck}
          disabled={checking}
          className="flex-1 inline-flex justify-center items-center px-3 py-2 rounded-lg bg-indigo-600 text-white font-medium text-sm disabled:opacity-60"
        >
          {checking ? "Checking…" : "Check this number"}
        </button>
        <button
          type="button"
          onClick={handleSuggest}
          disabled={suggesting}
          className="flex-1 inline-flex justify-center items-center px-3 py-2 rounded-lg bg-slate-800 text-white font-medium text-sm disabled:opacity-60"
        >
          {suggesting ? "Finding options…" : "Suggest numbers"}
        </button>
      </div>

      {/* Error / status */}
      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {statusMessage && !error && (
        <div className="text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          {statusMessage}
        </div>
      )}

      {/* Suggestions (no player data, just numbers + stock) */}
      {suggestions.length > 0 && (
        <div className="border-t border-slate-200 pt-3">
          <div className="text-xs font-semibold text-slate-800 mb-2">
            Suggested clash-free numbers
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s.jersey_number}
                type="button"
                onClick={() => handleUseSuggestion(s.jersey_number)}
                className="px-3 py-1 rounded-full border border-emerald-500 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-xs"
              >
                #{s.jersey_number}{" "}
                <span className="text-[11px] text-emerald-600">
                  ({s.total_stock} in stock)
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* We DO NOT show player names in widget – privacy + simplicity */}
      {clashes.length > 0 && (
        <div className="border-t border-slate-200 pt-3">
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            This number is already used in your age group for this club. Please
            choose a different number or use the suggestion button above.
          </div>
        </div>
      )}
    </div>
  );
};

export default JerseyWidget;
