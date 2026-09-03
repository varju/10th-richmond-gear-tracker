"""CSV export and import of the inventory (FR-RPT-03, NFR-DATA-10, FR-SET-11)."""

from __future__ import annotations

import csv
import io

import pytest

from gear_tracker import derived, events, inventory_csv
from gear_tracker.errors import BadRequest

ACTOR = "alice"


def seeded(conn) -> dict:
    """A location, two categories, a generic with two units, a single in both categories with a
    code bound to it, one item checked out, one retired, one deleted, and one merged away."""
    events.append_server(conn, ACTOR, "location", "loc-1", "created", {"name": "Cold locker"})
    events.append_server(conn, ACTOR, "category", "cat-1", "created", {"name": "Tarps"})
    events.append_server(conn, ACTOR, "category", "cat-2", "created", {"name": "Tents"})
    events.append_server(
        conn, ACTOR, "item", "tarp", "created", {"name": "Tarp, 10x12", "generic": True, "category_ids": ["cat-1"]}
    )
    events.append_server(conn, ACTOR, "item", "tarp-1", "created", {"parent_id": "tarp", "number": "1"})
    events.append_server(
        conn, ACTOR, "item", "tarp-2", "created", {"parent_id": "tarp", "number": "2", "nickname": "torn corner"}
    )
    events.append_server(
        conn,
        ACTOR,
        "item",
        "trailer",
        "created",
        {
            "name": "Trailer",
            "description": "Blue box trailer.",
            "home_location_id": "loc-1",
            "sub_location": "bin 2",
            "category_ids": ["cat-2", "cat-1"],
            "purchase_date": "2021-03-06",
            "price": 240.0,
            "supplier": "Local outfitter",
        },
    )
    events.append_server(conn, ACTOR, "code", "AAAAAAAAAA", "created", {})
    events.append_server(conn, ACTOR, "code", "AAAAAAAAAA", "code_bound", {"item_id": "trailer"})
    events.append_server(conn, ACTOR, "user", "bob", "created", {"name": "Bob", "role": "user", "active": True})
    events.append_server(conn, ACTOR, "item", "stove", "created", {"name": "Stove"})
    events.append_server(conn, ACTOR, "item", "stove", "checked_out", {"holder_id": "bob"})
    events.append_server(conn, ACTOR, "item", "cot", "created", {"name": "Old cot", "retired": True})
    events.append_server(conn, ACTOR, "item", "gone", "created", {"name": "Gone tent", "deleted": True})
    events.append_server(conn, ACTOR, "item", "dup", "created", {"name": "Duplicate tent", "merged_into": "trailer"})
    return derived.snapshot(conn)


def rows_by_id(text: str) -> dict[str, dict]:
    reader = csv.DictReader(io.StringIO(text.removeprefix(inventory_csv.BOM)))
    return {row["id"]: row for row in reader}


