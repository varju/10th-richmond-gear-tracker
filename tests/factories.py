"""Build events for tests without spelling every field out each time."""

from __future__ import annotations

from typing import Any

from gear_tracker.ulid import new_ulid

T0 = 1_756_684_800_000  # 2025-09-01T00:00:00Z


def incoming(**overrides: Any) -> dict[str, Any]:
    e: dict[str, Any] = {
        "id": new_ulid(),
        "entity_type": "item",
        "entity_id": "tent-1",
        "type": "field_changed",
        "actor_id": "alice",
        "device_id": "phone-a",
        "device_seq": 1,
        "occurred_at": T0,
        "clock_offset": 0,
        "payload": {"field": "name", "value": "Tent"},
    }
    e.update(overrides)
    return e
