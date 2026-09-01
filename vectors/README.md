# Shared test vectors

Replay runs twice: in Python on the server and in TypeScript on the device. These files are the contract between them
(NFR-MAINT-04). Both suites load every file here and must produce the same answer.

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
