# Shared test vectors

Two rules run twice, in Python on the server and in TypeScript on the device: replay, and reservation clashes. These
files are the contract between them (NFR-MAINT-04). Both suites load every file here and must produce the same answer.

## replay/

One file per case:

```json
{
  "name": "what this proves",
  "events": [ ... ],
  "state": { "<entity_type>": { "<entity_id>": { ...fields } } }
}
```

or, for a case that must fail:

```json
{
  "name": "...",
  "events": [ ... ],
  "error": "unknown_event_type"
}
```

An optional `base` is the state to replay onto, as a device does after a bootstrap.

Events carry only what replay reads: `id`, `entity_type`, `entity_id`, `type`, `actor_id`, `device_id`, `device_seq`,
`effective_at`, `payload`. Events are listed in arrival order, which is deliberately not replay order. Timestamps are
integer milliseconds.

Changing a replay rule means changing a vector. The other side then fails until it catches up, which is the point.

## reservations/

Reservation clashes (FR-RES-05, FR-RES-15, FR-MCP-06). One file per case:

```json
{
  "name": "what this proves",
  "state": { "item": { ... }, "reservation": { ... } },
  "draft": { "event": "...", "starts": "...", "ends": "...", "items": [], "generics": [] },
  "exclude": "<the reservation being edited, when there is one>",
  "conflicts": [{ "id": "...", "event": "...", "detail": "..." }]
}
```

`state` is derived state, the shape replay produces. `conflicts` is in the order the rule finds them: shared items
first, by the other reservation's start date, then generics over stock.

Changing the clash rule means changing a vector. The other side then fails until it catches up, which is the point.
