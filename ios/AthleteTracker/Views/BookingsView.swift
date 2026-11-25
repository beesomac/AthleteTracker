import SwiftUI

/// Rehab gym sessions for the next four weeks, by day.
/// Athletes: spots left, Book / Cancel. Trainers and coaches: who's booked, in their colour;
/// tap a session to book people in, add walk-ins and mark who came.
struct BookingsView: View {
    @Environment(AppModel.self) private var model
    @State private var kind = ""            // "" all, "rehab", "open_gym"
    @State private var busy: String?        // slot id being booked/cancelled
    @State private var problem: String?
    @State private var cancelling: GymSlot?

    private var shown: [GymSlot] { model.slots.filter { kind.isEmpty || $0.kind == kind } }
    private var days: [String] { Array(Set(shown.map(\.day))).sorted() }
    private var mine: [GymSlot] { model.slots.filter { $0.isMine && !$0.cancelled && $0.endsAt > .now } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Type", selection: $kind) {
                        Text("All").tag("")
                        Text("Rehab").tag("rehab")
                        Text("Open gym").tag("open_gym")
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                if !model.isStaff && !mine.isEmpty {
                    Section("Your bookings") {
                        ForEach(mine) { slot in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(slot.name).font(.headline)
                                    Text(SessionDate.label(slot.day) + " · " + slot.timeRange)
                                        .font(.subheadline).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                            }
                        }
                    }
                }
                ForEach(days, id: \.self) { day in
                    Section(dayTitle(day)) {
                        ForEach(shown.filter { $0.day == day }) { slot in
                            if model.isStaff {
                                NavigationLink(value: slot) { StaffSlotRow(slot: slot) }
                            } else {
                                athleteRow(slot)
                            }
                        }
                    }
                }
            }
            .overlay { emptyState }
            .navigationTitle("Bookings")
            .navigationDestination(for: GymSlot.self) { SlotDetailView(slotId: $0.id) }
            .refreshable { await model.loadBookings() }
            .task { await model.loadBookings() }
            .toolbar { AccountMenu() }
            .alert("Couldn't book", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(problem ?? "") }
            .confirmationDialog("Cancel this booking?", isPresented: Binding(get: { cancelling != nil }, set: { if !$0 { cancelling = nil } }),
                                titleVisibility: .visible, presenting: cancelling) { slot in
                Button("Cancel booking", role: .destructive) { act(slot) { try await model.cancelMine(slot) } }
                Button("Keep it", role: .cancel) {}
            } message: { slot in
                Text(slot.name + ", " + SessionDate.label(slot.day) + " " + slot.timeRange)
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if !model.bookingsReady {
            ContentUnavailableView("Bookings aren't set up yet", systemImage: "calendar.badge.clock",
                                   description: Text("Your trainer needs to run supabase/015_bookings.sql."))
        } else if shown.isEmpty && !model.isLoading {
            ContentUnavailableView("No sessions yet", systemImage: "calendar.badge.clock",
                                   description: Text("Rehab and open gym sessions for the next four weeks show up here."))
        }
    }

    private func dayTitle(_ day: String) -> String {
        day == SessionDate.today ? "Today · " + SessionDate.label(day) : SessionDate.label(day)
    }

    private func athleteRow(_ slot: GymSlot) -> some View {
        HStack(spacing: 12) {
            SlotSummary(slot: slot)
            Spacer()
            if busy == slot.id {
                ProgressView()
            } else if slot.isMine {
                Button { cancelling = slot } label: {
                    Label("Booked", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.bordered)
                .tint(.green)
                .disabled(slot.hasStarted)
                .accessibilityHint("Cancels your booking")
            } else if slot.cancelled || slot.hasStarted || slot.isFull {
                EmptyView()
            } else {
                Button("Book") { act(slot) { try await model.book(slot) } }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private func act(_ slot: GymSlot, _ work: @escaping @MainActor () async throws -> Void) {
        busy = slot.id
        Task {
            do { try await work() } catch { problem = error.localizedDescription }
            busy = nil
        }
    }
}

/// Time, name, spots left and who's supervising: the left side of every row.
struct SlotSummary: View {
    let slot: GymSlot

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 2).fill(slot.cancelled ? Color.secondary : slot.kindColor).frame(width: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text(slot.timeRange).font(.subheadline.monospacedDigit().weight(.semibold))
                Text(slot.name).font(.headline).strikethrough(slot.cancelled)
                HStack(spacing: 6) {
                    Text(slot.spotsText).foregroundStyle(slot.isFull && !slot.cancelled ? Color.red : Color.secondary)
                    if let coach = slot.coachName { Text("· \(coach)").foregroundStyle(.secondary) }
                }
                .font(.footnote)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// Staff row: the summary plus a coloured dot per booked person.
struct StaffSlotRow: View {
    @Environment(AppModel.self) private var model
    let slot: GymSlot

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SlotSummary(slot: slot)
            let live = model.bookings(for: slot).filter(\.isLive)
            if !live.isEmpty {
                PeopleDots(bookings: live)
            }
        }
    }
}

struct PeopleDots: View {
    @Environment(AppModel.self) private var model
    let bookings: [BookingRow]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(bookings) { b in
                    PersonChip(name: model.personName(b), color: model.colour(for: b.memberEmail)?.color,
                               guest: b.memberEmail == nil, came: b.status == "attended")
                }
            }
        }
    }
}

