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
    code bound to it, one item checked out, one retired, one deleted, one merged away, and a
    pool with some out."""
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
    events.append_server(
        conn, ACTOR, "item", "bowls", "created", {"name": "Bowls", "generic": True, "pool": True, "quantity": 12}
    )
    events.append_server(conn, ACTOR, "item", "bowls", "checked_out", {"holder_id": "bob", "count": 3})
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


def test_a_pool_row_carries_quantity_owned_in_and_out(db):
    state = seeded(db)
    by_id = rows_by_id(inventory_csv.export(state))

    assert by_id["bowls"]["kind"] == "pool"
    assert by_id["bowls"]["quantity"] == "12"
    assert by_id["bowls"]["in"] == "9"
    assert by_id["bowls"]["out"] == "3"
    # A generic never moves, so status and holder stay blank, same as a plain generic.
    assert by_id["bowls"]["status"] == ""
    assert by_id["bowls"]["holder"] == ""
    assert by_id["bowls"]["code"] == ""


def test_a_non_pool_row_leaves_the_pool_columns_empty(db):
    state = seeded(db)
    by_id = rows_by_id(inventory_csv.export(state))

    assert by_id["trailer"]["quantity"] == ""
    assert by_id["trailer"]["in"] == ""
    assert by_id["trailer"]["out"] == ""
    assert by_id["tarp"]["quantity"] == ""


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
    text = make_csv(["id", "description"], [["trailer", ""]])

    inventory_csv.apply(db, text, ACTOR)

    assert derived.snapshot(db)["item"]["trailer"]["description"] is None


def test_an_absent_column_leaves_the_field_alone(db):
    seeded(db)
    text = make_csv(["id", "description"], [["trailer", "Very blue indeed"]])

    inventory_csv.apply(db, text, ACTOR)

    trailer = derived.snapshot(db)["item"]["trailer"]
    assert trailer["description"] == "Very blue indeed"
    assert trailer["home_location_id"] == "loc-1"
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


# --- plan: adds a pool (FR-INV-34) --------------------------------------------------------


def test_a_generic_row_with_a_quantity_is_previewed_and_created_as_a_pool(db):
    state = seeded(db)
    text = make_csv(["kind", "name", "quantity"], [["generic", "Mugs", "20"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    [row] = plan.summary()["rows"]
    assert row["name"] == "Mugs (pool of 20)"

    result = inventory_csv.apply(db, text, ACTOR)
    assert result["added"] == 1
    after = derived.snapshot(db)
    mugs = next(v for v in after["item"].values() if v.get("name") == "Mugs")
    assert mugs["generic"] is True
    assert mugs["pool"] is True
    assert mugs["pool_in"] == 20
    assert mugs["pool_out"] == {}


def test_a_quantity_and_a_code_together_is_refused(db):
    state = seeded(db)
    text = make_csv(["kind", "name", "quantity", "code"], [["generic", "Mugs", "20", "AAAAAAAAAA"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == [{"row": 2, "message": "a pool takes no code (FR-INV-34)"}]


def test_a_quantity_on_a_unit_row_is_refused(db):
    state = seeded(db)
    text = make_csv(
        ["kind", "name", "generic", "number", "quantity"],
        [["generic", "Poles", "", "", ""], ["unit", "", "Poles", "1", "5"]],
    )

    plan = inventory_csv.plan(state, text)

    assert plan.errors == [{"row": 3, "message": "a pool has no units (FR-INV-34)"}]


def test_a_quantity_on_a_single_is_refused(db):
    state = seeded(db)
    text = make_csv(["kind", "name", "quantity"], [["single", "Kettle", "3"]])

    plan = inventory_csv.plan(state, text)

    assert len(plan.errors) == 1
    assert plan.errors[0]["row"] == 2


def test_a_pool_row_in_the_file_is_not_a_valid_parent_for_a_unit_row(db):
    state = seeded(db)
    text = make_csv(
        ["kind", "name", "generic", "number", "quantity"],
        [["generic", "Mugs", "", "", "20"], ["unit", "", "Mugs", "1", ""]],
    )

    plan = inventory_csv.plan(state, text)

    assert plan.errors == [{"row": 3, "message": "a pool has no units (FR-INV-34)"}]


def test_a_unit_row_naming_an_existing_pool_is_refused(db):
    """`bowls`, from `seeded`, is a pool already in the database, not one added in this file."""
    state = seeded(db)
    text = make_csv(["kind", "generic", "number"], [["unit", "Bowls", "1"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == [{"row": 2, "message": "a pool has no units (FR-INV-34)"}]


def test_a_pool_kind_add_requires_a_quantity(db):
    state = seeded(db)
    text = make_csv(["kind", "name"], [["pool", "Mugs"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == [{"row": 2, "message": "quantity is required for a pool"}]


def test_a_pool_kind_add_is_the_same_as_a_generic_with_a_quantity(db):
    state = seeded(db)
    text = make_csv(["kind", "name", "quantity"], [["pool", "Mugs", "20"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    [add] = plan.adds
    assert add["kind"] == "pool"
    assert add["payload"] == {"name": "Mugs", "generic": True, "pool": True, "quantity": 20}


def test_a_pool_export_row_re_imports_as_one_pool_add(db):
    """Export writes `kind = pool`; stripped of its id, that must be an accepted add (FR-INV-34)."""
    state = seeded(db)
    bowls_row = dict(rows_by_id(inventory_csv.export(state))["bowls"])
    del bowls_row["id"]
    text = make_csv(list(bowls_row.keys()), [list(bowls_row.values())])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    [add] = plan.adds
    assert add["kind"] == "pool"
    assert add["payload"]["generic"] is True
    assert add["payload"]["pool"] is True
    assert add["payload"]["quantity"] == 12  # owned: pool_in (9) + out (3)

    result = inventory_csv.apply(db, text, ACTOR)
    assert result["added"] == 1


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


def test_a_supplier_column_from_an_old_export_does_not_error(db):
    """`supplier` was dropped (FR-INV-12); an export made before that still imports."""
    state = seeded(db)
    text = make_csv(["id", "supplier"], [["trailer", "New Outfitter"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    assert plan.changes == []
    assert plan.unchanged == 1


def test_a_repeated_column_name_is_an_error_on_row_one(db):
    state = seeded(db)
    text = make_csv(["id", "home", "home"], [["trailer", "Warm locker", "Cold locker"]])

    plan = inventory_csv.plan(state, text)

    assert plan.errors == [{"row": 1, "message": "column 'home' appears twice"}]
    assert plan.adds == []
    assert plan.changes == []


def test_a_blank_trailing_line_is_skipped_not_planned_as_an_add(db):
    """One stray newline from Excel must not fail the whole file (kind is required, otherwise)."""
    state = seeded(db)
    text = "kind,name\nsingle,Kettle\n\n"

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    assert len(plan.adds) == 1


# --- apply: all or nothing ----------------------------------------------------------------


def test_apply_with_a_planned_error_writes_nothing(db):
    seeded(db)
    before = derived.cursor(db)
    text = make_csv(["id", "home"], [["no-such-item", "Warm locker"]])

    with pytest.raises(BadRequest, match="row 2"):
        inventory_csv.apply(db, text, ACTOR)

    assert derived.cursor(db) == before


def test_a_whole_successful_import_commits_as_one_transaction(db):
    """Every row that plan accepts is also one apply can write without failing, so a genuine
    mid-import failure cannot be provoked through the public plan/apply surface without a mock.
    This instead checks the transaction a multi-row, multi-write import leaves behind: everything
    lands, and no transaction is left open."""
    seeded(db)
    text = make_csv(
        ["kind", "name", "home", "category"],
        [
            ["single", "Kettle", "Warm locker", "Tarps; Boats"],
            ["generic", "Cooler", "", ""],
        ],
    )

    result = inventory_csv.apply(db, text, ACTOR)

    assert result["added"] == 2
    assert result["created_locations"] == ["Warm locker"]
    assert result["created_categories"] == ["Boats"]
    assert db.in_transaction is False
    after = derived.snapshot(db)
    assert any(v.get("name") == "Kettle" for v in after["item"].values())
    assert any(v.get("name") == "Cooler" for v in after["item"].values())


def test_retired_yes_and_blank_round_trip_through_apply(db):
    seeded(db)

    inventory_csv.apply(db, make_csv(["id", "retired"], [["trailer", "yes"]]), ACTOR)
    assert derived.snapshot(db)["item"]["trailer"]["retired"] is True

    inventory_csv.apply(db, make_csv(["id", "retired"], [["trailer", ""]]), ACTOR)
    assert derived.snapshot(db)["item"]["trailer"]["retired"] is False


# --- formula injection (CWE-1236) ---------------------------------------------------------


def test_a_name_that_reads_as_a_formula_is_escaped_on_export(db):
    events.append_server(db, ACTOR, "item", "evil", "created", {"name": '=HYPERLINK("http://evil","click")'})
    state = derived.snapshot(db)

    by_id = rows_by_id(inventory_csv.export(state))

    assert by_id["evil"]["name"] == '\'=HYPERLINK("http://evil","click")'


def test_a_normal_name_is_untouched_by_export(db):
    state = seeded(db)
    by_id = rows_by_id(inventory_csv.export(state))
    assert by_id["trailer"]["name"] == "Trailer"


def test_an_escaped_name_round_trips_unchanged(db):
    events.append_server(db, ACTOR, "item", "evil", "created", {"name": '=HYPERLINK("http://evil","click")'})
    state = derived.snapshot(db)
    text = inventory_csv.export(state)

    plan = inventory_csv.plan(state, text)

    assert plan.errors == []
    assert plan.adds == []
    assert plan.changes == []
