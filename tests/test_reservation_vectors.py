"""Run the shared reservation-clash vectors. The TypeScript suite runs the same files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gear_tracker.conflicts import conflicts

VECTORS = sorted((Path(__file__).resolve().parents[1] / "vectors" / "reservations").glob("*.json"))


def test_there_are_vectors():
    assert VECTORS


@pytest.mark.parametrize("path", VECTORS, ids=lambda p: p.stem)
def test_vector(path: Path):
    vector = json.loads(path.read_text())
    found = conflicts(vector["state"], vector["draft"], vector.get("exclude"))
    assert found == vector["conflicts"], vector["name"]
