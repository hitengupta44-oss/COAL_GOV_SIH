// Direct Supabase client for read-heavy dashboard queries.
// Use the ANON key here (never the service_role key in frontend code) --
// lock down access with the Row Level Security policies in supabase/schema.sql.

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
