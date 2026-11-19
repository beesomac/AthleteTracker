import Foundation
import Supabase

/// One shared client for the whole app. The signed-in session is kept in the
/// Keychain by supabase-swift, so you stay signed in between launches.
let supabase = SupabaseClient(
    supabaseURL: Config.supabaseURL,
    supabaseKey: Config.supabaseKey,
    options: SupabaseClientOptions(
        auth: .init(emitLocalSessionAsInitialSession: true)
    )
)
