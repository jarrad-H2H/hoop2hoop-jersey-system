export interface Club {
  id: string; // uuid
  name: string;
  is_client: boolean;
  aliases: string[] | null;
  created_at: string;
}

export interface Player {
  id?: string; // uuid (optional for inserts)
  first_name: string;
  last_name: string;
  club_id: string; // uuid
  team_id?: string;
  team_name_raw: string;
  team_code: string;
  team_label?: string;
  age_group?: string;
  division_grade?: string;
  competition_source?: string;
  final_shirt?: number;
  yob: number;
  jersey_number: number;
  created_at?: string;
}

export interface Inventory {
  id: string; // uuid
  club_id: string; // uuid
  jersey_number: number;
  size: string;
  condition: string;
  status: 'Available' | 'Allocated';
  allocated_player_id?: string | null;
  allocation_date?: string | null;
  return_date_due?: string | null;
  created_at: string;
}

export enum ImporterStrategy {
  StrategyA = 'A', // Club Name First (e.g., "Warriors 16B.2")
  StrategyB = 'B', // Age/Div First (e.g., "12BC3 Amigos White")
}

export interface CsvRow {
  first_name: string;
  last_name: string;
  team_raw: string;
  jersey_number: string;
  yob: string;
  final_shirt?: string;
}