import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

type Gender = "unisex" | "mens" | "womens";

const GENDER_LABELS: Record<Gender, string> = {
  unisex: "Unisex",
  mens: "Men's",
  womens: "Women's",
};

interface Club {
  id: string;
  name: string;
  is_client: boolean;
}

interface MappingRow {
  id: string;
  shopify_product_id: string;
  club_id: string;
  gender: Gender;
  created_at: string;
  updated_at: string;
  clubs?: { name: string } | null;
}

function extractShopifyProductId(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) return raw;

  const m = raw.match(/\/products\/(\d+)/i);
  if (m && m[1]) return m[1];

  return null;
}

const ProductClubMapping: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClubId, setSelectedClubId] = useState<string>("");
  const [selectedGender, setSelectedGender] = useState<Gender>("unisex");

  const [productInput, setProductInput] = useState("");
  const [parsedProductId, setParsedProductId] = useState<string | null>(null);

  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [loading, setLoading] = useState(false);

  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const loadClubs = async () => {
    const { data, error } = await supabase
      .from("clubs")
      .select("id, name, is_client")
      .eq("is_client", true)
      .order("name");

    if (error) {
      setError(error.message);
      return;
    }

    const list = (data ?? []) as Club[];
    setClubs(list);
    if (list.length > 0) setSelectedClubId(list[0].id);
  };

  const loadMappings = async () => {
    const { data, error } = await supabase
      .from("shopify_product_club_map")
      .select("id, shopify_product_id, club_id, gender, created_at, updated_at, clubs(name)")
      .order("updated_at", { ascending: false });

    if (error) {
      setError(error.message);
      return;
    }

    setMappings((data ?? []) as any);
  };

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        await loadClubs();
        await loadMappings();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    setParsedProductId(extractShopifyProductId(productInput));
  }, [productInput]);

  const canSave = useMemo(() => {
    return Boolean(selectedClubId && parsedProductId);
  }, [selectedClubId, parsedProductId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatus("");

    if (!parsedProductId) {
      setError("Could not detect a Shopify Product ID. Paste the Shopify Admin product URL or the numeric Product ID.");
      return;
    }
    if (!selectedClubId) {
      setError("Please select a club.");
      return;
    }

    setLoading(true);
    try {
      const { error: upsertError } = await supabase
        .from("shopify_product_club_map")
        .upsert(
          [{ shopify_product_id: parsedProductId, club_id: selectedClubId, gender: selectedGender }],
          { onConflict: "shopify_product_id" }
        );

      if (upsertError) {
        setError(upsertError.message);
        return;
      }

      setStatus(`Saved: product ${parsedProductId} → club (${GENDER_LABELS[selectedGender]})`);
      setProductInput("");
      await loadMappings();
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    setStatus("");
    setLoading(true);
    try {
      const { error } = await supabase.from("shopify_product_club_map").delete().eq("id", id);

      if (error) {
        setError(error.message);
        return;
      }

      setStatus("Deleted mapping.");
      await loadMappings();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Product {"->"} Club Mapping</h1>
        <p className="text-sm text-gray-600 mt-1">
          Paste a Shopify <b>Admin product URL</b> (recommended) or a numeric <b>Product ID</b>, then assign it to a
          club and gender. A club can have up to three products — one each for Unisex, Men's, and Women's.
        </p>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}
      {status && (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-3">
          {status}
        </div>
      )}

      <form onSubmit={handleSave} className="bg-white border rounded p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Club</label>
            <select
              className="border rounded px-3 py-2 w-full"
              value={selectedClubId}
              onChange={(e) => setSelectedClubId(e.target.value)}
              disabled={loading}
            >
              {clubs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Gender</label>
            <select
              className="border rounded px-3 py-2 w-full"
              value={selectedGender}
              onChange={(e) => setSelectedGender(e.target.value as Gender)}
              disabled={loading}
            >
              <option value="unisex">Unisex</option>
              <option value="mens">Men's</option>
              <option value="womens">Women's</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">
              Shopify Product Admin URL or Product ID
            </label>
            <input
              className="border rounded px-3 py-2 w-full"
              placeholder="Paste Shopify Admin product URL (preferred) or numeric product ID"
              value={productInput}
              onChange={(e) => setProductInput(e.target.value)}
              disabled={loading}
            />
            <div className="text-xs text-gray-500 mt-1">
              Detected Product ID:{" "}
              <span className={parsedProductId ? "text-emerald-700 font-semibold" : "text-red-600 font-semibold"}>
                {parsedProductId ?? "Not detected"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading || !canSave}
            className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:bg-gray-400"
          >
            {loading ? "Saving…" : "Save Mapping"}
          </button>
        </div>
      </form>

      <div className="bg-white border rounded overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <h2 className="font-semibold text-sm">Current Mappings</h2>
          <span className="text-xs text-gray-600">{mappings.length} total</span>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-2 text-left">Shopify Product ID</th>
                <th className="px-3 py-2 text-left">Club</th>
                <th className="px-3 py-2 text-left">Gender</th>
                <th className="px-3 py-2 text-left">Updated</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id} className="border-t odd:bg-white even:bg-gray-50">
                  <td className="px-3 py-2 font-mono">{m.shopify_product_id}</td>
                  <td className="px-3 py-2">{m.clubs?.name ?? m.club_id}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                        m.gender === "mens"
                          ? "bg-blue-100 text-blue-800"
                          : m.gender === "womens"
                          ? "bg-pink-100 text-pink-800"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {GENDER_LABELS[m.gender] ?? m.gender}
                    </span>
                  </td>
                  <td className="px-3 py-2">{new Date(m.updated_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleDelete(m.id)}
                      className="text-red-600 hover:text-red-800"
                      disabled={loading}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {mappings.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-gray-500">
                    No mappings yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default ProductClubMapping;
