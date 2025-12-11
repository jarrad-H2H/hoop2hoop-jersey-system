// FILE: src/components/DataSettings.tsx
import React, { useState, useEffect } from 'react';
import { supabase } from '../services/supabase';
import { Trash2, AlertTriangle, Database, RefreshCw, Loader2 } from 'lucide-react';

const DataSettings: React.FC = () => {
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [playerCount, setPlayerCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);

  const fetchPlayerCount = async () => {
    setLoadingCount(true);
    const { count, error } = await supabase
      .from('players')
      .select('*', { count: 'exact', head: true });
    
    if (!error) {
      setPlayerCount(count);
    }
    setLoadingCount(false);
  };

  useEffect(() => {
    fetchPlayerCount();
  }, []);

  const handleDeleteAllPlayers = async () => {
    if (confirmText !== 'DELETE') return;
    
    setIsDeleting(true);
    setMessage(null);

    try {
      // Supabase JS client requires a filter to perform a delete operation.
      // We use neq (not equal) on a zero UUID to match all records.
      const { error, count } = await supabase
        .from('players')
        .delete({ count: 'exact' })
        .neq('id', '00000000-0000-0000-0000-000000000000');

      if (error) throw error;

      setMessage({ type: 'success', text: `Successfully deleted ${count ?? 'all'} player records.` });
      setConfirmText('');
      setPlayerCount(0);
    } catch (err: any) {
      setMessage({ type: 'error', text: `Error deleting data: ${err.message}` });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="flex items-center justify-between pb-6 border-b border-gray-200">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
            <Database className="text-indigo-600" />
            Data Settings
          </h1>
          <p className="text-gray-500 mt-2">Manage system-wide data operations.</p>
        </div>
        <button 
          onClick={fetchPlayerCount}
          className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <RefreshCw size={16} className={loadingCount ? 'animate-spin' : ''} />
          Refresh Stats
        </button>
      </div>

      {/* Stats Section */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide">Total Players</h3>
          <div className="mt-2 flex items-baseline">
            {loadingCount ? (
              <Loader2 className="animate-spin text-indigo-600" />
            ) : (
              <span className="text-3xl font-bold text-gray-900">
                {playerCount !== null ? playerCount.toLocaleString() : '-'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-red-50 border border-red-200 rounded-xl overflow-hidden">
        <div className="p-6 border-b border-red-100 bg-red-50/50">
          <div className="flex items-center gap-3 text-red-800">
            <AlertTriangle className="h-6 w-6" />
            <h2 className="text-lg font-bold">Danger Zone</h2>
          </div>
          <p className="mt-2 text-sm text-red-700">
            Actions here can cause irreversible data loss. Please proceed with caution.
          </p>
        </div>

        <div className="p-8">
          <div className="flex items-start space-x-4">
            <div className="bg-red-100 p-3 rounded-full flex-shrink-0">
              <Trash2 className="text-red-600" size={24} />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-bold text-gray-900">Delete All Player Data</h3>
              <p className="text-gray-600 mt-2 text-sm leading-relaxed">
                This action is <span className="font-bold text-red-600">irreversible</span>. It will permanently remove all player records imported from CSVs. 
                Inventory and Clubs will remain, but clash detection data based on existing players will be lost.
              </p>

              <div className="mt-6 p-4 bg-white rounded-lg border border-red-100">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  To confirm, type <span className="font-mono font-bold text-red-600">DELETE</span> below:
                </label>
                <div className="flex flex-col sm:flex-row gap-3">
                  <input
                    type="text"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none"
                    placeholder="DELETE"
                  />
                  <button
                    onClick={handleDeleteAllPlayers}
                    disabled={confirmText !== 'DELETE' || isDeleting}
                    className={`px-6 py-2 rounded-lg font-semibold text-white shadow-sm transition-all flex items-center justify-center gap-2 ${
                      confirmText === 'DELETE' 
                        ? 'bg-red-600 hover:bg-red-700' 
                        : 'bg-gray-300 cursor-not-allowed'
                    }`}
                  >
                    {isDeleting ? <Loader2 className="animate-spin" size={18} /> : <Trash2 size={18} />}
                    {isDeleting ? 'Deleting...' : 'Delete All Data'}
                  </button>
                </div>
              </div>

              {message && (
                <div className={`mt-4 p-3 rounded-lg flex items-center text-sm font-medium ${
                  message.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                }`}>
                  {message.type === 'success' ? (
                    <div className="w-2 h-2 bg-green-500 rounded-full mr-2" />
                  ) : (
                    <AlertTriangle size={16} className="mr-2" />
                  )}
                  {message.text}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DataSettings;