def make_csv(header: list[str], rows: list[list[str]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue()


# --- export -----------------------------------------------------------------------------


def test_the_header_matches_the_column_list(db):
    state = seeded(db)
    text = inventory_csv.export(state)
    header = next(csv.reader(io.StringIO(text.removeprefix(inventory_csv.BOM))))
    assert header == inventory_csv.COLUMNS


def test_one_row_per_item_and_units_follow_their_generic(db):
    state = seeded(db)
    by_id = rows_by_id(inventory_csv.export(state))

    assert by_id["tarp"]["kind"] == "generic"
    assert by_id["tarp"]["name"] == "Tarp, 10x12"
    assert by_id["tarp"]["category"] == "Tarps"

    assert by_id["tarp-1"]["kind"] == "unit"
    assert by_id["tarp-1"]["name"] == ""
    assert by_id["tarp-1"]["generic"] == "Tarp, 10x12"
    assert by_id["tarp-1"]["number"] == "1"
    assert by_id["tarp-1"]["category"] == ""

    assert by_id["tarp-2"]["nickname"] == "torn corner"


def test_export_joins_several_category_names_with_a_semicolon(db):
    state = seeded(db)
    by_id = rows_by_id(inventory_csv.export(state))

    assert by_id["trailer"]["category"] == "Tents; Tarps"


def test_code_status_and_holder(db):
    state = seeded(db)
    by_id = rows_by_id(inventory_csv.export(state))

    assert by_id["trailer"]["code"] == "AAAAAAAAAA"
    assert by_id["trailer"]["status"] == "in"
    assert by_id["trailer"]["holder"] == ""

    assert by_id["stove"]["status"] == "out"
    assert by_id["stove"]["holder"] == "Bob"

    # A generic never moves, so it has no status.
    assert by_id["tarp"]["status"] == ""
    assert by_id["tarp"]["code"] == ""


def test_a_deleted_and_a_merged_item_are_both_absent(db):
    state = seeded(db)
    by_id = rows_by_id(inventory_csv.export(state))

    assert "gone" not in by_id
    assert "dup" not in by_id


def test_round_trip_has_nothing_to_do(db):
    state = seeded(db)
    text = inventory_csv.export(state)

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    assert plan.adds == []
    assert plan.changes == []
    assert plan.unchanged == len(state["item"]) - 2  # "gone" and "dup" are not exported at all


def test_retired_round_trips(db):
    state = seeded(db)
    by_id = rows_by_id(inventory_csv.export(state))
    assert by_id["cot"]["retired"] == "yes"
    assert by_id["trailer"]["retired"] == ""


# --- plan: changes to an existing item ---------------------------------------------------


def test_a_new_home_name_plans_a_change_and_lists_the_new_location(db):
    state = seeded(db)
    text = make_csv(["id", "home"], [["trailer", "Warm locker"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    assert plan.new_locations == ["Warm locker"]
    [change] = plan.changes
    assert change["item_id"] == "trailer"
    assert change["changes"] == [
        {
            "field": "home_location_id",
            "old_display": "Cold locker",
            "new_display": "Warm locker",
            "old_raw": "loc-1",
            "new_raw": "Warm locker",
        }
    ]


def test_apply_creates_the_location_and_writes_the_field_change(db):
    seeded(db)
    text = make_csv(["id", "home"], [["trailer", "Warm locker"]])

    result = inventory_csv.apply(db, text, ACTOR)

    assert result["created_locations"] == ["Warm locker"]
    assert result["changed"] == 1
    after = derived.snapshot(db)
    warm_id = next(k for k, v in after["location"].items() if v["name"] == "Warm locker")
    assert after["item"]["trailer"]["home_location_id"] == warm_id

    [field_changed] = [
        e
        for e in events.in_replay_order(db, "item", "trailer")
        if e.type == "field_changed" and e.payload["field"] == "home_location_id"
    ]
    assert field_changed.payload["old"] == "loc-1"
    assert field_changed.payload["value"] == warm_id


def test_a_blank_cell_clears_a_field(db):
    seeded(db)
    text = make_csv(["id", "supplier"], [["trailer", ""]])

    inventory_csv.apply(db, text, ACTOR)

    assert derived.snapshot(db)["item"]["trailer"]["supplier"] is None


def test_an_absent_column_leaves_the_field_alone(db):
    seeded(db)
    text = make_csv(["id", "description"], [["trailer", "Very blue indeed"]])

    inventory_csv.apply(db, text, ACTOR)

    trailer = derived.snapshot(db)["item"]["trailer"]
    assert trailer["description"] == "Very blue indeed"
    assert trailer["home_location_id"] == "loc-1"
    assert trailer["supplier"] == "Local outfitter"
    assert trailer["price"] == 240.0


def test_a_unit_with_a_non_blank_category_cell_is_an_error(db):
    state = seeded(db)
    text = make_csv(["id", "category"], [["tarp-1", "Tarps"]])

    plan = inventory_csv.plan(state, text)

    assert len(plan.errors) == 1
    assert plan.errors[0]["row"] == 2


def test_importing_two_known_category_names_records_one_change_with_both_ids(db):
    state = seeded(db)
    text = make_csv(["id", "category"], [["tarp", "Tarps; Tents"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    assert plan.new_categories == []
    [change] = plan.changes
    [cat_change] = change["changes"]
    assert cat_change["field"] == "category_ids"
    assert cat_change["old_display"] == "Tarps"
    assert cat_change["new_display"] == "Tarps; Tents"
    assert cat_change["old_raw"] == ["cat-1"]
    assert cat_change["new_raw"] == ["Tarps", "Tents"]

    result = inventory_csv.apply(db, text, ACTOR)

    assert result["changed"] == 1
    assert sorted(derived.snapshot(db)["item"]["tarp"]["category_ids"]) == ["cat-1", "cat-2"]


def test_an_unknown_category_name_in_the_cell_is_created(db):
    state = seeded(db)
    text = make_csv(["id", "category"], [["tarp", "Tarps; Boats"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    assert plan.new_categories == ["Boats"]

    result = inventory_csv.apply(db, text, ACTOR)

    assert result["created_categories"] == ["Boats"]
    after = derived.snapshot(db)
    boats_id = next(k for k, v in after["category"].items() if v["name"] == "Boats")
    assert sorted(after["item"]["tarp"]["category_ids"]) == sorted(["cat-1", boats_id])


# --- plan: adds --------------------------------------------------------------------------


def test_a_unit_add_can_name_a_generic_added_earlier_in_the_file(db):
    state = seeded(db)
    text = make_csv(
        ["kind", "name", "generic", "number"],
        [["generic", "Cooler", "", ""], ["unit", "", "Cooler", "1"]],
    )

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    assert len(plan.adds) == 2

    result = inventory_csv.apply(db, text, ACTOR)
    assert result["added"] == 2
    after = derived.snapshot(db)
    cooler_id = next(k for k, v in after["item"].items() if v.get("name") == "Cooler")
    unit = next(v for v in after["item"].values() if v.get("parent_id") == cooler_id)
    assert unit["number"] == "1"


def test_duplicate_number_in_the_file_is_a_planned_error(db):
    state = seeded(db)
    text = make_csv(
        ["kind", "name", "generic", "number"],
        [
            ["generic", "Poles", "", ""],
            ["unit", "", "Poles", "1"],
            ["unit", "", "Poles", "1"],
        ],
    )

    plan = inventory_csv.plan(state, text)

    assert [e["row"] for e in plan.errors] == [4]


def test_unknown_column_is_an_error_on_row_one(db):
    state = seeded(db)
    text = make_csv(["id", "bogus"], [["trailer", "x"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == [{"row": 1, "message": "unknown column 'bogus'"}]
    assert plan.adds == []
    assert plan.changes == []


# --- apply: all or nothing ----------------------------------------------------------------


def test_apply_with_a_planned_error_writes_nothing(db):
    seeded(db)
    before = derived.cursor(db)
    text = make_csv(["id", "home"], [["no-such-item", "Warm locker"]])

    with pytest.raises(BadRequest, match="row 2"):
        inventory_csv.apply(db, text, ACTOR)

    assert derived.cursor(db) == before


def test_retired_yes_and_blank_round_trip_through_apply(db):
    seeded(db)

    inventory_csv.apply(db, make_csv(["id", "retired"], [["trailer", "yes"]]), ACTOR)
    assert derived.snapshot(db)["item"]["trailer"]["retired"] is True

    inventory_csv.apply(db, make_csv(["id", "retired"], [["trailer", ""]]), ACTOR)
    assert derived.snapshot(db)["item"]["trailer"]["retired"] is False
