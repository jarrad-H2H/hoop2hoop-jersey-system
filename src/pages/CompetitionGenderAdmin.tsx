// FILE: src/pages/CompetitionGenderAdmin.tsx
import React, { useState, useEffect } from "react";
import { supabase } from "../services/supabase";

type GenderType = "Male" | "Female" | "Mixed";

interface Competition {
  id: string;
  name: string;
}

interface AgeGroupRow {
  ageLabel: string;
  genderType: GenderType | "";   // "" = not configured
  saved: boolean;                // matches what's in the DB
  dirty: boolean;                // local change not yet saved
}

const GENDER_OPTIONS: { value: GenderType | ""; label: string }[] = [
  { value: "", label: "— Not configured —" },
  { value: "Male", label: "♂ Male only" },
  { value: "Female", label: "♀ Female only" },
  { value: "Mixed", label: "⚥ Mixed (cross-pool clash check)" },
];

const CompetitionGenderAdmin: React.FC = () => {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [rows, setRows] = useState<AgeGroupRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load competitions on mount
  useEffect(() => {
    supabase
      .from("competitions")
      .select("id, name")
      .order("name")
      .then(({ data }) => setCompetitions((data ?? []) as Competition[]));
  }, []);

  // Load age groups when competition changes
  useEffect(() => {
    if (!selectedId) { setRows([]); return; }
    setLoading(true);
    setStatusMsg(null);
    setErrorMsg(null);

    const load = async () => {
      // Distinct age_group values from teams in this competition
      const { data: teamData, error: teamErr } = await supabase
        .from("teams")
        .select("age_group")
        .eq("competition_id", selectedId)
        .not("age_group", "is", null);

      if (teamErr) {
        setErrorMsg("Failed to load teams: " + teamErr.message);
        setLoading(false);
        return;
      }

      // Deduplicate and sort age labels
      const allLabels = Array.from(
        new Set((teamData ?? []).map((r: any) => r.age_group as string).filter(Boolean))
      ).sort((a, b) => {
        // Sort: U8 < U10 < U12 ... < Junior < Open
        const numA = parseInt(a.replace(/\D/g, ""), 10);
        const numB = parseInt(b.replace(/\D/g, ""), 10);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        if (!isNaN(numA)) return -1;
        if (!isNaN(numB)) return 1;
        return a.localeCompare(b);
      });

      // Load existing competition_age_groups settings
      const { data: cagData, error: cagErr } = await supabase
        .from("competition_age_groups")
        .select("age_label, gender_type")
        .eq("competition_id", selectedId);

      if (cagErr) {
        setErrorMsg("Failed to load settings: " + cagErr.message);
        setLoading(false);
        return;
      }

      const savedMap = new Map<string, GenderType>();
      for (const row of cagData ?? []) {
        savedMap.set(row.age_label, row.gender_type as GenderType);
      }

      setRows(
        allLabels.map((label) => ({
          ageLabel: label,
          genderType: savedMap.get(label) ?? "",
          saved: savedMap.has(label),
          dirty: false,
        }))
      );
      setLoading(false);
    };

    void load();
  }, [selectedId]);

  const handleChange = (ageLabel: string, value: GenderType | "") => {
    setRows((prev) =>
      prev.map((r) =>
        r.ageLabel === ageLabel ? { ...r, genderType: value, dirty: true } : r
      )
    );
    setStatusMsg(null);
  };

  const handleSave = async () => {
    if (!selectedId) return;
    setSaving(true);
    setStatusMsg(null);
    setErrorMsg(null);

    try {
      const toUpsert = rows
        .filter((r) => r.genderType !== "")
        .map((r) => ({
          competition_id: selectedId,
          age_label: r.ageLabel,
          gender_type: r.genderType as GenderType,
        }));

      const toDelete = rows
        .filter((r) => r.genderType === "" && r.saved)
        .map((r) => r.ageLabel);

      if (toUpsert.length > 0) {
        const { error: upsertErr } = await supabase
          .from("competition_age_groups")
          .upsert(toUpsert, { onConflict: "competition_id,age_label" });

        if (upsertErr) {
          setErrorMsg("Save failed: " + upsertErr.message);
          return;
        }
      }

      if (toDelete.length > 0) {
        const { error: delErr } = await supabase
          .from("competition_age_groups")
          .delete()
          .eq("competition_id", selectedId)
          .in("age_label", toDelete);

        if (delErr) {
          setErrorMsg("Delete failed: " + delErr.message);
          return;
        }
      }

      // Mark all rows as saved
      setRows((prev) => prev.map((r) => ({ ...r, saved: r.genderType !== "", dirty: false })));
      setStatusMsg(`Saved ${toUpsert.length} age group configuration(s).`);
    } finally {
      setSaving(false);
    }
  };

  const hasDirty = rows.some((r) => r.dirty);
  const competition = competitions.find((c) => c.id === selectedId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-1">Competition Gender Settings</h2>
        <p className="text-gray-500 text-sm">
          Configure whether each age group in a competition is Male-only, Female-only, or Mixed.
          Mixed age groups trigger cross-pool jersey clash checking at purchase time.
        </p>
      </div>

      {/* Competition selector */}
      <div className="bg-white rounded-xl shadow p-6 max-w-xl">
        <label className="block text-sm font-medium text-gray-700 mb-1">Competition</label>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm
                     focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">— Select competition —</option>
          {competitions.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Age group config table */}
      {selectedId && (
        <div className="bg-white rounded-xl shadow p-6 max-w-2xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-800">{competition?.name}</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Age groups detected from imported teams. Set gender type for each.
              </p>
            </div>
            <button
              onClick={handleSave}
              disabled={saving || !hasDirty}
              className={`px-4 py-2 rounded-md text-sm font-semibold text-white transition-colors
                          ${saving || !hasDirty
                            ? "bg-gray-300 cursor-not-allowed"
                            : "bg-indigo-600 hover:bg-indigo-700"}`}
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 py-4">Loading age groups…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-gray-400 py-4">
              No teams found for this competition. Import a BC CSV first.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-4 font-medium text-gray-600 w-32">Age Group</th>
                  <th className="text-left py-2 font-medium text-gray-600">Gender Type</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => (
                  <tr key={row.ageLabel} className="hover:bg-gray-50">
                    <td className="py-2.5 pr-4 font-semibold text-gray-800">{row.ageLabel}</td>
                    <td className="py-2.5">
                      <select
                        value={row.genderType}
                        onChange={(e) => handleChange(row.ageLabel, e.target.value as GenderType | "")}
                        className={`px-3 py-1.5 border rounded-md text-sm focus:outline-none
                                    focus:ring-2 focus:ring-indigo-500
                                    ${row.genderType === "Mixed"
                                      ? "border-purple-300 bg-purple-50 text-purple-800"
                                      : row.genderType === "Female"
                                      ? "border-pink-300 bg-pink-50 text-pink-800"
                                      : row.genderType === "Male"
                                      ? "border-blue-300 bg-blue-50 text-blue-800"
                                      : "border-gray-300 text-gray-500"}`}
                      >
                        {GENDER_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2.5 text-right">
                      {row.dirty && (
                        <span className="text-xs text-amber-600 font-medium">unsaved</span>
                      )}
                      {!row.dirty && row.saved && (
                        <span className="text-xs text-emerald-600">✓ saved</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {statusMsg && (
            <div className="mt-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
              {statusMsg}
            </div>
          )}
          {errorMsg && (
            <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {errorMsg}
            </div>
          )}

          {/* Legend */}
          <div className="mt-6 pt-4 border-t text-xs text-gray-500 space-y-1">
            <p><strong>Male / Female only</strong> — clash check is scoped to that product pool only. No cross-pool check.</p>
            <p><strong>Mixed</strong> — jersey numbers must be unique across both mens and womens pools. A boy and a girl in the same team cannot share the same number.</p>
            <p><strong>Not configured</strong> — no cross-pool check. Treat as single-gender (safe default for older age groups).</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default CompetitionGenderAdmin;
