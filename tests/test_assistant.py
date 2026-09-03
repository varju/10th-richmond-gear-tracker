"""Assistant access: the token, the endpoint, and every tool, against a real database.

The tools are called as the endpoint calls them, with a real connection and a
real principal. The endpoint itself is driven over the real ASGI app, once with
raw JSON-RPC and once with the SDK's own client.
"""

from __future__ import annotations

import anyio
import httpx2
import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client

from gear_tracker import accounts, assistant, derived, events
from gear_tracker.app import create_app
from gear_tracker.db import open_db
from gear_tracker.errors import ApiError, BadRequest, Conflict, NotFound
from gear_tracker.sync import Principal

RPC = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}

ALICE = "01AAAAAAAAAAAAAAAAAAAAAAAA"
DEVICE = "mcp-01BBBBBBBBBBBBBBBBBBBBBBBB"


def by_header(request: Request, _conn) -> Principal | None:
    """Test-only: the caller says who they are in headers, as tests/test_app.py does."""
    user = request.headers.get("X-Test-User")
    if user is None:
        return None
    return Principal(
        user_id=user,
        device_id=request.headers.get("X-Test-Device", DEVICE),
        active=request.headers.get("X-Test-Active", "yes") == "yes",
        role=request.headers.get("X-Test-Role", "user"),
    )


@pytest.fixture
def who() -> Principal:
    return Principal(user_id=ALICE, device_id=DEVICE)


@pytest.fixture
def inventory(db_path, who):
    """A locker with a stove, three tents under one generic, and two locations."""
    with open_db(db_path) as conn:
        events.append_server(conn, ALICE, "user", ALICE, "created", {"name": "Alice", "role": "user", "active": True})
        made = {}
        for key, name in (("warm", "Warm locker"), ("cold", "Cold locker")):
            made[key] = _new(conn, "location", {"name": name})
        made["tents_cat"] = _new(conn, "category", {"name": "Tents"})
        made["stove"] = _new(conn, "item", {"name": "Camp stove", "home_location_id": made["warm"]})
        made["tents"] = _new(
            conn,
            "item",
            {
                "name": "4-person tent",
                "generic": True,
                "home_location_id": made["cold"],
                "category_ids": [made["tents_cat"]],
            },
        )
        for number in ("1", "2", "3"):
            made[f"t{number}"] = _new(conn, "item", {"parent_id": made["tents"], "number": number})
    return made


def _new(conn, entity_type, payload):
    from gear_tracker.ulid import new_ulid

    entity_id = new_ulid()
    events.append_server(conn, ALICE, entity_type, entity_id, "created", payload)
    return entity_id


@pytest.fixture
def tools(db_path, who, inventory):
    """Call the tool functions the way the endpoint does."""
    with assistant.acting_as(who, db_path):
        yield inventory


def entity(db_path, entity_type, entity_id):
    with open_db(db_path) as conn:
        return derived.get_entity(conn, entity_type, entity_id)


def logged(db_path):
    with open_db(db_path) as conn:
        return [dict(row) for row in conn.execute("SELECT * FROM events ORDER BY seq")]


# --- the token ------------------------------------------------------------------------------


@pytest.fixture
def real(db_path):
    """The real authenticator, with an Admin who has signed in."""
    with open_db(db_path) as conn:
        accounts.create_admin(conn, "Alex", "alex@example.org", "correct horse")
    client = TestClient(create_app(db_path))
    signed = client.post(
        "/auth/sign-in", json={"email": "alex@example.org", "password": "correct horse", "device_id": "phone-a"}
    ).json()
    client.headers["Authorization"] = f"Bearer {signed['token']}"
    return client


