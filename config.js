// Connection settings for the shared database (Supabase).
// The anon key is meant to be public: the database's row-level security
// (see supabase/schema.sql) is what keeps the data private to allowed emails.
// Leave these blank to run in demo mode (saves only on this device).
window.TRAINING_CONFIG = {
  supabaseUrl: "https://zaftplbijgkhnbmwegwt.supabase.co",
  supabaseAnonKey: "sb_publishable_x90nGm6xj8KZBHwOqepLtw_KQ3Ftdx4",
  // Who gets notified, shown in the Finish session prompt.
  adminName: "John",
  // Names now come from the members table (trainer console → Athletes). Don't put people's
  // emails here: this file is public. Only needed for an old database without 004:
  // { "their@email.com": "Name" }
  people: {},
};
