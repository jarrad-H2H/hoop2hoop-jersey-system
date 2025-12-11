import { createClient } from '@supabase/supabase-js';

// Helper to safely get env vars regardless of the environment (Vite vs others)
const getEnvVar = (key: string): string => {
  // Check import.meta.env (Vite standard)
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env[key]) {
    return import.meta.env[key];
  }
  
  // Check process.env (Legacy/Other build tools) - safely access global process
  try {
    // @ts-ignore
    if (typeof process !== 'undefined' && process.env && process.env[key]) {
      // @ts-ignore
      return process.env[key];
    }
  } catch (e) {
    // Ignore ReferenceError if process is not defined
  }

  return '';
};

const supabaseUrl = getEnvVar('VITE_SUPABASE_URL');
const supabaseAnonKey = getEnvVar('VITE_SUPABASE_ANON_KEY');

// If URL/Key are missing, we use a placeholder to prevent the app from crashing immediately 
// with "Uncaught Error: supabaseUrl is required".
// This allows the UI to render, though auth/data calls will fail until env vars are set.
const validUrl = supabaseUrl || 'https://placeholder.supabase.co';
const validKey = supabaseAnonKey || 'placeholder-key';

if (!supabaseUrl) {
  console.warn('VITE_SUPABASE_URL is missing. Supabase client initialized with placeholder.');
}

export const supabase = createClient(validUrl, validKey);