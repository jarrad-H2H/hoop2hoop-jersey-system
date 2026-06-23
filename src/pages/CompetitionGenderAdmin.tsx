// FILE: src/pages/CompetitionGenderAdmin.tsx
import React, { useState, useEffect } from "react";
import { supabase } from "../services/supabase";

interface Competition {
  id: string;
  name: string;
}

interface AgeGroupSummary {
  ageGroup: string;
  detectedGenders: string[];
  hasMixed: boolean;
  hasOverride: boolean; // manual force via competition_age_groups
}

const genderChip = (g: string) => {
  if (g === "Mixed")
    return "bg-purple-100 text-purple-800 border-purple-300";
  if (g === "Female" || g === "Girls")
    return "bg-pink-100 text-pink-800 border-pink-300";
  if (g === "Male" || g === "Boys")
    return "bg-blue-100 text-blue-800 border-blue-300";
  return "bg-gray-100 text-gray-700 border-gray-300";
};

const CompetitionGenderAdmin: React.FC = () => {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [rows, setRows] = useState<AgeGroupSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
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

  // Load age group data when competition changes
  useEffect(() => {
    if (!selectedId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setStatusMsg(null);
    setErrorMsg(null);

    const load = async () => {
      // Get all (age_group, gender) combinations from teams for this competition
      const { data: teamData, error: teamErr } = await supabase
        .from("teams")
        .select("age_group, gender")
        .eq("competition_id", selectedId)
        .not("age_group", "is", null);

      if (teamErr) {
        setErrorMsg("Failed to load teams: " + teamErr.message);
        setLoading(false);
        return;
      }

      // Get any manual overrides saved in competition_age_groups
      const { data: overrideData } = await supabase
        .from("competition_age_groups")
        .select("age_label, gender_type")
        .eq("competition_id", selectedId);

      const overrideSet = new Set(
        (overrideData ?? []).map((r: any) => r.age_label as string)
      );

      // Build map of age_group -> set of detected genders
      const ageMap = new Map<string, Set<string>>();
      for (const row of teamData ?? []) {
        const ag = row.age_group as string;
        const g = row.gender as string | null;
        if (!ageMap.has(ag)) ageMap.set(ag, new Set());
        if (g) ageMap.get(ag)!.add(g);
      }

      // Sort age groups numerically (U8 < U10 < U12 ... < Junior < SLG)
      const sorted = Array.from(ageMap.keys()).sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, ""), 10);
        const numB = parseInt(b.replace(/\D/g, ""), 10);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        if (!isNaN(numA)) return -1;
        if (!isNaN(numB)) return 1;
        return a.localeCompare(b);
      });

      setRows(
        sorted.map((ag) => {
          const genders = Array.from(ageMap.get(ag)!);
          return {
            ageGroup: ag,
            detectedGenders: genders,
            hasMixed: genders.some((g) => g === "Mixed"),
            hasOverride: overrideSet.has(ag),
          };
        })
      );
      setLoading(false);
    };

    void load();
  }, [selectedId]);

  const toggleOverride = async (ageGroup: string, currentlyOn: boolean) => {
    if (!selectedId) return;
    setSaving(ageGroup);
    setStatusMsg(null);
    setErrorMsg(null);

    try {
      if (currentlyOn) {
        await supabase
          .from("competition_age_groups")
          .delete()
          .eq("competition_id", selectedId)
          .eq("age_label", ageGroup);
      } else {
        await supabase
          .from("competition_age_groups")
          .upsert(
            {
              competition_id: selectedId,
              age_label: ageGroup,
              gender_type: "Mixed",
            },
            { onConflict: "competition_id,age_label" }
          );
      }

      setRows((prev) =>
        prev.map((r) =>
          r.ageGroup === ageGroup ? { ...r, hasOverride: !currentlyOn } : r
        )
      );
      setStatusMsg(
        `${ageGroup} manual override ${!currentlyOn ? "enabled" : "removed"}.`
      );
    } catch (e: any) {
      setErrorMsg("Save failed: " + String(e?.message ?? e));
    } finally {
      setSaving(null);
    }
  };

  const competition = competitions.find((c) => c.id === selectedId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-1">Competition Gender Settings</h2>
        <p className="text-gray-500 text-sm">
          Gender composition is auto-detected from BC import data. Age groups
          containing Mixed teams automatically trigger cross-pool clash
          checking. Use the manual override only if detected data is incorrect.
        </p>
      </div>

      {/* Competition selector */}
      <div className="bg-white rounded-xl shadow p-6 max-w-xl">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Competition
        </label>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">-- Select competition --</option>
          {competitions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Age group table */}
      {selectedId && (
        <div className="bg-white rounded-xl shadow p-6 max-w-4xl">
          <div className="mb-4">
            <h3 className="font-semibold text-gray-800">{competition?.name}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Detected from imported teams. Each age group may contain multiple
              gender pools -- all are shown.
            </p>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 py-4">Loading age groups...</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-gray-400 py-4">
              No teams found for this competition. Import a BC CSV first.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-4 font-medium text-gray-600 w-24">
                    Age Group
                  </th>
                  <th className="text-left py-2 pr-4 font-medium text-gray-600">
                    Detected Genders
                  </th>
                  <th className="text-left py-2 pr-4 font-medium text-gray-600 w-36">
                    Cross-pool Check
                  </th>
                  <th className="text-left py-2 font-medium text-gray-600 w-44">
                    Manual Override
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => {
                  const crossPool = row.hasMixed || row.hasOverride;
                  return (
                    <tr key={row.ageGroup} className="hover:bg-gray-50">
                      {/* Age group */}
                      <td className="py-3 pr-4 font-semibold text-gray-800">
                        {row.ageGroup}
                      </td>

                      {/* Detected gender chips */}
                      <td className="py-3 pr-4">
                        <div className="flex flex-wrap gap-1.5">
                          {row.detectedGenders.length === 0 ? (
                            <span className="text-xs text-gray-400">
                              None detected
                            </span>
                          ) : (
                            row.detectedGenders.map((g) => (
                              <span
                                key={g}
                                className={`text-xs px-2 py-0.5 rounded-full border font-medium ${genderChip(g)}`}
                              >
                                {g}
                              </span>
                            ))
                          )}
                        </div>
                      </td>

                      {/* Cross-pool status */}
                      <td className="py-3 pr-4">
                        {crossPool ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-purple-700 bg-purple-50 border border-purple-200 px-2 py-0.5 rounded-full">
                            Yes
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">No</span>
                        )}
                      </td>

                      {/* Manual override */}
                      <td className="py-3">
                        {row.hasMixed ? (
                          <span className="text-xs text-gray-400 italic">
                            Auto -- Mixed detected
                          </span>
                        ) : (
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={row.hasOverride}
                              disabled={saving === row.ageGroup}
                              onChange={() =>
                                void toggleOverride(row.ageGroup, row.hasOverride)
                              }
                              className="rounded border-gray-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                            />
                            <span className="text-xs text-gray-600">
                              {saving === row.ageGroup
                                ? "Saving..."
                                : "Force cross-pool"}
                            </span>
                          </label>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
          <div className="mt-6 pt-4 border-t text-xs text-gray-500 space-y-1.5">
            <p>
              <strong>Cross-pool check -- Yes</strong> means jersey numbers must
              be unique across ALL teams in that age group at a club, not just
              within one team — this fires purely from Mixed-gender teams or the
              manual override below, regardless of Shopify product setup. A
              separate, additional check at reservation time also blocks the same
              number across a club's mens/womens Shopify stock pools, but only for
              clubs with both products configured.
            </p>
            <p>
              <strong>Mixed detected</strong> -- the BC import found teams running
              mixed-gender competition in this age group. Cross-pool check is
              triggered automatically.
            </p>
            <p>
              <strong>Manual override</strong> -- forces cross-pool for an age
              group where BC data shows only single-gender teams but mixed play
              is known to occur.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default CompetitionGenderAdmin;
