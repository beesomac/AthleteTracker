import Foundation
import Observation
import Supabase

// Profile and membership: supabase/015_profile_billing.sql and the "billing" edge function.
// Paying happens on Stripe's own web page (Checkout and the customer portal), opened in Safari
// inside the app. That's allowed outside Apple's in-app purchase because the membership is for a
// gym service used in person (App Review Guideline 3.1.3(e)).

/// `my_profile()`: the signed-in person's details and current membership.
nonisolated struct Profile: Decodable, Sendable {
    let email: String
    let displayName: String?
    let role: String?
    let phone: String?
    let emergencyName: String?
    let emergencyPhone: String?
    let hasBilling: Bool?
    let subscription: Membership?

    enum CodingKeys: String, CodingKey {
        case email, role, phone, subscription
        case displayName = "display_name"
        case emergencyName = "emergency_name"
        case emergencyPhone = "emergency_phone"
        case hasBilling = "has_billing"
    }
}

nonisolated struct Membership: Decodable, Sendable {
    let status: String
    let currentPeriodEnd: String?
    let cancelAtPeriodEnd: Bool?
    let planName: String?
    let amountCents: Int?
    let currency: String?
    let billingInterval: String?
    let intervalCount: Int?

    enum CodingKeys: String, CodingKey {
        case status, currency
        case currentPeriodEnd = "current_period_end"
        case cancelAtPeriodEnd = "cancel_at_period_end"
        case planName = "plan_name"
        case amountCents = "amount_cents"
        case billingInterval = "billing_interval"
        case intervalCount = "interval_count"
    }

    /// Stripe statuses that still count as a membership (Manage billing, not Choose a plan).
    var isLive: Bool { ["active", "trialing", "past_due", "unpaid", "paused"].contains(status) }
    var needsCard: Bool { status == "past_due" || status == "unpaid" }
    var statusLabel: String { Billing.statusLabel(status) }
    var priceText: String? {
        guard let amountCents else { return nil }
        return Billing.price(amountCents, currency ?? "aud", billingInterval ?? "week", intervalCount ?? 1)
    }
    /// "Renews Tue 2 Dec" or "Ends Tue 2 Dec".
    var periodText: String? {
        guard let s = currentPeriodEnd, let d = SessionDate.timestamp(s) else { return nil }
        let day = d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
        return (cancelAtPeriodEnd == true ? "Ends " : "Renews ") + day
    }
}

/// A row in `plans` (members see the active ones).
nonisolated struct PlanRow: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String?
    let amountCents: Int
    let currency: String
    let billingInterval: String
    let intervalCount: Int
    let stripePriceId: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description, currency
        case amountCents = "amount_cents"
        case billingInterval = "billing_interval"
        case intervalCount = "interval_count"
        case stripePriceId = "stripe_price_id"
    }

    var priceText: String { Billing.price(amountCents, currency, billingInterval, intervalCount) }
}

nonisolated enum Billing {
    static func money(_ cents: Int, _ currency: String) -> String {
        let amount = Decimal(cents) / 100
        let style = Decimal.FormatStyle.Currency(code: currency.uppercased(), locale: Locale(identifier: "en_AU"))
        return cents % 100 == 0 ? amount.formatted(style.precision(.fractionLength(0))) : amount.formatted(style)
    }

    /// "$45 a week", "$160 every 4 weeks".
    static func price(_ cents: Int, _ currency: String, _ interval: String, _ count: Int) -> String {
        let every = count == 1 ? "a \(interval)" : "every \(count) \(interval)s"
        return "\(money(cents, currency)) \(every)"
    }

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "active": "Active"
        case "trialing": "Trial"
        case "past_due": "Payment overdue"
        case "unpaid": "Unpaid"
        case "paused": "Paused"
        case "incomplete", "incomplete_expired": "Payment not finished"
        case "canceled": "Cancelled"
        default: status.capitalized
        }
    }
}

/// What the Profile tab shows, loaded fresh each time the tab opens.
@Observable
final class ProfileModel {
    var profile: Profile?
    var plans: [PlanRow] = []
    var testMode = false
    var isLoading = false
    var error: String?
    var needsMigration = false

    nonisolated private struct Request: Encodable, Sendable {
        let action: String
        var planId: String? = nil
        var app = true
        enum CodingKeys: String, CodingKey {
            case action, app
            case planId = "plan_id"
        }
    }
    nonisolated private struct URLReply: Decodable, Sendable { let url: String }
    nonisolated private struct StatusReply: Decodable, Sendable {
        let testMode: Bool?
        enum CodingKeys: String, CodingKey { case testMode = "test_mode" }
    }
    nonisolated private struct Empty: Decodable, Sendable {}
    nonisolated private struct ErrorReply: Decodable, Sendable { let error: String? }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            profile = try await supabase.rpc("my_profile").execute().value
            plans = try await supabase.from("plans")
                .select("id, name, description, amount_cents, currency, billing_interval, interval_count, stripe_price_id")
                .eq("active", value: true)
                .order("sort")
                .order("amount_cents")
                .execute().value
            needsMigration = false
            error = nil
        } catch {
            let text = String(describing: error)
            needsMigration = text.contains("my_profile") || text.contains("PGRST202")
            self.error = needsMigration ? nil : error.localizedDescription
        }
        if let s: StatusReply = try? await call(Request(action: "status")) { testMode = s.testMode ?? false }
    }

    func save(name: String, phone: String, emergencyName: String, emergencyPhone: String) async throws {
        try await supabase.rpc("update_my_profile", params: [
            "p_display_name": name,
            "p_phone": phone,
            "p_emergency_name": emergencyName,
            "p_emergency_phone": emergencyPhone,
        ]).execute()
        await load()
    }

    /// Stripe Checkout for a plan.
    func checkoutURL(_ plan: PlanRow) async throws -> URL {
        try await url(Request(action: "checkout", planId: plan.id))
    }

    /// Stripe customer portal: change plan, card, invoices, cancel.
    func portalURL() async throws -> URL {
        try await url(Request(action: "portal"))
    }

    /// After the Stripe page closes: read the result from Stripe rather than wait for the webhook.
    func refreshFromStripe() async {
        let _: Empty? = try? await call(Request(action: "sync"))
        await load()
    }

    private func url(_ request: Request) async throws -> URL {
        let reply: URLReply = try await call(request)
        guard let u = URL(string: reply.url) else { throw BillingError(message: "Stripe sent back an address that doesn't open") }
        return u
    }

    private func call<T: Decodable & Sendable>(_ request: Request) async throws -> T {
        do {
            return try await supabase.functions.invoke("billing", options: FunctionInvokeOptions(body: request))
        } catch let FunctionsError.httpError(_, data) {
            let message = (try? JSONDecoder().decode(ErrorReply.self, from: data))?.error
            throw BillingError(message: message ?? "Billing isn't switched on yet")
        }
    }
}

nonisolated struct BillingError: LocalizedError, Sendable {
    let message: String
    var errorDescription: String? { message }
}
