import SafariServices
import SwiftUI

/// Profile tab: your details, your membership, and paying for a plan with Stripe.
struct ProfileView: View {
    @Environment(AppModel.self) private var model
    @State private var profile = ProfileModel()
    @State private var page: WebPage?
    @State private var busy: String?
    @State private var message: String?

    @State private var name = ""
    @State private var phone = ""
    @State private var emergencyName = ""
    @State private var emergencyPhone = ""
    @State private var saving = false

    struct WebPage: Identifiable {
        let url: URL
        var id: String { url.absoluteString }
    }

    var body: some View {
        NavigationStack {
            Form {
                if profile.needsMigration {
                    Section {
                        Text("Profiles need one database step first: run supabase/015_profile_billing.sql in Supabase.")
                            .foregroundStyle(.secondary)
                    }
                } else if let p = profile.profile {
                    membership(p)
                    details(p)
                } else if let error = profile.error {
                    Section { Text(error).foregroundStyle(.secondary) }
                } else {
                    Section { ProgressView() }
                }
                if let message {
                    Section { Text(message).foregroundStyle(.secondary) }
                }
                Section {
                    Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                }
            }
            .navigationTitle("Profile")
            .refreshable { await profile.refreshFromStripe() }
            .task { await profile.load(); fillFields() }
            .sheet(item: $page, onDismiss: {
                Task { await profile.refreshFromStripe() }
            }) { page in
                SafariView(url: page.url).ignoresSafeArea()
            }
        }
    }

    // MARK: Membership

    @ViewBuilder private func membership(_ p: Profile) -> some View {
        if let s = p.subscription, s.isLive {
            Section {
                LabeledContent(s.planName ?? "Membership") {
                    Text(s.statusLabel).foregroundStyle(s.needsCard ? Color.orange : Color.green)
                }
                if let price = s.priceText { LabeledContent("Price", value: price) }
                if let when = s.periodText { Text(when).foregroundStyle(.secondary) }
                if s.needsCard {
                    Text("Your last payment didn't go through. Update your card in Manage billing.")
                        .foregroundStyle(.orange)
                }
                Button(busy == "portal" ? "Opening…" : "Manage billing") { open(nil) }
                    .disabled(busy != nil)
            } header: {
                Text("Membership")
            } footer: {
                Text("Change plan, update your card, see invoices or cancel. Billing is handled by Stripe.\(testNote)")
            }
        } else {
            Section {
                let plans = profile.plans.filter { $0.stripePriceId != nil }
                if plans.isEmpty {
                    Text("There are no plans to choose from yet. Ask your trainer.").foregroundStyle(.secondary)
                }
                ForEach(plans) { plan in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(plan.name).font(.headline)
                            Text(plan.priceText).foregroundStyle(.secondary)
                            if let d = plan.description, !d.isEmpty {
                                Text(d).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Button(busy == plan.id ? "Opening…" : "Choose") { open(plan) }
                            .buttonStyle(.borderedProminent)
                            .disabled(busy != nil)
                    }
                }
                if p.hasBilling == true {
                    Button("Past invoices") { open(nil) }.disabled(busy != nil)
                }
            } header: {
                Text("Choose a plan")
            } footer: {
                Text("You pay on Stripe's secure page. Card details go to Stripe and are never stored in the app.\(testNote)")
            }
        }
    }

    private var testNote: String {
        profile.testMode ? "\n\nTest mode: no real money moves. Use card 4242 4242 4242 4242, any future date and any 3 numbers." : ""
    }

    /// Opens Stripe Checkout for a plan, or the customer portal when plan is nil.
    private func open(_ plan: PlanRow?) {
        busy = plan?.id ?? "portal"
        message = nil
        Task {
            defer { busy = nil }
            do {
                let url = if let plan { try await profile.checkoutURL(plan) } else { try await profile.portalURL() }
                page = WebPage(url: url)
            } catch {
                message = error.localizedDescription
            }
        }
    }

    // MARK: Details

    @ViewBuilder private func details(_ p: Profile) -> some View {
        Section("Your details") {
            TextField("Name", text: $name).textContentType(.name)
            LabeledContent("Email", value: p.email)
            TextField("Phone", text: $phone).textContentType(.telephoneNumber).keyboardType(.phonePad)
        }
        Section("Emergency contact") {
            TextField("Name", text: $emergencyName)
            TextField("Phone", text: $emergencyPhone).keyboardType(.phonePad)
            Button(saving ? "Saving…" : "Save details") {
                saving = true
                Task {
                    defer { saving = false }
                    do {
                        try await profile.save(name: name, phone: phone, emergencyName: emergencyName, emergencyPhone: emergencyPhone)
                        fillFields()
                        message = "Saved."
                    } catch {
                        message = "That didn't save: \(error.localizedDescription)"
                    }
                }
            }
            .disabled(saving || !changed(p))
        }
    }

    private func changed(_ p: Profile) -> Bool {
        name != (p.displayName ?? "") || phone != (p.phone ?? "")
            || emergencyName != (p.emergencyName ?? "") || emergencyPhone != (p.emergencyPhone ?? "")
    }

    private func fillFields() {
        guard let p = profile.profile else { return }
        name = p.displayName ?? ""
        phone = p.phone ?? ""
        emergencyName = p.emergencyName ?? ""
        emergencyPhone = p.emergencyPhone ?? ""
    }
}

/// Stripe's pages in Safari inside the app (keeps Apple Pay and saved cards working).
struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
