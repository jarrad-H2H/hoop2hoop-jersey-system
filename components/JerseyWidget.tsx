import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../services/supabase';
import { Inventory, Player } from '../types';
import { AlertCircle, Check, Loader2 } from 'lucide-react';

interface JerseyWidgetProps {
  clubId: string;
  playerYob: number;
  teamKnown: boolean;
  teamCode?: string; // Required if teamKnown is true
  onNumberSelected: (number: number) => void;
}

// Define a partial Player type that matches what we select from Supabase
type WidgetPlayer = Pick<Player, 'jersey_number' | 'team_code' | 'yob'>;

const JerseyWidget: React.FC<JerseyWidgetProps> = ({
  clubId,
  playerYob,
  teamKnown,
  teamCode,
  onNumberSelected,
}) => {
  const [inventory, setInventory] = useState<Inventory[]>([]);
  // Update state type to WidgetPlayer[] instead of Player[] to handle partial data
  const [players, setPlayers] = useState<WidgetPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!clubId) throw new Error("Club ID is required");

        // 1. Fetch Inventory for Club (Available Only)
        const { data: invData, error: invError } = await supabase
          .from('inventory')
          .select('*')
          .eq('club_id', clubId)
          .eq('status', 'Available');

        if (invError) throw invError;

        // 2. Fetch Players for Club to calculate clashes
        const { data: playerData, error: playerError } = await supabase
          .from('players')
          .select('jersey_number, team_code, yob')
          .eq('club_id', clubId);

        if (playerError) throw playerError;

        setInventory(invData || []);
        // Cast to WidgetPlayer[] to satisfy TypeScript since we only selected partial fields
        setPlayers((playerData || []) as unknown as WidgetPlayer[]);
      } catch (err: any) {
        setError(err.message || 'Failed to load jersey data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [clubId]);

  const availableNumbers = useMemo(() => {
    if (!players || !inventory) return [];

    // Set of numbers that exist in inventory
    const inventoryNumbers = new Set(inventory.map((i) => i.jersey_number));
    
    // Determine clashed numbers based on rules
    const clashedNumbers = new Set<number>();

    players.forEach((p) => {
      let isClash = false;

      if (teamKnown && teamCode) {
        // Rule: If team is known, clash with anyone in the exact same team code
        // We normalize to lowercase for comparison safety
        if (p.team_code?.toLowerCase() === teamCode.toLowerCase()) {
          isClash = true;
        }
      } else {
        // Rule: Team Unknown -> Clash with YOB +/- 1 year
        const yobDiff = Math.abs(p.yob - playerYob);
        if (yobDiff <= 1) {
          isClash = true;
        }
      }

      if (isClash) {
        clashedNumbers.add(p.jersey_number);
      }
    });

    // Filter inventory: Must be in inventory AND not clashed
    // Convert to array and sort
    return Array.from(inventoryNumbers)
      .filter((num) => !clashedNumbers.has(num))
      .sort((a, b) => a - b);

  }, [players, inventory, teamKnown, teamCode, playerYob]);

  const handleSelect = (num: number) => {
    setSelectedNumber(num);
    onNumberSelected(num);
  };

  if (loading) {
    return (
      <div className="p-6 bg-white rounded-xl shadow-sm border border-gray-100 flex justify-center items-center h-48">
        <Loader2 className="animate-spin text-indigo-600" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 text-red-700 rounded-lg flex items-start space-x-2">
        <AlertCircle size={20} className="mt-0.5 flex-shrink-0" />
        <div>
          <h4 className="font-semibold">Error Loading Widget</h4>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden max-w-md w-full">
      <div className="bg-indigo-600 p-4">
        <h3 className="text-white font-bold text-lg flex items-center gap-2">
          <ShirtIcon className="w-5 h-5" />
          Select Jersey Number
        </h3>
        <p className="text-indigo-100 text-sm mt-1">
          {teamKnown 
            ? `Showing safe numbers for team: ${teamCode}`
            : `Showing safe numbers for YOB: ${playerYob} (±1yr)`}
        </p>
      </div>

      <div className="p-4">
        {availableNumbers.length === 0 ? (
          <div className="text-center py-8 bg-gray-50 rounded-lg">
            <p className="text-gray-500 font-medium">No jersey numbers available matching your criteria.</p>
            <p className="text-xs text-gray-400 mt-2">Please contact your club administrator.</p>
          </div>
        ) : (
          <div className="grid grid-cols-4 sm:grid-cols-5 gap-3 max-h-60 overflow-y-auto pr-1 custom-scrollbar">
            {availableNumbers.map((num) => (
              <button
                key={num}
                onClick={() => handleSelect(num)}
                className={`
                  relative h-12 rounded-md font-bold text-lg transition-all duration-200 flex items-center justify-center border-2
                  ${selectedNumber === num 
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-md transform scale-105' 
                    : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}
                `}
              >
                {num}
                {selectedNumber === num && (
                  <div className="absolute -top-2 -right-2 bg-green-500 text-white rounded-full p-0.5">
                    <Check size={10} strokeWidth={4} />
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="p-4 bg-gray-50 border-t border-gray-100 text-xs text-gray-500 flex justify-between items-center">
        <span>{availableNumbers.length} numbers available</span>
        {selectedNumber !== null && (
          <span className="font-semibold text-indigo-600">Selected: #{selectedNumber}</span>
        )}
      </div>
    </div>
  );
};

const ShirtIcon = ({ className }: { className?: string }) => (
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
    <path d="M20.38 3.46L16 2a4 4 0 01-8 0L3.62 3.46a2 2 0 00-1.34 2.23l.58 3.47a1 1 0 00.99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 002-2V10h2.15a1 1 0 00.99-.84l.58-3.47a2 2 0 00-1.34-2.23z" />
  </svg>
);

export default JerseyWidget;