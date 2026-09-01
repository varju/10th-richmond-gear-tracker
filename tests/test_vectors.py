"""Run the shared replay vectors. The TypeScript suite runs the same files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gear_tracker.events import Event
from gear_tracker.replay import UnknownEventType, replay

VECTORS = sorted((Path(__file__).resolve().parents[1] / "vectors" / "replay").glob("*.json"))

ERRORS = {"unknown_event_type": UnknownEventType}


def load(entry: dict, seq: int) -> Event:
    """Vectors carry only what replay reads; fill the rest with something harmless."""
    return Event(
        id=entry["id"],
        entity_type=entry["entity_type"],
        entity_id=entry["entity_id"],
        type=entry["type"],
        actor_id=entry["actor_id"],
        device_id=entry["device_id"],
        device_seq=entry["device_seq"],
        occurred_at=entry["effective_at"],
        clock_offset=0,
        effective_at=entry["effective_at"],
        received_at=entry["effective_at"],
        seq=seq,
        payload=entry["payload"],
    )


def test_there_are_vectors():
    assert VECTORS


@pytest.mark.parametrize("path", VECTORS, ids=lambda p: p.stem)
def test_vector(path: Path):
    vector = json.loads(path.read_text())
    events = [load(e, n) for n, e in enumerate(vector["events"], start=1)]

    if "error" in vector:
        with pytest.raises(ERRORS[vector["error"]]):
            replay(events)
    else:
        assert replay(events, vector.get("base")) == vector["state"], vector["name"]