struct PersonChip: View {
    let name: String
    let color: Color?
    var guest = false
    var came = false

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(guest ? Color.clear : (color ?? Color.secondary))
                .overlay(Circle().strokeBorder(guest ? Color.secondary : Color.clear, lineWidth: 1))
                .frame(width: 8, height: 8)
            Text(name).font(.caption.weight(.medium)).lineLimit(1)
            if came { Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(.green) }
        }
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background((color ?? Color.secondary).opacity(guest ? 0 : 0.15), in: Capsule())
        .overlay { if guest { Capsule().strokeBorder(Color.secondary, style: StrokeStyle(lineWidth: 1, dash: [3])) } }
    }
}

/// One session for trainers and coaches: everyone booked, swipe to mark came / no-show / cancel,
/// and + to book someone in.
struct SlotDetailView: View {
    @Environment(AppModel.self) private var model
    let slotId: String
    @State private var adding = false
    @State private var problem: String?

    private var slot: GymSlot? { model.slots.first { $0.id == slotId } }

    var body: some View {
        Group {
            if let slot {
                List {
                    Section {
                        SlotSummary(slot: slot)
                        if let notes = slot.notes, !notes.isEmpty { Text(notes).font(.callout).foregroundStyle(.secondary) }
                    } header: { Text(SessionDate.label(slot.day) + " · " + slot.kindLabel) }
                    let rows = model.bookings(for: slot)
                    Section("Booked (\(rows.filter(\.isLive).count) of \(slot.capacity))") {
                        if rows.filter({ $0.status != "cancelled" }).isEmpty {
                            Text("Nobody yet. Tap + to book someone in.").foregroundStyle(.secondary)
                        }
                        ForEach(rows.filter { $0.status != "cancelled" }) { b in personRow(b) }
                    }
                    let cancelled = rows.filter { $0.status == "cancelled" }
                    if !cancelled.isEmpty {
                        Section("Cancelled") {
                            ForEach(cancelled) { b in personRow(b) }
                        }
                    }
                }
                .navigationTitle(slot.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if !slot.cancelled {
                        ToolbarItem(placement: .primaryAction) {
                            Button { adding = true } label: { Label("Book someone in", systemImage: "person.badge.plus") }
                        }
                    }
                }
                .sheet(isPresented: $adding) { BookPersonSheet(slot: slot) }
            } else {
                ContentUnavailableView("Session not found", systemImage: "calendar.badge.exclamationmark")
            }
        }
        .refreshable { await model.loadBookings() }
        .alert("Couldn't save", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(problem ?? "") }
    }