def call(client, method, params=None, token=None):
    headers = dict(RPC)
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return client.post(
        "/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    )


def test_connecting_an_assistant_hands_back_a_token_that_works(real):
    made = real.post("/assistant/connect").json()
    assert made["device_id"].startswith(accounts.ASSISTANT_PREFIX)
    assert made["path"] == "/mcp"

    with real as client:
        answered = call(client, "tools/list", token=made["token"])
    assert answered.status_code == 200
    assert answered.json()["result"]["tools"]


def test_the_assistant_is_a_device_in_the_list_and_revoking_it_ends_the_token(real):
    made = real.post("/assistant/connect").json()
    me = real.get("/users").json()["users"][0]["id"]

    devices = real.get(f"/users/{me}/devices").json()["devices"]
    assert made["device_id"] in [d["device_id"] for d in devices]

    real.post(f"/users/{me}/devices/{made['device_id']}/revoke")
    with real as client:
        assert call(client, "tools/list", token=made["token"]).status_code == 401


def test_a_bad_token_is_401_and_a_phones_token_is_403(real):
    with real as client:
        refused = call(client, "tools/list", token="not-a-token")
        assert refused.status_code == 401
        assert refused.json()["error"] == "unauthorized"

        # The Admin's own phone token is signed in, and still not an assistant:
        # a phone keeps its own device_seq, and the server keeps an assistant's.
        phone = client.post(
            "/mcp", headers={**RPC, **dict(client.headers)}, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        assert phone.status_code == 403


def test_a_deactivated_account_cannot_use_its_assistant(db_path):
    with TestClient(create_app(db_path, by_header)) as client:
        headers = {**RPC, "X-Test-User": ALICE, "X-Test-Active": "no"}
        refused = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert refused.status_code == 403
    assert refused.json()["error"] == "deactivated"


def test_a_token_gets_a_hundred_and_twenty_calls_a_minute(db_path):
    with TestClient(create_app(db_path, by_header)) as client:
        headers = {**RPC, "X-Test-User": ALICE}
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        codes = [client.post("/mcp", headers=headers, json=body).status_code for _ in range(121)]
    assert codes[:120] == [200] * 120
    assert codes[120] == 429


# --- the tool list --------------------------------------------------------------------------


def test_the_tools_are_what_a_user_can_do_and_nothing_an_admin_does(db_path):
    with TestClient(create_app(db_path, by_header)) as client:
        listed = client.post(
            "/mcp", headers={**RPC, "X-Test-User": ALICE}, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        ).json()
    names = {tool["name"] for tool in listed["result"]["tools"]}
    assert names == {tool.__name__ for tool in assistant.TOOLS}
    # FR-MCP-04: no users, mail, settings, locations, or codes.
    assert not [n for n in names if "user" in n or "mail" in n or "code" in n or "setting" in n]
    assert not [n for n in names if "location" in n and n != "list_locations"]
    assert all(tool.__doc__ for tool in assistant.TOOLS)


def test_the_sdks_own_client_can_talk_to_it(db_path, who, inventory):
    app = create_app(db_path, by_header)

    async def scenario():
        http = httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url="http://testserver", headers={"X-Test-User": ALICE}
        )
        async with (
            app.router.lifespan_context(app),
            http,
            streamable_http_client("http://testserver/mcp", http_client=http) as (read, write, *_),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            listed = await session.list_tools()
            found = await session.call_tool("search_items", {"query": "stove"})
            return [t.name for t in listed.tools], found.is_error, found.content[0].text

    names, failed, text = anyio.run(scenario)
    assert "search_items" in names
    assert not failed
    assert "Camp stove" in text


# --- reading ---------------------------------------------------------------------------------


def test_search_groups_units_under_their_generic_and_counts_them(tools):
    rows = assistant.search_items()["rows"]
    kinds = {row["name"]: row for row in rows}
    assert kinds["Camp stove"]["kind"] == "single"
    assert kinds["Camp stove"]["home"] == "Warm locker"
    assert kinds["4-person tent"] == {
        "kind": "generic",
        "item_id": tools["tents"],
        "name": "4-person tent",
        "units": 3,
        "in": 3,
        "unit_ids": [tools["t1"], tools["t2"], tools["t3"]],
        "categories": ["Tents"],
    }
    assert assistant.search_items(query="stove")["count"] == 1
    assert assistant.search_items(query="nothing here")["rows"] == []


def test_search_filters_by_location_and_status(tools):
    assistant.check_out(tools["stove"], event="Fall Camp")
    assert [r["name"] for r in assistant.search_items(status="out")["rows"]] == ["Camp stove"]
    # Units still group under their generic; with the stove out, only the tents are in.
    still_in = assistant.search_items(status="in")["rows"]
    assert [r["name"] for r in still_in] == ["4-person tent"]
    assert still_in[0]["units"] == 3
    assert [r["name"] for r in assistant.search_items(location_id=tools["warm"])["rows"]] == ["Camp stove"]


def test_get_item_carries_the_unit_its_generic_its_history_and_its_tickets(tools):
    assistant.check_out(tools["t1"], event="Fall Camp", note="one pole bent")
    assistant.raise_ticket(tools["t1"], "bent pole")
    unit = assistant.get_item(tools["t1"])

    assert unit["name"] == "4-person tent #1"
    assert unit["generic_id"] == tools["tents"] and unit["number"] == "1"
    assert unit["status"] == "out" and unit["holder"] == "Alice"
    assert unit["event"] == "Fall Camp"
    assert unit["categories"] == ["Tents"]  # a unit reads its generic's categories (FR-SET-07)
    assert [t["description"] for t in unit["open_tickets"]] == ["bent pole"]
    assert [h["type"] for h in unit["history"]] == ["checked_out"]
    assert unit["history"][0]["by"] == "Alice"
    assert [n["text"] for n in unit["notes"]] == ["one pole bent"]

    generic = assistant.get_item(tools["tents"])
    assert generic["generic"] is True
    assert [u["name"] for u in generic["units"]] == ["4-person tent #1", "4-person tent #2", "4-person tent #3"]

    with pytest.raises(NotFound):
        assistant.get_item("nope")


def test_a_deleted_item_is_not_there_at_all(db_path, tools):
    """A record made in error is off every list, and no tool acts on it (FR-INV-32)."""
    gone = {"field": "deleted", "value": True, "old": None}
    with open_db(db_path) as conn:
        events.append_server(conn, ALICE, "item", tools["stove"], "field_changed", gone)

    assert [r["name"] for r in assistant.search_items()["rows"]] == ["4-person tent"]
    with pytest.raises(NotFound):
        assistant.get_item(tools["stove"])
    with pytest.raises(NotFound):
        assistant.check_out(tools["stove"])


def test_whats_out_is_by_holder_with_the_event(tools):
    assistant.check_out(tools["stove"], event="Fall Camp")
    report = assistant.whats_out()
    assert report["total"] == 1 and report["overdue"] == 0
    assert report["holders"][0]["holder"] == "Alice"
    assert report["holders"][0]["items"][0]["event"] == "Fall Camp"


def test_list_locations_counts_what_lives_there(tools):
    found = {loc["name"]: loc for loc in assistant.list_locations()["locations"]}
    assert found["Warm locker"]["items"] == 1
    assert found["Cold locker"]["items"] == 1  # the generic; its units take no home of their own here


def test_list_categories_counts_the_units_not_the_generic(tools):
    found = {cat["name"]: cat for cat in assistant.list_categories()["categories"]}
    assert found["Tents"]["items"] == 3
    assert found["Tents"]["category_id"] == tools["tents_cat"]


def test_list_repairs_shows_open_ones_with_their_comments(tools):
    ticket = assistant.raise_ticket(tools["stove"], "valve sticks")["ticket_id"]
    assistant.comment_ticket(ticket, "new valve ordered")
    open_now = assistant.list_repairs()["tickets"]
    assert [t["item"] for t in open_now] == ["Camp stove"]
    assert [c["text"] for c in open_now[0]["comments"]] == ["new valve ordered"]

    assistant.set_ticket_state(ticket, "resolved")
    assert assistant.list_repairs()["tickets"] == []
    assert [t["state"] for t in assistant.list_repairs(open_only=False)["tickets"]] == ["resolved"]
    with pytest.raises(NotFound):
        assistant.comment_ticket("nope", "hello")


# --- writing ------------------------------------------------------------------------------------


def test_a_write_is_an_ordinary_event_from_the_assistant_device(db_path, tools, who):
    assistant.check_out(tools["stove"], event="Fall Camp")

    movement = [e for e in logged(db_path) if e["type"] == "checked_out"]
    assert len(movement) == 1
    assert movement[0]["actor_id"] == ALICE
    assert movement[0]["device_id"] == DEVICE
    assert movement[0]["device_seq"] == 1
    assert entity(db_path, "item", tools["stove"])["status"] == "out"


def test_device_seq_climbs_across_calls_and_is_kept_on_the_server(db_path, tools):
    assistant.check_out(tools["stove"])
    assistant.check_in(tools["stove"], note="back on the shelf")
    assistant.check_out(tools["t1"])

    mine = [e["device_seq"] for e in logged(db_path) if e["device_id"] == DEVICE]
    assert mine == [1, 2, 3, 4]  # the check-in carries a note, so it is two events
    with open_db(db_path) as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (f"device_seq:{DEVICE}",)).fetchone()
    assert int(row["value"]) == 4


def test_check_out_and_in_mirror_the_app(db_path, tools):
    assistant.check_out(tools["t1"], event="Fall Camp", note="took the spare pegs")
    with pytest.raises(Conflict):
        assistant.check_out(tools["t1"])
    with pytest.raises(BadRequest):
        assistant.check_out(tools["tents"])  # a generic does not move (FR-INV-21)

    back = assistant.check_in(tools["t1"])
    assert back["status"] == "in"
    with pytest.raises(Conflict):
        assistant.check_in(tools["t1"])
    assert entity(db_path, "item", tools["t1"])["holder_id"] is None


def test_check_in_clears_missing(db_path, tools):
    assistant.mark_missing(tools["stove"])
    assert entity(db_path, "item", tools["stove"])["missing"] is True
    assert assistant.mark_missing(tools["stove"])["already"] is True

    assistant.check_out(tools["stove"])
    assistant.check_in(tools["stove"])
    assert entity(db_path, "item", tools["stove"])["missing"] is False


def test_creating_an_item_a_generic_and_its_units(db_path, tools):
    made = assistant.create_item("Dining shelter", home_location_id=tools["warm"], description="green")
    assert entity(db_path, "item", made["item_id"])["name"] == "Dining shelter"

    generic = assistant.create_item("Trangia", home_location_id=tools["cold"], generic=True)["item_id"]
    first = assistant.add_unit(generic)
    second = assistant.add_unit(generic, nickname="dented")
    lettered = assistant.add_unit(generic, number=" 3b ")
    assert (first["number"], second["number"], lettered["number"]) == ("1", "2", "3b")
    assert entity(db_path, "item", second["item_id"])["home_location_id"] == tools["cold"]

    with pytest.raises(Conflict):
        assistant.add_unit(generic, number="1")
    with pytest.raises(BadRequest):
        assistant.add_unit(generic, number="   ")
    with pytest.raises(BadRequest):
        assistant.add_unit(tools["stove"])
    with pytest.raises(NotFound):
        assistant.create_item("Axe", home_location_id="nowhere")
    with pytest.raises(BadRequest):
        assistant.create_item("   ")


def test_categorising_an_item(db_path, tools):
    made = assistant.create_item("Axe", home_location_id=tools["warm"], category_ids=[tools["tents_cat"]])
    assert entity(db_path, "item", made["item_id"])["category_ids"] == [tools["tents_cat"]]
    assert assistant.get_item(made["item_id"])["categories"] == ["Tents"]
    rows = {r["name"]: r for r in assistant.search_items()["rows"]}
    assert rows["Axe"]["categories"] == ["Tents"]

    with pytest.raises(NotFound):
        assistant.create_item("Saw", category_ids=["nowhere"])

    with pytest.raises(BadRequest):
        assistant.update_item(tools["t1"], assistant.ItemFields(category_ids=[tools["tents_cat"]]))

    changed = assistant.update_item(tools["tents"], assistant.ItemFields(category_ids=None))
    # None clears the field once, then a second call finds nothing left to change.
    assert changed["changed"] == ["category_ids"]
    again = assistant.update_item(tools["tents"], assistant.ItemFields(category_ids=None))
    assert again["changed"] == []


def test_an_item_can_be_put_in_several_categories(db_path, tools):
    with open_db(db_path) as conn:
        tarps_cat = _new(conn, "category", {"name": "Tarps"})

    made = assistant.create_item("Tarp", category_ids=[tools["tents_cat"], tarps_cat])
    # Stored by name, Tarps before Tents, whatever order the caller gave.
    assert entity(db_path, "item", made["item_id"])["category_ids"] == [tarps_cat, tools["tents_cat"]]
    assert assistant.get_item(made["item_id"])["categories"] == ["Tarps", "Tents"]


def test_changing_to_a_new_set_of_categories_records_one_change(db_path, tools):
    with open_db(db_path) as conn:
        tarps_cat = _new(conn, "category", {"name": "Tarps"})

    changed = assistant.update_item(tools["tents"], assistant.ItemFields(category_ids=[tools["tents_cat"], tarps_cat]))

    assert changed["changed"] == ["category_ids"]
    # Sorted by category name, so two devices land on the same stored order.
    assert entity(db_path, "item", tools["tents"])["category_ids"] == [tarps_cat, tools["tents_cat"]]


def test_list_categories_counts_an_item_under_each_of_its_categories(db_path, tools):
    with open_db(db_path) as conn:
        tarps_cat = _new(conn, "category", {"name": "Tarps"})
    assistant.update_item(tools["tents"], assistant.ItemFields(category_ids=[tools["tents_cat"], tarps_cat]))

    found = {cat["name"]: cat for cat in assistant.list_categories()["categories"]}
    assert found["Tents"]["items"] == 3
    assert found["Tarps"]["items"] == 3


def test_an_old_item_with_only_category_id_falls_back_to_one_category(db_path, tools):
    """An item from before September 2026 may still carry the single `category_id`."""
    with open_db(db_path) as conn:
        old_style = _new(conn, "item", {"name": "Old axe", "category_id": tools["tents_cat"]})

    assert assistant.get_item(old_style)["categories"] == ["Tents"]

    assistant.update_item(old_style, assistant.ItemFields(category_ids=[]))

    # category_ids: [] wins over the old category_id it still carries: no categories.
    assert "categories" not in assistant.get_item(old_style)


def test_updating_an_item_records_only_what_differs(db_path, tools):
    changed = assistant.update_item(tools["stove"], assistant.ItemFields(description="Two burner", price=89.5))
    assert set(changed["changed"]) == {"description", "price"}
    again = assistant.update_item(tools["stove"], assistant.ItemFields(description="Two burner"))
    assert again["changed"] == []

    assistant.update_item(tools["t2"], assistant.ItemFields(nickname="patched fly"))
    assert assistant.get_item(tools["t2"])["name"] == "4-person tent #2 (patched fly)"
    with pytest.raises(Conflict):
        assistant.update_item(tools["t2"], assistant.ItemFields(number="3"))
    with pytest.raises(BadRequest):
        assistant.update_item(tools["stove"], assistant.ItemFields(number="2"))
    with pytest.raises(BadRequest):
        assistant.update_item(tools["stove"], assistant.ItemFields())


# --- reservations ------------------------------------------------------------------------------

FALL = {"event": "Fall Camp", "starts": "2026-10-02", "ends": "2026-10-04"}


def test_a_reservation_is_created_edited_and_cancelled(db_path, tools):
    made = assistant.create_reservation(**FALL, items=[tools["stove"]])
    assert made["saved"] is True
    reservation_id = made["reservation_id"]

    assistant.add_to_reservation(reservation_id, tools["tents"], quantity=2)
    assistant.add_to_reservation(reservation_id, tools["t1"])
    got = assistant.get_reservation(reservation_id)
    assert [row["name"] for row in got["to_pack"]] == ["4-person tent #1", "Camp stove"]
    assert got["generic_lines"] == [{"item_id": tools["tents"], "name": "4-person tent", "quantity": 2, "done": 0}]

    assistant.remove_from_reservation(reservation_id, tools["t1"])
    assistant.remove_from_reservation(reservation_id, tools["tents"])
    assert assistant.get_reservation(reservation_id)["items"] == 1
    assert assistant.get_reservation(reservation_id)["generic_lines"] == []

    renamed = assistant.update_reservation(reservation_id, event="Fall camp 2026", ends="2026-10-05")
    assert set(renamed["changed"]) == {"event", "ends"}
    assert entity(db_path, "reservation", reservation_id)["ends"] == "2026-10-05"

    assistant.cancel_reservation(reservation_id)
    assert entity(db_path, "reservation", reservation_id)["cancelled"] is True
    assert assistant.cancel_reservation(reservation_id)["already"] is True


def test_the_gear_list_is_only_ever_written_one_line_at_a_time(db_path, tools):
    made = assistant.create_reservation(**FALL)["reservation_id"]
    assistant.add_to_reservation(made, tools["stove"])
    assistant.add_to_reservation(made, tools["tents"], quantity=1)
    assistant.remove_from_reservation(made, tools["stove"])

    kinds = [e["type"] for e in logged(db_path) if e["entity_type"] == "reservation"]
    assert kinds == ["created", "item_added", "quantity_changed", "item_removed"]
    # A whole-list write is not a thing the server will take (FR-RES-07).
    with open_db(db_path) as conn, pytest.raises(ApiError, match="one line at a time"):
        assistant._push(
            conn,
            Principal(user_id=ALICE, device_id=DEVICE),
            [assistant._draft("reservation", made, "field_changed", {"field": "items", "value": [], "old": []})],
        )


def test_a_clash_is_named_and_nothing_is_saved(db_path, tools):
    first = assistant.create_reservation(**FALL, items=[tools["stove"]])["reservation_id"]

    refused = assistant.create_reservation(
        event="Cub camp", starts="2026-10-04", ends="2026-10-05", items=[tools["stove"]]
    )
    assert refused["saved"] is False
    assert refused["clashes"] == [
        {"reservation_id": first, "event": "Fall Camp", "detail": "Camp stove"},
    ]
    assert refused["message"] == "Already reserved for Fall Camp (Camp stove)."
    assert len([e for e in logged(db_path) if e["entity_type"] == "reservation"]) == 1


def test_a_generic_over_stock_clashes_on_the_way_in(tools):
    assistant.create_reservation(**FALL, generics=[{"item_id": tools["tents"], "quantity": 2}])
    fits = assistant.create_reservation(
        event="Cub camp", starts="2026-10-03", ends="2026-10-05", generics=[{"item_id": tools["tents"], "quantity": 1}]
    )
    assert fits["saved"] is True

    over = assistant.add_to_reservation(fits["reservation_id"], tools["tents"], quantity=2)
    assert over["saved"] is False
    assert "we have 3" in over["clashes"][0]["detail"]


def test_moving_the_dates_onto_another_camp_is_refused(tools):
    assistant.create_reservation(**FALL, items=[tools["stove"]])
    later = assistant.create_reservation(
        event="Cub camp", starts="2026-11-01", ends="2026-11-02", items=[tools["stove"]]
    )["reservation_id"]

    refused = assistant.update_reservation(later, starts="2026-10-03", ends="2026-10-03")
    assert refused["saved"] is False and refused["clashes"][0]["event"] == "Fall Camp"
    assert assistant.get_reservation(later)["starts"] == "2026-11-01"


def test_duplicating_a_reservation_copies_its_gear_onto_new_days(tools):
    last_year = assistant.create_reservation(
        event="Fall Camp",
        starts="2025-10-03",
        ends="2025-10-05",
        items=[tools["stove"]],
        generics=[{"item_id": tools["tents"], "quantity": 2}],
    )["reservation_id"]

    copy = assistant.duplicate_reservation(last_year, "Fall Camp 2026", "2026-10-02", "2026-10-04")
    assert copy["saved"] is True and copy["copied_from"] == last_year
    made = assistant.get_reservation(copy["reservation_id"])
    assert [row["name"] for row in made["to_pack"]] == ["Camp stove"]
    assert made["generic_lines"][0]["quantity"] == 2

    again = assistant.duplicate_reservation(last_year, "Cub camp", "2026-10-03", "2026-10-03")
    assert again["saved"] is False


def test_packing_is_derived_from_what_went_out_under_the_event(tools):
    made = assistant.create_reservation(
        **FALL, items=[tools["stove"]], generics=[{"item_id": tools["tents"], "quantity": 1}]
    )["reservation_id"]
    assistant.check_out(tools["stove"], event="Fall Camp")
    assistant.check_out(tools["t2"], event="Fall Camp")

    packed = assistant.get_reservation(made)
    assert [row["name"] for row in packed["packed"]] == ["Camp stove"]
    assert packed["to_pack"] == []
    assert packed["generic_lines"][0]["done"] == 1
    assert packed["fully_packed"] is True


def test_reservations_are_listed_upcoming_or_all(tools):
    old = assistant.create_reservation(event="Last spring", starts="2020-04-01", ends="2020-04-03")["reservation_id"]
    soon = assistant.create_reservation(event="Fall Camp", starts="2099-10-02", ends="2099-10-04")["reservation_id"]

    upcoming = [r["reservation_id"] for r in assistant.list_reservations()["reservations"]]
    assert upcoming == [soon]
    everything = [r["reservation_id"] for r in assistant.list_reservations(upcoming_only=False)["reservations"]]
    assert everything == [old, soon]
    with pytest.raises(NotFound):
        assistant.get_reservation("nope")


def test_a_reservation_that_ends_before_it_starts_is_refused(tools):
    with pytest.raises(BadRequest):
        assistant.create_reservation(event="Backwards", starts="2026-10-04", ends="2026-10-02")


def test_a_quantity_and_a_named_item_are_not_interchangeable(tools):
    made = assistant.create_reservation(**FALL)["reservation_id"]
    with pytest.raises(BadRequest):
        assistant.add_to_reservation(made, tools["stove"], quantity=2)
    with pytest.raises(BadRequest):
        assistant.add_to_reservation(made, tools["tents"])
    with pytest.raises(NotFound):
        assistant.remove_from_reservation(made, tools["stove"])
