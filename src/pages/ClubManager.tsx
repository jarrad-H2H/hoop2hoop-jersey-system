// FILE: src/pages/ClubManager.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Club } from "../../types";
import { Plus, Check, X, Building2, Search, Pencil } from "lucide-react";

const ClubManager: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [loading, setLoading] = useState(true);

  const [newClubName, setNewClubName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");

  // Edit state
  const [editingClubId, setEditingClubId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const fetchClubs = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("clubs")
      .select("*")
      .order("name", { ascending: true });

    if (error) {
      console.error("Error fetching clubs:", error);
    } else {
      setClubs((data || []) as Club[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void fetchClubs();
  }, []);

  const handleCreateClub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClubName.trim()) return;
    setIsSubmitting(true);

    const { error } = await supabase.from("clubs").insert([
      { name: newClubName.trim(), is_client: false },
    ]);

    if (!error) {
      setNewClubName("");
      await fetchClubs();
    } else {
      alert("Error creating club: " + error.message);
    }
    setIsSubmitting(false);
  };

  const toggleClientStatus = async (id: string, currentStatus: boolean) => {
    // Optimistic UI update
    setClubs((prev) =>
      prev.map((c) => (c.id === id ? { ...c, is_client: !currentStatus } : c))
    );

    const { error } = await supabase
      .from("clubs")
      .update({ is_client: !currentStatus })
      .eq("id", id);

    if (error) {
      console.error("Error updating status:", error);
      // Revert if error
      await fetchClubs();
    }
  };

  const filteredClubs = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) return clubs;
    return clubs.filter((c) => c.name.toLowerCase().includes(needle));
  }, [clubs, searchTerm]);

  const startEdit = (club: Club) => {
    setEditingClubId(club.id);
    setEditingName(club.name ?? "");
  };

  const cancelEdit = () => {
    setEditingClubId(null);
    setEditingName("");
    setSavingEdit(false);
  };

  const saveEdit = async () => {
    if (!editingClubId) return;

    const nextName = editingName.trim();
    if (!nextName) return;

    // No-op
    const existing = clubs.find((c) => c.id === editingClubId);
    if (existing && (existing.name ?? "").trim() === nextName) {
      cancelEdit();
      return;
    }

    setSavingEdit(true);

    const { error } = await supabase
      .from("clubs")
      .update({ name: nextName })
      .eq("id", editingClubId);

    if (error) {
      console.error("Error updating club name:", error);
      alert("Error updating club name: " + error.message);
      setSavingEdit(false);
      return;
    }

    await fetchClubs();
    cancelEdit();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-3xl font-bold text-gray-900 flex items-center">
          <Building2 className="mr-3 text-brand-600" size={32} />
          Club Manager
        </h1>

        <div className="relative">
          <input
            type="text"
            placeholder="Search clubs..."
            className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <Search className="absolute left-3 top-2.5 text-gray-400" size={18} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* List Section */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
            <h2 className="font-semibold text-gray-700">Registered Clubs</h2>
            <span className="text-sm bg-brand-100 text-brand-700 px-2 py-1 rounded-full">
              {clubs.length} Total
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                  <th className="p-4 font-semibold">Club Name</th>
                  <th className="p-4 font-semibold text-center">Is Client?</th>
                  <th className="p-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td colSpan={3} className="p-8 text-center text-gray-500">
                      Loading clubs...
                    </td>
                  </tr>
                ) : filteredClubs.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="p-8 text-center text-gray-500">
                      No clubs found.
                    </td>
                  </tr>
                ) : (
                  filteredClubs.map((club) => {
                    const isEditing = editingClubId === club.id;

                    return (
                      <tr
                        key={club.id}
                        className="hover:bg-gray-50 transition-colors"
                      >
                        <td className="p-4 font-medium text-gray-900">
                          {!isEditing ? (
                            club.name
                          ) : (
                            <input
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              className="w-full max-w-md border border-gray-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                              placeholder="Club name"
                              autoFocus
                            />
                          )}
                        </td>

                        <td className="p-4 text-center">
                          <button
                            onClick={() =>
                              toggleClientStatus(club.id, club.is_client)
                            }
                            className={`inline-flex items-center justify-center w-12 h-6 rounded-full transition-colors ${
                              club.is_client ? "bg-green-100" : "bg-gray-200"
                            }`}
                            title="Toggle client status"
                          >
                            <span
                              className={`transform transition-transform duration-200 ${
                                club.is_client
                                  ? "translate-x-3 bg-green-500"
                                  : "-translate-x-3 bg-gray-400"
                              } w-4 h-4 rounded-full shadow-sm`}
                            ></span>
                          </button>
                        </td>

                        <td className="p-4 text-right">
                          {!isEditing ? (
                            <button
                              type="button"
                              onClick={() => startEdit(club)}
                              className="inline-flex items-center gap-2 text-brand-600 hover:text-brand-800 text-sm font-medium"
                            >
                              <Pencil size={16} />
                              Edit
                            </button>
                          ) : (
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                onClick={saveEdit}
                                disabled={savingEdit}
                                className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-emerald-600 text-white text-sm font-semibold disabled:bg-gray-400"
                                title="Save"
                              >
                                <Check size={16} />
                                {savingEdit ? "Saving..." : "Save"}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEdit}
                                disabled={savingEdit}
                                className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-gray-200 text-gray-800 text-sm font-semibold hover:bg-gray-300 disabled:opacity-60"
                                title="Cancel"
                              >
                                <X size={16} />
                                Cancel
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Create Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 h-fit">
          <div className="p-4 border-b border-gray-200 bg-gray-50">
            <h2 className="font-semibold text-gray-700">Add New Club</h2>
          </div>
          <div className="p-6">
            <form onSubmit={handleCreateClub} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Club Name
                </label>
                <input
                  type="text"
                  required
                  value={newClubName}
                  onChange={(e) => setNewClubName(e.target.value)}
                  placeholder="e.g. Gold Coast Rollers"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-brand-600 hover:bg-brand-700 text-white font-medium py-2 px-4 rounded-lg flex items-center justify-center space-x-2 transition-colors disabled:opacity-70"
              >
                {isSubmitting ? (
                  <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></span>
                ) : (
                  <>
                    <Plus size={18} />
                    <span>Create Club</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ClubManager;
