// Connection settings for the shared database (Supabase).
// The anon key is meant to be public: the database's row-level security
// (see supabase/schema.sql) is what keeps the data private to allowed emails.
// Leave these blank to run in demo mode (saves only on this device).
window.TRAINING_CONFIG = {
  supabaseUrl: "https://zaftplbijgkhnbmwegwt.supabase.co",
  supabaseAnonKey: "sb_publishable_x90nGm6xj8KZBHwOqepLtw_KQ3Ftdx4",
  // Friendly names shown next to ticks and notes, keyed by login email.
  people: {
    // "someone@example.com": "John",
  },
};
