// FILE: src/pages/ClubManager.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Plus, Building2, Search, ChevronDown, ChevronRight, Save } from "lucide-react";
import { SkeletonBar } from "../components/ui/Skeleton";
import EmptyState from "../components/ui/EmptyState";

// ── Widget config types ──────────────────────────────────────────────────────

export interface WidgetAgeGroup {
  label: string;
  max_age?: number;
}

export interface WidgetConfig {
  order_mode: "stock" | "fcfs" | "pre_allocated";
  collect_surname: boolean;
  collect_prefs: boolean;
  allow_reclaim: boolean;
  ask_new_returning: boolean;
  collect_gender: boolean;
  age_group_mode: "auto_yob" | "customer_select" | "window_set" | null;
  age_groups: WidgetAgeGroup[];
  current_window_age_group: string | null;
}

const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  order_mode: "stock",
  collect_surname: false,
  collect_prefs: true,
  allow_reclaim: false,
  ask_new_returning: true,
  collect_gender: false,
  age_group_mode: null,
  age_groups: [],
  current_window_age_group: null,
};

function resolveWidgetConfig(raw: WidgetConfig | null, allocationTypeDb: string | null, preorderModeDb: string): WidgetConfig {
  if (raw) return { ...DEFAULT_WIDGET_CONFIG, ...raw };
  // Infer from existing DB columns for clubs that predate widget_config
  const order_mode: WidgetConfig["order_mode"] =
    allocationTypeDb === "pre_allocated" ? "pre_allocated" :
    preorderModeDb !== "off" ? "fcfs" : "stock";
  return { ...DEFAULT_WIDGET_CONFIG, order_mode };
}

// ── Club interface ───────────────────────────────────────────────────────────

interface ClubRow {
  id: string;
  name: string;
  is_client: boolean;
  allocation_type: string | null;
  preorder_mode: string;
  widget_config: WidgetConfig | null;
}

const ORDER_MODE_LABELS: Record<WidgetConfig["order_mode"], string> = {
  stock: "Stock",
  fcfs: "FCFS Pre-Order",
  pre_allocated: "Pre-Allocated",
};

const ORDER_MODE_BADGE: Record<WidgetConfig["order_mode"], string> = {
  stock: "bg-gray-100 text-gray-700",
  fcfs: "bg-blue-100 text-blue-700",
  pre_allocated: "bg-purple-100 text-purple-700",
};

// ── Toggle component ─────────────────────────────────────────────────────────

const Toggle: React.FC<{ label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, hint, checked, onChange }) => (
  <label className="flex items-start gap-3 cursor-pointer group">
    <div className="mt-0.5 flex-shrink-0">
      <div
        onClick={() => onChange(!checked)}
        className={`w-10 h-5 rounded-full transition-colors flex items-center ${checked ? "bg-indigo-600" : "bg-gray-300"}`}
      >
        <span className={`block w-4 h-4 rounded-full bg-white shadow-sm transition-transform mx-0.5 ${checked ? "translate-x-5" : "translate-x-0"}`} />
      </div>
    </div>
    <div>
      <div className="text-sm font-medium text-gray-800">{label}</div>
      {hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}
    </div>
  </label>
);

// ── Age group list editor ────────────────────────────────────────────────────

