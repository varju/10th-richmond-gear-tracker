"""Drawing and recording printed codes, against the real database."""

from __future__ import annotations

import pytest

from gear_tracker import codes, events
from gear_tracker.errors import BadRequest
from tests.factories import T0, incoming


def test_codes_are_ten_crockford_characters():
    for _ in range(100):
        code = codes.new_code()
        assert codes.is_code(code)
        assert set(code) <= set(codes.CODE_ALPHABET)


def test_a_thousand_draws_are_distinct():
    assert len({codes.new_code() for _ in range(1000)}) == 1000


@pytest.mark.parametrize("bad", ["", "ABCDEFGH2", "ABCDEFGH234", "ABCDEFGH2I", "abcdefgh23", "ABCDEFGH2O"])
def test_is_code_refuses_the_wrong_shape(bad):
    assert not codes.is_code(bad)


def test_create_codes_records_each_as_printed(db):
    made = codes.create_codes(db, "alice", 3, now=T0)
    assert len(made) == 3
    for code in made:
        resolved = codes.resolve(db, code)
        assert resolved is not None
        assert "item_id" not in resolved
    rows = db.execute("SELECT entity_id, type, actor_id, device_id FROM events ORDER BY seq").fetchall()
    assert [r["entity_id"] for r in rows] == made
    assert {(r["type"], r["actor_id"], r["device_id"]) for r in rows} == {("created", "alice", "server")}


def test_a_collision_is_drawn_again(db, monkeypatch):
    [existing] = codes.create_codes(db, "alice", 1, now=T0)
    draws = iter([existing, "ABCDEFGH23"])
    monkeypatch.setattr(codes, "new_code", lambda: next(draws))

    assert codes.create_codes(db, "alice", 1, now=T0) == ["ABCDEFGH23"]
    assert db.execute("SELECT count(*) FROM events WHERE entity_id = ?", (existing,)).fetchone()[0] == 1


@pytest.mark.parametrize("count", [0, -1, codes.MAX_CODES + 1])
def test_count_is_bounded(db, count):
    with pytest.raises(BadRequest):
        codes.create_codes(db, "alice", count)


def test_resolve_before_and_after_binding(db):
    assert codes.resolve(db, "ABCDEFGH23") is None
    [code] = codes.create_codes(db, "alice", 1, now=T0)
    resolved = codes.resolve(db, code)
    assert resolved is not None
    assert "item_id" not in resolved

    events.append(
        db,
        incoming(entity_type="code", entity_id=code, type="code_bound", payload={"item_id": "tent-1"}),
        received_at=T0 + 1,
    )
    bound = codes.resolve(db, code)
    assert bound is not None
    assert bound["item_id"] == "tent-1"
