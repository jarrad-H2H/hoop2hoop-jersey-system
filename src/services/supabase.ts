import { createClient } from '@supabase/supabase-js';

// Direct Supabase connection for the Hoop2Hoop System.
// Hardcoded to ensure connection reliability and bypass environment variable issues.

const SUPABASE_URL = "https://ulnyylqcjaeynmrxught.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsbnl5bHFjamFleW5tcnh1Z2h0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQxMDI5MjksImV4cCI6MjA3OTY3ODkyOX0.R5kgDpvaFs7xuKJFhO8YtJ50UnSKCNoOnbgTkSyZhZA";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);