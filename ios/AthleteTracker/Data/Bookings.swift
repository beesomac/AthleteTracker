import Foundation
import SwiftUI
import Supabase

// Rehab gym bookings (supabase/015_bookings.sql).
// Athletes see sessions with spots left and book or cancel themselves; the database refuses a
// booking when the session is full, cancelled or has started. Trainers and coaches also see who's
// booked (in their group colour), book anyone in, add walk-ins and mark who came.

/// A row from `gym_slot_list()`: one bookable session.
nonisolated struct GymSlot: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let startsAt: Date
    let endsAt: Date
    let kind: String              // "rehab" | "open_gym"
    let title: String?
    let capacity: Int
    let coachName: String?
    let notes: String?
    let cancelled: Bool
    let booked: Int
    let myBookingId: String?
    let myStatus: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, title, capacity, notes, cancelled, booked
        case startsAt = "starts_at", endsAt = "ends_at", coachName = "coach_name"
        case myBookingId = "my_booking_id", myStatus = "my_status"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id).lowercased()
        startsAt = BookingTime.parse(try c.decode(String.self, forKey: .startsAt)) ?? .distantPast
        endsAt = BookingTime.parse(try c.decode(String.self, forKey: .endsAt)) ?? .distantPast
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "rehab"
        title = try c.decodeIfPresent(String.self, forKey: .title)
        capacity = (try? c.decode(Int.self, forKey: .capacity)) ?? 0
        coachName = try c.decodeIfPresent(String.self, forKey: .coachName)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        cancelled = (try? c.decode(Bool.self, forKey: .cancelled)) ?? false
        booked = (try? c.decode(Int.self, forKey: .booked)) ?? 0
        myBookingId = (try c.decodeIfPresent(String.self, forKey: .myBookingId))?.lowercased()
        myStatus = try c.decodeIfPresent(String.self, forKey: .myStatus)
    }

    var kindLabel: String { kind == "open_gym" ? "Open gym" : "Rehab supervised" }
    var name: String { title ?? kindLabel }
    var spotsLeft: Int { max(0, capacity - booked) }
    var isFull: Bool { booked >= capacity }
    var hasStarted: Bool { startsAt <= .now }
    var isMine: Bool { myBookingId != nil }
    var day: String { SessionDate.string(startsAt) }
    var timeRange: String {
        startsAt.formatted(date: .omitted, time: .shortened) + "–" + endsAt.formatted(date: .omitted, time: .shortened)
    }
    var spotsText: String {
        if cancelled { return "Cancelled" }
        if isFull { return "Full (\(booked)/\(capacity))" }
        return "\(spotsLeft) of \(capacity) spot\(capacity == 1 ? "" : "s") left"
    }
    var kindColor: Color { kind == "open_gym" ? .green : .blue }

    static func == (a: GymSlot, b: GymSlot) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

/// A row in `bookings` (staff can read them all).
nonisolated struct BookingRow: Decodable, Sendable, Identifiable {
    let id: String
    let slotId: String
    let memberEmail: String?
    let guestName: String?
    let walkIn: Bool
    let status: String            // booked | attended | no_show | cancelled
    let bookedByEmail: String?

    enum CodingKeys: String, CodingKey {
        case id, status
        case slotId = "slot_id", memberEmail = "member_email", guestName = "guest_name"
        case walkIn = "walk_in", bookedByEmail = "booked_by_email"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id).lowercased()
        slotId = try c.decode(String.self, forKey: .slotId).lowercased()
        memberEmail = try c.decodeIfPresent(String.self, forKey: .memberEmail)
        guestName = try c.decodeIfPresent(String.self, forKey: .guestName)
        walkIn = (try? c.decode(Bool.self, forKey: .walkIn)) ?? false
        status = (try? c.decode(String.self, forKey: .status)) ?? "booked"
        bookedByEmail = try c.decodeIfPresent(String.self, forKey: .bookedByEmail)
    }

    var isLive: Bool { status == "booked" || status == "attended" }
    var statusLabel: String {
        switch status {
        case "attended": "Came"
        case "no_show": "No-show"
        case "cancelled": "Cancelled"
        default: "Booked"
        }
    }
}

/// A colour for a member group (`group_colours`).
nonisolated struct GroupColour: Decodable, Sendable {
    let name: String
    let colour: String            // "#RRGGBB"
}

nonisolated enum BookingTime {
    /// Supabase timestamps look like "2026-11-25T07:00:00+00:00", sometimes with fractions.
    static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
    static func string(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }
}

