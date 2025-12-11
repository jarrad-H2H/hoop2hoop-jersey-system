// FILE: src/components/ClubManager.tsx
import React, { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import { Club } from '../types';
import { Loader2, RefreshCw, Search, Plus, Building2 } from 'lucide-react';

const ClubManager: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [newClubName, setNewClubName] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchClubs = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from('clubs')
        .select('*')
        .order('name', { ascending: true });

      if (error) throw error;
      setClubs(data || []);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch clubs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClubs();
  }, []);

  const handleToggleClient = async (id: string, currentStatus: boolean) => {
    // Optimistic update
    const originalClubs = [...clubs];
    const updatedClubs = clubs.map((c) =>
      c.id === id ? { ...c, is_client: !currentStatus } : c
    );
    setClubs(updatedClubs);

    try {
      const { error } = await supabase
        .from('clubs')
        .update({ is_client: !currentStatus })
        .eq('id', id);

      if (error) throw error;
    } catch (err: any) {
      // Revert on error
      setClubs(originalClubs);
      setError(`Failed to update status: ${err.message}`);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClubName.trim()) return;

    setCreating(true);
    setError(null);
    try {
      const { error } = await supabase.from('clubs').insert([
        {
          name: newClubName.trim(),
          is_client: false,
        },
      ]);

      if (error) throw error;
      setNewClubName('');
      await fetchClubs();
    } catch (err: any) {
      setError(err.message || 'Failed to create club');
    } finally {
      setCreating(false);
    }
  };

  const filteredClubs = clubs.filter((c) =>
    c.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-3xl font-bold text-gray-900 flex items-center">
          <Building2 className="mr-3 text-indigo-600" size={32} />
          Club Manager
        </h1>
        <div className="flex items-center space-x-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-initial">
            <input
              type="text"
              placeholder="Search clubs..."
              className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <Search
              className="absolute left-3 top-2.5 text-gray-400"
              size={18}
            />
          </div>
          <button
            onClick={fetchClubs}
            className="p-2 text-gray-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            title="Refresh List"
          >
            <RefreshCw
              size={20}
              className={loading ? 'animate-spin' : ''}
            />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* List Section */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
            <h2 className="font-semibold text-gray-700">Registered Clubs</h2>
            <span className="text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2 py-1 rounded-full">
              {filteredClubs.length} / {clubs.length}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                  <th className="p-4 font-semibold">Club Name</th>
                  <th className="p-4 font-semibold text-center w-32">
                    Is Client?
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading && clubs.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="p-8 text-center text-gray-500">
                      <div className="flex justify-center items-center space-x-2">
                        <Loader2 className="animate-spin" size={20} />
                        <span>Loading data...</span>
                      </div>
                    </td>
                  </tr>
                ) : filteredClubs.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="p-8 text-center text-gray-500">
                      No clubs found.
                    </td>
                  </tr>
                ) : (
                  filteredClubs.map((club) => (
                    <tr
                      key={club.id}
                      className="hover:bg-gray-50 transition-colors"
                    >
                      <td className="p-4 font-medium text-gray-900">
                        {club.name}
                      </td>
                      <td className="p-4 text-center">
                        <button
                          onClick={() =>
                            handleToggleClient(club.id, club.is_client)
                          }
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                            club.is_client ? 'bg-indigo-600' : 'bg-gray-200'
                          }`}
                          title="Toggle Client Status"
                        >
                          <span
                            className={`${
                              club.is_client ? 'translate-x-6' : 'translate-x-1'
                            } inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out shadow-sm`}
                          />
                        </button>
                      </td>
                    </tr>
                  ))
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
            <form onSubmit={handleCreate} className="space-y-4">
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
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <button
                type="submit"
                disabled={creating}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg flex items-center justify-center space-x-2 transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {creating ? (
                  <Loader2 className="animate-spin" size={18} />
                ) : (
                  <Plus size={18} />
                )}
                <span>{creating ? 'Adding...' : 'Create Club'}</span>
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ClubManager;
