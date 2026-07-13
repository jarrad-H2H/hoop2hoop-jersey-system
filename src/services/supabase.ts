import { createClient } from '@supabase/supabase-js';

// Direct Supabase connection for the Hoop2Hoop System.
// Hardcoded to ensure connection reliability and bypass environment variable issues.

const SUPABASE_URL = "https://ulnyylqcjaeynmrxught.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsbnl5bHFjamFleW5tcnh1Z2h0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQxMDI5MjksImV4cCI6MjA3OTY3ODkyOX0.R5kgDpvaFs7xuKJFhO8YtJ50UnSKCNoOnbgTkSyZhZA";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const PAGE_SIZE = 1000;

/** Pages through a Supabase query in batches of 1000.
 * PostgREST silently caps responses at 1000 rows — any query that could return
 * more must use this helper or risk silent data truncation.
 * Usage: fetchAllPages((from, to) => supabase.from("x").select("y").range(from, to)) */
export async function fetchAllPages<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}