extension Color {
    /// "#RRGGBB" → Color; nil when it doesn't look like one.
    init?(hex: String) {
        let h = hex.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
        guard h.count == 6, let v = UInt32(h, radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

private nonisolated struct SlotRange: Encodable, Sendable {
    let p_from: String
    let p_to: String
}

private nonisolated struct NewBooking: Encodable, Sendable {
    let slot_id: String
    let member_email: String?
    let guest_name: String?
    let walk_in: Bool
    let status: String
    let booked_by_email: String?
}

private nonisolated struct StatusPayload: Encodable, Sendable {
    let status: String
}

nonisolated enum BookingError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let m): m }
    }
}

extension AppModel {

    // MARK: Loading

    /// Today and the next four weeks. Staff also get everyone's bookings and the member list.
    func loadBookings() async {
        let start = Calendar.current.startOfDay(for: .now)
        let end = Calendar.current.date(byAdding: .day, value: 28, to: start) ?? start
        do {
            let rows: [GymSlot] = try await supabase.rpc("gym_slot_list", params: SlotRange(
                p_from: BookingTime.string(start), p_to: BookingTime.string(end)
            )).execute().value
            slots = rows
            bookingsReady = true
        } catch {
            // Before 015 runs the function doesn't exist: the tab says so instead of an error.
            let text = "\(error)"
            if text.contains("gym_slot_list") || text.contains("PGRST202") { bookingsReady = false }
            slots = []
            return
        }
        let colourRows: [GroupColour] = (try? await supabase.from("group_colours").select("name, colour").order("sort").execute().value) ?? []
        groupColours = colourRows
        guard isStaff else { slotBookings = []; return }
        let ids = slots.map(\.id)
        if ids.isEmpty {
            slotBookings = []
        } else {
            let rows: [BookingRow] = (try? await supabase.from("bookings")
                .select("id, slot_id, member_email, guest_name, walk_in, status, booked_by_email")
                .in("slot_id", values: ids)
                .order("created_at")
                .execute().value) ?? []
            slotBookings = rows
        }
        let members: [Member] = (try? await supabase.from("members")
            .select()
            .eq("active", value: true)
            .order("display_name")
            .execute().value) ?? []
        people = members
    }

    // MARK: Lookups

    func bookings(for slot: GymSlot) -> [BookingRow] {
        slotBookings.filter { $0.slotId == slot.id }
    }

    func member(_ email: String?) -> Member? {
        guard let email else { return nil }
        return people.first { $0.email == email.lowercased() }
            ?? athletes.first { $0.email == email.lowercased() }
    }

    func personName(_ b: BookingRow) -> String {
        if let m = member(b.memberEmail) { return m.name }
        return b.guestName ?? b.memberEmail?.components(separatedBy: "@").first ?? "Guest"
    }

    /// The colour of the person's first group that has one.
    func colour(for email: String?) -> (name: String, color: Color)? {
        guard let m = member(email) else { return nil }
        for g in m.groups ?? [] {
            if let c = groupColours.first(where: { $0.name == g }), let color = Color(hex: c.colour) {
                return (g, color)
            }
        }
        return nil
    }

    // MARK: Booking

    /// Book yourself in (athletes) or anyone (staff: member or a walk-in's name).
    func book(_ slot: GymSlot, memberEmail: String? = nil, guestName: String? = nil, hereNow: Bool = false) async throws {
        let who = memberEmail ?? (guestName == nil ? email : nil)
        let row = NewBooking(slot_id: slot.id, member_email: who, guest_name: who == nil ? guestName : nil,
                             walk_in: isStaff && (who == nil || hereNow), status: isStaff && hereNow ? "attended" : "booked",
                             booked_by_email: email)
        do {
            // A cancelled booking for the same person comes back instead of a second row (staff).
            if isStaff, let who, let old = bookings(for: slot).first(where: { $0.memberEmail == who && $0.status == "cancelled" }) {
                try await supabase.from("bookings").update(StatusPayload(status: row.status)).eq("id", value: old.id).execute()
            } else {
                try await supabase.from("bookings").insert(row).execute()
            }
        } catch {
            await loadBookings()
            throw Self.bookingError(error)
        }
        await loadBookings()
    }

    /// Cancel your own booking.
    func cancelMine(_ slot: GymSlot) async throws {
        guard let id = slot.myBookingId else { return }
        try await setStatus(id, "cancelled")
    }

    /// Staff: booked / attended / no_show / cancelled. Athletes: their own, cancelled only.
    func setStatus(_ bookingId: String, _ status: String) async throws {
        do {
            try await supabase.from("bookings").update(StatusPayload(status: status)).eq("id", value: bookingId).execute()
        } catch {
            await loadBookings()
            throw Self.bookingError(error)
        }
        await loadBookings()
    }

    /// The database's own words ("That session is full.") rather than a wrapped error.
    static func bookingError(_ error: Error) -> Error {
        if let p = error as? PostgrestError { return BookingError.message(p.message) }
        return error
    }
}
