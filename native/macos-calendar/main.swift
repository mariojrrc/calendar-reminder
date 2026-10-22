import EventKit
import Foundation

/// Tiny EventKit CLI for Calendar Reminder.
/// Commands: auth | status | events --start <ISO8601> --end <ISO8601>

enum Output {
  static func json(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
      FileHandle.standardError.write(Data("{\"ok\":false,\"error\":\"json encode failed\"}\n".utf8))
      exit(1)
    }
    print(text)
  }

  static func fail(_ message: String, code: Int32 = 1) -> Never {
    json(["ok": false, "error": message])
    exit(code)
  }
}

func parseISO8601(_ value: String) -> Date? {
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = fractional.date(from: value) { return date }

  let plain = ISO8601DateFormatter()
  plain.formatOptions = [.withInternetDateTime]
  return plain.date(from: value)
}

func isoString(from date: Date) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: date)
}

func authorizationLabel(_ status: EKAuthorizationStatus) -> String {
  switch status {
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  case .denied: return "denied"
  case .fullAccess: return "fullAccess"
  case .writeOnly: return "writeOnly"
  case .authorized: return "authorized"
  @unknown default: return "unknown"
  }
}

func hasReadAccess(_ status: EKAuthorizationStatus) -> Bool {
  if #available(macOS 14.0, *) {
    return status == .fullAccess
  }
  // Pre-macOS 14 "authorized" means read/write calendar access.
  return status == EKAuthorizationStatus(rawValue: 3) // .authorized
}

func requestAccess(store: EKEventStore) async throws -> Bool {
  if #available(macOS 14.0, *) {
    return try await store.requestFullAccessToEvents()
  }

  return try await withCheckedThrowingContinuation { continuation in
    store.requestAccess(to: .event) { granted, error in
      if let error {
        continuation.resume(throwing: error)
        return
      }
      continuation.resume(returning: granted)
    }
  }
}

func runAuth() async {
  let store = EKEventStore()
  do {
    let granted = try await requestAccess(store: store)
    if granted {
      Output.json(["ok": true, "status": authorizationLabel(EKEventStore.authorizationStatus(for: .event))])
      exit(0)
    }
    Output.fail("Calendar access was not granted. Enable Calendar Reminder under System Settings → Privacy & Security → Calendars.")
  } catch {
    Output.fail(error.localizedDescription)
  }
}

func runStatus() {
  let status = EKEventStore.authorizationStatus(for: .event)
  Output.json([
    "ok": true,
    "status": authorizationLabel(status),
    "readable": hasReadAccess(status),
  ])
}

func runEvents(startRaw: String, endRaw: String) {
  guard let start = parseISO8601(startRaw), let end = parseISO8601(endRaw) else {
    Output.fail("Invalid --start/--end ISO-8601 timestamps")
  }
  if end < start {
    Output.fail("--end must be after --start")
  }

  let status = EKEventStore.authorizationStatus(for: .event)
  guard hasReadAccess(status) else {
    Output.fail("Calendar access is \(authorizationLabel(status)). Run auth first.")
  }

  let store = EKEventStore()
  let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
  let events = store.events(matching: predicate)

  let payload: [[String: Any]] = events.compactMap { event in
    // All-day events have no useful "starts in N minutes" clock time.
    if event.isAllDay { return nil }
    guard let eventId = event.eventIdentifier else { return nil }
    return [
      "id": eventId,
      "title": event.title ?? "(no title)",
      "start": isoString(from: event.startDate),
    ]
  }

  Output.json(["ok": true, "events": payload])
}

func usage() -> Never {
  FileHandle.standardError.write(Data("""
  usage:
    macos-calendar-helper auth
    macos-calendar-helper status
    macos-calendar-helper events --start <ISO8601> --end <ISO8601>
  """.utf8))
  exit(2)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { usage() }

switch command {
case "auth":
  let semaphore = DispatchSemaphore(value: 0)
  Task {
    await runAuth()
    semaphore.signal()
  }
  semaphore.wait()

case "status":
  runStatus()

case "events":
  var start: String?
  var end: String?
  var i = 1
  while i < args.count {
    let flag = args[i]
    if flag == "--start", i + 1 < args.count {
      start = args[i + 1]
      i += 2
      continue
    }
    if flag == "--end", i + 1 < args.count {
      end = args[i + 1]
      i += 2
      continue
    }
    Output.fail("Unknown argument: \(flag)")
  }
  guard let start, let end else {
    Output.fail("events requires --start and --end")
  }
  runEvents(startRaw: start, endRaw: end)

default:
  usage()
}
