// FILE: src/pages/WidgetDemo.tsx
import React, { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import JerseyWidget from "../components/JerseyWidget";

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface InventoryRow {
  size: string | null;
}

const WidgetDemo: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");

  const [sizes, setSizes] = useState<string[]>([]);
  const [selectedSize, setSelectedSize] = useState<string>("");

  // Simulated Shopify product gender — drives which inventory pool (product_type) is
  // checked, mirroring a real dual-product club's mens/womens Shopify products.
  const [selectedGender, setSelectedGender] = useState<"mens" | "womens" | "unisex">("unisex");

  const [loadingClubs, setLoadingClubs] = useState(false);
  const [loadingSizes, setLoadingSizes] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load client clubs (these simulate the club metafield on Shopify)
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
          console.error("WidgetDemo loadClubs error", error);
          setError("Failed to load clubs for widget demo.");
          return;
        }

        const list = (data ?? []) as Club[];
        setClubs(list);

        if (list.length > 0) {
          setSelectedClubId(list[0].id);
        }
      } finally {
        setLoadingClubs(false);
      }
    };

    void loadClubs();
  }, []);

  // Load available sizes for the selected club (simulating the size variant on Shopify)
  useEffect(() => {
    const loadSizes = async () => {
      if (!selectedClubId) {
        setSizes([]);
        setSelectedSize("");
        return;
      }

      setLoadingSizes(true);
      setError(null);

      try {
        const productType =
          selectedGender === "mens" ? "mens" : selectedGender === "womens" ? "womens" : "default";
        const { data, error } = await supabase
          .from("inventory")
          .select("size")
          .eq("club_id", selectedClubId)
          .eq("status", "Available")
          .eq("product_type", productType);

        if (error) {
          console.error("WidgetDemo loadSizes error", error);
          setError("Failed to load sizes for widget demo.");
          return;
        }

        const rows = (data ?? []) as InventoryRow[];

        const uniqueSizes = Array.from(
          new Set(
            rows
              .map((r) => (r.size ?? "").trim())
              .filter((s) => s.length > 0)
          )
        ).sort();

        setSizes(uniqueSizes);
        setSelectedSize(uniqueSizes[0] ?? "");
      } finally {
        setLoadingSizes(false);
      }
    };

    void loadSizes();
  }, [selectedClubId, selectedGender]);

  const currentClubName =
    clubs.find((c) => c.id === selectedClubId)?.name ?? "—";

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Widget Demo</h1>
      <p className="text-sm text-gray-600 mb-6">
        This page simulates how the Hoop2Hoop jersey widget will behave inside a
        Shopify product page. In production, the club and size will come from
        the product&apos;s metafields and selected variant. Here, you can pick
        them manually for testing.
      </p>

      {/* Demo controls */}
      <div className="mb-6 grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Demo Club (simulated Shopify metafield)
          </label>
          <select
            value={selectedClubId}
            onChange={(e) => setSelectedClubId(e.target.value)}
            className="border rounded px-3 py-2 w-full text-sm"
            disabled={loadingClubs}
          >
            {loadingClubs && <option>Loading clubs…</option>}
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
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Demo Size (simulated Shopify variant)
          </label>
          <select
            value={selectedSize}
            onChange={(e) => setSelectedSize(e.target.value)}
            className="border rounded px-3 py-2 w-full text-sm"
            disabled={loadingSizes || sizes.length === 0}
          >
            {loadingSizes && <option>Loading sizes…</option>}
            {!loadingSizes && sizes.length === 0 && (
              <option value="">No available sizes found</option>
            )}
            {!loadingSizes &&
              sizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
          </select>
          <p className="mt-1 text-[11px] text-gray-500">
            In Shopify, this comes from the selected jersey variant.
          </p>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
            Demo Product Gender (simulated dual-product club)
          </label>
          <select
            value={selectedGender}
            onChange={(e) => setSelectedGender(e.target.value as "mens" | "womens" | "unisex")}
            className="border rounded px-3 py-2 w-full text-sm"
          >
            <option value="unisex">Unisex (single product / default)</option>
            <option value="mens">Mens</option>
            <option value="womens">Womens</option>
          </select>
          <p className="mt-1 text-[11px] text-gray-500">
            In Shopify, this comes from the product's mapped <code>product_type</code> in
            shopify_product_club_map.
          </p>
        </div>

        <div>
          <div className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
            <div>
              <span className="font-semibold text-gray-800">
                Current context:
              </span>
            </div>
            <div className="mt-1">
              <span className="text-gray-700">Club: </span>
              <span className="font-medium">{currentClubName}</span>
            </div>
            <div>
              <span className="text-gray-700">Size: </span>
              <span className="font-medium">
                {selectedSize || "None (no inventory)"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}

      {/* Widget under test */}
      <div className="max-w-xl">
        {selectedClubId ? (
          <JerseyWidget
            key={`${selectedClubId}-${selectedGender}`}
            clubId={selectedClubId}
            size={selectedSize || null}
            gender={selectedGender}
            demoMode
          />
        ) : (
          <div className="text-sm text-gray-500">
            Select a club above to preview the widget.
          </div>
        )}
      </div>
    </div>
  );
};

export default WidgetDemo;
