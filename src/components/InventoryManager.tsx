import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../services/supabase';
import { Club, Inventory } from '../types';
import { Shirt, Save, Info, Loader2, Clock, AlertCircle, CheckCircle2 } from 'lucide-react';

const InventoryManager: React.FC = () => {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [selectedClub, setSelectedClub] = useState<string>('');
  const [size, setSize] = useState<string>('M');
  const [numbersString, setNumbersString] = useState('');
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [recentItems, setRecentItems] = useState<Inventory[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);

  // Fetch clubs on mount
  useEffect(() => {
    const fetchClubs = async () => {
      const { data } = await supabase.from('clubs').select('*').order('name');
      if (data) setClubs(data);
    };
    fetchClubs();
  }, []);

  // Fetch recent inventory items for the selected club
  const fetchRecentInventory = useCallback(async () => {
    if (!selectedClub) {
      setRecentItems([]);
      return;
    }
    
    setLoadingRecent(true);
    try {
      const { data, error } = await supabase
        .from('inventory')
        .select('*')
        .eq('club_id', selectedClub)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      setRecentItems(data || []);
    } catch (error) {
      console.error('Error fetching recent inventory:', error);
    } finally {
      setLoadingRecent(false);
    }
  }, [selectedClub]);

  // Refresh recent items when club changes
  useEffect(() => {
    fetchRecentInventory();
  }, [fetchRecentInventory]);

  const handleBatchInsert = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedClub || !numbersString.trim()) {
      setStatus({ type: 'error', message: 'Please select a club and enter jersey numbers.' });
      return;
    }

    setIsSubmitting(true);
    setStatus(null);

    // Parse numbers: split by comma, trim, filter empties, convert to int
    const numbers = numbersString
      .split(',')
      .map(n => n.trim())
      .filter(n => n !== '')
      .map(n => parseInt(n, 10))
      .filter(n => !isNaN(n));

    if (numbers.length === 0) {
      setStatus({ type: 'error', message: 'No valid numbers detected in input.' });
      setIsSubmitting(false);
      return;
    }

    // Prepare payload
    const payload = numbers.map(num => ({
      club_id: selectedClub,
      jersey_number: num,
      size: size,
      condition: 'New',
      status: 'Available',
      created_at: new Date().toISOString()
    }));

    try {
      const { error } = await supabase
        .from('inventory')
        .insert(payload);

      if (error) throw error;

      setStatus({ type: 'success', message: `Successfully added ${numbers.length} inventory items.` });
      setNumbersString(''); // Clear input on success
      fetchRecentInventory(); // Refresh the list
    } catch (err: any) {
      setStatus({ type: 'error', message: `Error adding inventory: ${err.message}` });
    } finally {
      setIsSubmitting(false);
    }
  };

  const sizes = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

  return (
    <div className="space-y-8">
      <div className="flex items-center space-x-3">
        <div className="bg-indigo-100 p-2.5 rounded-lg">
          <Shirt className="text-indigo-600" size={32} />
        </div>
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Inventory Manager</h1>
          <p className="text-gray-500">Add and track jersey stock levels</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Input Form */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-6 flex items-center">
              <PlusCircleIcon className="w-5 h-5 mr-2 text-gray-500" />
              Batch Add Inventory
            </h2>
            
            <form onSubmit={handleBatchInsert} className="space-y-6">
              {status && (
                <div className={`p-4 rounded-lg flex items-start ${
                  status.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                }`}>
                  {status.type === 'success' ? (
                    <CheckCircle2 className="w-5 h-5 mr-2 mt-0.5 flex-shrink-0" />
                  ) : (
                    <AlertCircle className="w-5 h-5 mr-2 mt-0.5 flex-shrink-0" />
                  )}
                  <span>{status.message}</span>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Select Club</label>
                  <select
                    required
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 bg-white"
                    value={selectedClub}
                    onChange={(e) => setSelectedClub(e.target.value)}
                  >
                    <option value="">-- Choose Club --</option>
                    {clubs.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Size</label>
                  <select
                    required
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 bg-white"
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                  >
                    {sizes.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Jersey Numbers (Comma Separated)
                </label>
                <div className="relative">
                  <textarea
                    required
                    rows={3}
                    placeholder="e.g. 4, 5, 10, 23, 45"
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm"
                    value={numbersString}
                    onChange={(e) => setNumbersString(e.target.value)}
                  />
                  <div className="absolute bottom-3 right-3 text-gray-400" title="Separate numbers with commas">
                    <Info size={16} />
                  </div>
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Duplicates (Same Club + Number) will be rejected by database constraints.
                </p>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full md:w-auto bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 px-6 rounded-lg shadow-sm flex items-center justify-center space-x-2 transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <Loader2 className="animate-spin" size={18} />
                  ) : (
                    <Save size={18} />
                  )}
                  <span>{isSubmitting ? 'Saving...' : 'Add to Inventory'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Recent Items List */}
        <div className="lg:col-span-1">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden h-full flex flex-col">
            <div className="p-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <h3 className="font-semibold text-gray-700 flex items-center">
                <Clock className="w-4 h-4 mr-2 text-gray-500" />
                Recent Additions
              </h3>
              {selectedClub && !loadingRecent && (
                <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">
                  Last 20
                </span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto max-h-[500px]">
              {loadingRecent ? (
                <div className="p-8 text-center text-gray-500">
                  <Loader2 className="animate-spin mx-auto mb-2" size={24} />
                  <p className="text-sm">Loading inventory...</p>
                </div>
              ) : !selectedClub ? (
                <div className="p-8 text-center text-gray-400">
                  <p className="text-sm">Select a club to view recent items.</p>
                </div>
              ) : recentItems.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <p className="text-sm">No inventory records found.</p>
                </div>
              ) : (
                <table className="w-full text-sm text-left">
                  <thead className="bg-gray-50 text-gray-500 text-xs uppercase sticky top-0">
                    <tr>
                      <th className="px-4 py-2 font-medium">#</th>
                      <th className="px-4 py-2 font-medium">Size</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {recentItems.map((item) => (
                      <tr key={item.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-medium text-gray-900">
                          #{item.jersey_number}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600">
                          {item.size}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            item.status === 'Available' 
                              ? 'bg-green-100 text-green-800' 
                              : 'bg-yellow-100 text-yellow-800'
                          }`}>
                            {item.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const PlusCircleIcon = ({ className }: { className?: string }) => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className={className}
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v8" />
    <path d="M8 12h8" />
  </svg>
);

export default InventoryManager;