const AgeGroupEditor: React.FC<{
  groups: WidgetAgeGroup[];
  showMaxAge: boolean;
  onChange: (groups: WidgetAgeGroup[]) => void;
}> = ({ groups, showMaxAge, onChange }) => {
  const update = (i: number, field: keyof WidgetAgeGroup, value: string) => {
    const next = groups.map((g, idx) =>
      idx === i
        ? { ...g, [field]: field === "max_age" ? (value === "" ? undefined : Number(value)) : value }
        : g
    );
    onChange(next);
  };
  const remove = (i: number) => onChange(groups.filter((_, idx) => idx !== i));
  const add = () => onChange([...groups, { label: "", ...(showMaxAge ? { max_age: undefined } : {}) }]);

  return (
    <div className="space-y-2">
      {groups.map((g, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className="border rounded px-2 py-1 text-sm flex-1"
            placeholder="e.g. U14 Rep"
            value={g.label}
            onChange={e => update(i, "label", e.target.value)}
          />
          {showMaxAge && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-500 whitespace-nowrap">Max age</span>
              <input
                type="number"
                className="border rounded px-2 py-1 text-sm w-16"
                placeholder="18"
                value={g.max_age ?? ""}
                onChange={e => update(i, "max_age", e.target.value)}
                min={1}
                max={99}
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-red-400 hover:text-red-700 text-lg leading-none px-1"
            title="Remove"
          >×</button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-sm text-indigo-600 hover:text-indigo-800 font-medium"
      >+ Add age group</button>
    </div>
  );
};

// ── Main component ───────────────────────────────────────────────────────────

const ClubManager: React.FC = () => {
  const [clubs, setClubs] = useState<ClubRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [newClubName, setNewClubName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Expand/settings state
  const [expandedClubId, setExpandedClubId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Edit form state (for the currently expanded club)
  const [editName, setEditName] = useState("");
  const [editIsClient, setEditIsClient] = useState(false);
  const [editOrderMode, setEditOrderMode] = useState<WidgetConfig["order_mode"]>("stock");
  const [editCollectSurname, setEditCollectSurname] = useState(false);
  const [editCollectPrefs, setEditCollectPrefs] = useState(true);
  const [editAllowReclaim, setEditAllowReclaim] = useState(false);
  const [editAskNewReturning, setEditAskNewReturning] = useState(true);
  const [editCollectGender, setEditCollectGender] = useState(false);
  const [editAgeGroupMode, setEditAgeGroupMode] = useState<WidgetConfig["age_group_mode"]>(null);
  const [editAgeGroups, setEditAgeGroups] = useState<WidgetAgeGroup[]>([]);

  const fetchClubs = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("clubs")
      .select("id, name, is_client, allocation_type, preorder_mode, widget_config")
      .order("name");
    setClubs((data ?? []) as ClubRow[]);
    setLoading(false);
  };

  useEffect(() => { void fetchClubs(); }, []);

  const filteredClubs = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) return clubs;
    return clubs.filter(c => c.name.toLowerCase().includes(needle));
  }, [clubs, searchTerm]);

  const expandClub = (club: ClubRow) => {
    if (expandedClubId === club.id) {
      setExpandedClubId(null);
      return;
    }
    setExpandedClubId(club.id);
    setSaveMsg(null);
    setEditName(club.name);
    setEditIsClient(club.is_client);

    const wc = resolveWidgetConfig(club.widget_config, club.allocation_type, club.preorder_mode);
    setEditOrderMode(wc.order_mode);
    setEditCollectSurname(wc.collect_surname);
    setEditCollectPrefs(wc.collect_prefs);
    setEditAllowReclaim(wc.allow_reclaim);
    setEditAskNewReturning(wc.ask_new_returning);
    setEditCollectGender(wc.collect_gender);
    setEditAgeGroupMode(wc.age_group_mode);
    setEditAgeGroups(wc.age_groups ?? []);
  };

  const handleSave = async () => {
    if (!expandedClubId) return;
    const trimmedName = editName.trim();
    if (!trimmedName) { setSaveMsg({ type: "err", text: "Club name cannot be blank." }); return; }

    const club = clubs.find(c => c.id === expandedClubId);
    if (!club) return;

    // Warn if switching to Stock would close an active pre-order window
    if (editOrderMode === "stock" && club.preorder_mode !== "off") {
      if (!window.confirm(`This club currently has a pre-order window (${club.preorder_mode}). Switching to Stock mode will close it. Continue?`)) return;
    }

    setSaving(true);
    setSaveMsg(null);

    const newWidgetConfig: WidgetConfig = {
      order_mode: editOrderMode,
      collect_surname: editCollectSurname,
      collect_prefs: editCollectPrefs,
      allow_reclaim: editAllowReclaim,
      ask_new_returning: editAskNewReturning,
      collect_gender: editCollectGender,
      age_group_mode: editAgeGroupMode,
      age_groups: editAgeGroups,
      current_window_age_group: club.widget_config?.current_window_age_group ?? null,
    };

    const dbUpdate: Record<string, unknown> = {
      name: trimmedName,
      is_client: editIsClient,
      widget_config: newWidgetConfig,
    };

    if (editOrderMode === "pre_allocated") dbUpdate.allocation_type = "pre_allocated";
    else if (editOrderMode === "fcfs") dbUpdate.allocation_type = "fcfs";
    if (editOrderMode === "stock") dbUpdate.preorder_mode = "off";

    const { error } = await supabase.from("clubs").update(dbUpdate).eq("id", expandedClubId);

    if (error) {
      setSaveMsg({ type: "err", text: `Save failed: ${error.message}` });
    } else {
      setClubs(prev => prev.map(c =>
        c.id === expandedClubId
          ? { ...c, name: trimmedName, is_client: editIsClient, widget_config: newWidgetConfig, allocation_type: (dbUpdate.allocation_type as string) ?? c.allocation_type, preorder_mode: (dbUpdate.preorder_mode as string) ?? c.preorder_mode }
          : c
      ));
      setSaveMsg({ type: "ok", text: "Settings saved." });
    }
    setSaving(false);
  };

  const handleCreateClub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClubName.trim()) return;
    setIsSubmitting(true);
    const { error } = await supabase.from("clubs").insert([{ name: newClubName.trim(), is_client: false }]);
    if (!error) { setNewClubName(""); await fetchClubs(); }
    else alert("Error creating club: " + error.message);
    setIsSubmitting(false);
  };

  const isPreorderMode = editOrderMode === "fcfs" || editOrderMode === "pre_allocated";
  const isFcfs = editOrderMode === "fcfs";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-3xl font-bold text-gray-900 flex items-center">
          <Building2 className="mr-3 text-brand-600" size={32} />
          Club Manager
        </h1>
        <div className="relative">
          <input
            type="text"
            placeholder="Search clubs…"
            className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
          <Search className="absolute left-3 top-2.5 text-gray-400" size={18} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Club list */}
        <div className="lg:col-span-2 space-y-3">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 p-4">
                <SkeletonBar className="h-5 w-48" />
              </div>
            ))
          ) : filteredClubs.length === 0 ? (
            <EmptyState icon={Building2} title="No clubs found" description="Try clearing the search above, or add a new club." />
          ) : (
            filteredClubs.map(club => {
              const isExpanded = expandedClubId === club.id;
              const wc = resolveWidgetConfig(club.widget_config, club.allocation_type, club.preorder_mode);

              return (
                <div key={club.id} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                  {/* Card header — always visible */}
                  <button
                    type="button"
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors text-left"
                    onClick={() => expandClub(club)}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isExpanded ? <ChevronDown size={16} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={16} className="text-gray-400 flex-shrink-0" />}
                      <span className="font-semibold text-gray-900 truncate">{club.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${club.is_client ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                        {club.is_client ? "Client" : "Not client"}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${ORDER_MODE_BADGE[wc.order_mode]}`}>
                        {ORDER_MODE_LABELS[wc.order_mode]}
                      </span>
                    </div>
                  </button>

                  {/* Expanded settings */}
                  {isExpanded && (
                    <div className="border-t border-gray-200 px-5 py-5 space-y-5">

                      {/* Club name */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Club Name</label>
                        <input
                          className="border rounded px-3 py-2 w-full max-w-sm text-sm"
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                        />
                      </div>

                      {/* Is Client */}
                      <Toggle
                        label="Active client (widget enabled)"
                        hint="Customers can only see the jersey widget for clubs marked as active clients."
                        checked={editIsClient}
                        onChange={setEditIsClient}
                      />

                      {/* Order mode */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-700 mb-1 uppercase tracking-wide">Order Mode</label>
                        <select
                          className="border rounded px-3 py-2 text-sm"
                          value={editOrderMode}
                          onChange={e => setEditOrderMode(e.target.value as WidgetConfig["order_mode"])}
                        >
                          <option value="stock">Stock — customers choose from available inventory</option>
                          <option value="fcfs">FCFS Pre-Order — customers register preferences, numbers allocated by club</option>
                          <option value="pre_allocated">Pre-Allocated — club assigns numbers, customers confirm size</option>
                        </select>
                        {editOrderMode !== "stock" && (
                          <p className="text-xs text-gray-500 mt-1">Pre-order window (open/close/lock) is managed from the <strong>Pre-Order Manager</strong>.</p>
                        )}
                      </div>

                      {/* Pre-order field toggles */}
                      {isPreorderMode && (
                        <div className="border rounded-lg p-4 space-y-4 bg-gray-50">
                          <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Widget Fields</div>

                          <Toggle
                            label="Collect surname for printing"
                            hint='Shows a "Surname to be printed" field. Only needed if jerseys will have name printing.'
                            checked={editCollectSurname}
                            onChange={setEditCollectSurname}
                          />

                          {isFcfs && (
                            <>
                              <Toggle
                                label="Show number preferences"
                                hint="Customers enter up to 3 jersey number choices. When off, the club assigns numbers directly from the report."
                                checked={editCollectPrefs}
                                onChange={setEditCollectPrefs}
                              />

                              <Toggle
                                label='Allow "reclaim current number" option'
                                hint="Shows a checkbox for customers who want to request keeping their existing jersey number."
                                checked={editAllowReclaim}
                                onChange={setEditAllowReclaim}
                              />

                              <Toggle
                                label="New/returning player question"
                                hint="Ask whether the player is new to the club. Only useful if BC player data has been imported."
                                checked={editAskNewReturning}
                                onChange={setEditAskNewReturning}
                              />
                            </>
                          )}

                          <Toggle
                            label="Collect gender"
                            hint="Shows a gender selector. Needed for cross-pool clash detection on mixed-gender programs."
                            checked={editCollectGender}
                            onChange={setEditCollectGender}
                          />
                        </div>
                      )}

                      {/* Age group configuration */}
                      {isPreorderMode && (
                        <div className="border rounded-lg p-4 space-y-4 bg-gray-50">
                          <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Age Group</div>

                          <div>
                            <label className="block text-xs font-semibold text-gray-700 mb-1">Age Group Mode</label>
                            <select
                              className="border rounded px-3 py-2 text-sm"
                              value={editAgeGroupMode ?? ""}
                              onChange={e => setEditAgeGroupMode((e.target.value || null) as WidgetConfig["age_group_mode"])}
                            >
                              <option value="">None — age group not collected</option>
                              <option value="auto_yob">Auto-derive from year of birth</option>
                              <option value="customer_select">Customer selects from a list</option>
                              <option value="window_set">Set per window (admin sets it when opening the window)</option>
                            </select>
                          </div>

                          {editAgeGroupMode === "auto_yob" && (
                            <div>
                              <label className="block text-xs font-semibold text-gray-700 mb-2">Age Brackets</label>
                              <p className="text-xs text-gray-500 mb-3">
                                Define each bracket in order. "Max age" is the maximum age (current season year minus YOB) for that bracket. Anyone above the highest max age will be prompted to confirm their YOB and placed in the oldest bracket.
                              </p>
                              <AgeGroupEditor
                                groups={editAgeGroups}
                                showMaxAge={true}
                                onChange={setEditAgeGroups}
                              />
                            </div>
                          )}

                          {(editAgeGroupMode === "customer_select" || editAgeGroupMode === "window_set") && (
                            <div>
                              <label className="block text-xs font-semibold text-gray-700 mb-2">Age Group List</label>
                              <p className="text-xs text-gray-500 mb-3">
                                {editAgeGroupMode === "customer_select"
                                  ? "Customers will see these options in a dropdown."
                                  : "Admin will pick from these when opening a pre-order window in the Pre-Order Manager."}
                              </p>
                              <AgeGroupEditor
                                groups={editAgeGroups}
                                showMaxAge={false}
                                onChange={setEditAgeGroups}
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* Save */}
                      {saveMsg && (
                        <div className={`text-sm px-3 py-2 rounded ${saveMsg.type === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
                          {saveMsg.text}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
                      >
                        <Save size={15} />
                        {saving ? "Saving…" : "Save Settings"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Add New Club */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 h-fit">
          <div className="p-4 border-b border-gray-200 bg-gray-50">
            <h2 className="font-semibold text-gray-700">Add New Club</h2>
          </div>
          <div className="p-6">
            <form onSubmit={handleCreateClub} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Club Name</label>
                <input
                  type="text"
                  required
                  value={newClubName}
                  onChange={e => setNewClubName(e.target.value)}
                  placeholder="e.g. Gold Coast Rollers"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                />
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-brand-600 hover:bg-brand-700 text-white font-medium py-2 px-4 rounded-lg flex items-center justify-center space-x-2 transition-colors disabled:opacity-70"
              >
                {isSubmitting
                  ? <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                  : <><Plus size={18} /><span>Create Club</span></>}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ClubManager;
