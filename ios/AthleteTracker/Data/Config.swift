import Foundation

/// Same Supabase project and public (publishable) key as the web app's config.js.
/// The key is meant to be public: row-level security in the database keeps each
/// person's data private, exactly as it does for the website.
nonisolated enum Config {
    static let supabaseURL = URL(string: "https://zaftplbijgkhnbmwegwt.supabase.co")!
    static let supabaseKey = "sb_publishable_x90nGm6xj8KZBHwOqepLtw_KQ3Ftdx4"
}