    private func personRow(_ b: BookingRow) -> some View {
        let c = model.colour(for: b.memberEmail)
        return HStack(spacing: 10) {
            Circle()
                .fill(b.memberEmail == nil ? Color.clear : (c?.color ?? Color.secondary))
                .overlay(Circle().strokeBorder(b.memberEmail == nil ? Color.secondary : Color.clear, lineWidth: 1))
                .frame(width: 12, height: 12)
            VStack(alignment: .leading, spacing: 1) {
                Text(model.personName(b)).font(.body.weight(.medium))
                Text([c?.name, b.memberEmail == nil ? "Walk-in guest" : (b.walkIn ? "Walk-in" : nil)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(b.statusLabel)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(statusColor(b.status).opacity(0.15), in: Capsule())
                .foregroundStyle(statusColor(b.status))
        }
        .swipeActions(edge: .leading) {
            if b.status != "attended" {
                Button { set(b, "attended") } label: { Label("Came", systemImage: "checkmark") }.tint(.green)
            }
        }
        .swipeActions(edge: .trailing) {
            if b.status == "cancelled" {
                Button { set(b, "booked") } label: { Label("Re-book", systemImage: "arrow.uturn.backward") }.tint(.blue)
            } else {
                Button(role: .destructive) { set(b, "cancelled") } label: { Label("Cancel", systemImage: "xmark") }
                if b.status != "no_show" {
                    Button { set(b, "no_show") } label: { Label("No-show", systemImage: "person.fill.questionmark") }.tint(.orange)
                }
            }
        }
        .contextMenu {
            Button("Came") { set(b, "attended") }
            Button("No-show") { set(b, "no_show") }
            Button("Booked") { set(b, "booked") }
            Button("Cancel booking", role: .destructive) { set(b, "cancelled") }
        }
    }

    private func statusColor(_ s: String) -> Color {
        switch s {
        case "attended": .green
        case "no_show": .orange
        case "cancelled": .secondary
        default: .blue
        }
    }

    private func set(_ b: BookingRow, _ status: String) {
        Task {
            do { try await model.setStatus(b.id, status) } catch { problem = error.localizedDescription }
        }
    }
}

/// Staff: pick a member, or type a walk-in's name; "here now" marks them as came.
struct BookPersonSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let slot: GymSlot
    @State private var query = ""
    @State private var guest = ""
    @State private var hereNow: Bool
    @State private var saving = false
    @State private var problem: String?

    init(slot: GymSlot) {
        self.slot = slot
        _hereNow = State(initialValue: slot.day <= SessionDate.today)
    }

    private var taken: Set<String> {
        Set(model.bookings(for: slot).filter { $0.status != "cancelled" }.compactMap(\.memberEmail))
    }
    private var choices: [Member] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return model.people.filter { !taken.contains($0.email) && (q.isEmpty || $0.name.lowercased().contains(q) || ($0.groups ?? []).joined(separator: " ").lowercased().contains(q)) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle("They're here now (mark as came)", isOn: $hereNow)
                    if slot.isFull {
                        Label("Full: this goes over the limit of \(slot.capacity)", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange).font(.callout)
                    }
                }
                Section("Walk-in who isn't a member") {
                    HStack {
                        TextField("Their name", text: $guest).textInputAutocapitalization(.words)
                        Button("Add") { save(member: nil, guest: guest.trimmingCharacters(in: .whitespaces)) }
                            .disabled(guest.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                    }
                }
                Section("Members") {
                    ForEach(choices) { m in
                        Button { save(member: m.email, guest: nil) } label: {
                            HStack(spacing: 10) {
                                Circle().fill(model.colour(for: m.email)?.color ?? Color.secondary).frame(width: 10, height: 10)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(m.name).foregroundStyle(.primary)
                                    if let g = model.colour(for: m.email)?.name ?? m.groups?.first {
                                        Text(g).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                        .disabled(saving)
                    }
                }
            }
            .searchable(text: $query, prompt: "Find a member")
            .navigationTitle("Book someone in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .alert("Couldn't book", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(problem ?? "") }
        }
    }

    private func save(member: String?, guest: String?) {
        saving = true
        Task {
            do {
                try await model.book(slot, memberEmail: member, guestName: guest, hereNow: hereNow)
                dismiss()
            } catch {
                problem = error.localizedDescription
            }
            saving = false
        }
    }
}
