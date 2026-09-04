"""Assistant access: the token, the endpoint, and every tool, against a real database.

The tools are called as the endpoint calls them, with a real connection and a
real principal. The endpoint itself is driven over the real ASGI app, once with
raw JSON-RPC and once with the SDK's own client.
"""

from __future__ import annotations

import email
import socket

import anyio
import httpx2
import pydantic
import pytest
from aiosmtpd.controller import Controller
from fastapi import Request
from fastapi.testclient import TestClient
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client

from gear_tracker import accounts, assistant, derived, events, notify
from gear_tracker.app import create_app
from gear_tracker.db import open_db
from gear_tracker.errors import ApiError, BadRequest, Conflict, Forbidden, NotFound
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


@pytest.fixture
def admin_id(db_path) -> str:
    """A real, active Admin, distinct from Alice (a User) in the inventory fixture (FR-USR-03).

    A real session too, on the same device_id the `admin` Principal below uses, so list_devices
    and revoke_device (FR-USR-14) have a real row to find, the way they would for a token minted
    through /assistant/connect.
    """
    with open_db(db_path) as conn:
        user_id = accounts.install_admin(conn, "Admin Alex", "alex@example.org", "correct horse battery staple")
        accounts._open_session(conn, user_id, "mcp-01CCCCCCCCCCCCCCCCCCCCCCCC", events.now_ms())
        return user_id


@pytest.fixture
def admin(admin_id) -> Principal:
    return Principal(user_id=admin_id, device_id="mcp-01CCCCCCCCCCCCCCCCCCCCCCCC", role="admin")


@pytest.fixture
def admin_tools(db_path, admin, inventory):
    """Call the tool functions as an Admin's assistant."""
    with assistant.acting_as(admin, db_path):
        yield inventory


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


def test_the_tool_list_is_a_user_and_an_admin_together(db_path):
    with TestClient(create_app(db_path, by_header)) as client:
        listed = client.post(
            "/mcp", headers={**RPC, "X-Test-User": ALICE}, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        ).json()
    names = {tool["name"] for tool in listed["result"]["tools"]}
    assert names == {tool.__name__ for tool in assistant.TOOLS}
    # An Admin's token unlocks an Admin's tools too (FR-MCP-10): the same roster is always
    # listed, and it is each tool's own call that refuses a User at the time it is used.
    for admin_only in ("list_users", "get_mail", "get_group", "delete_item", "print_codes", "preview_csv_import"):
        assert admin_only in names
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


def test_a_refusal_keeps_its_reason_over_the_wire(db_path, who, inventory):
    """The SDK hides an unexpected exception behind a generic message; the app's refusals are not those."""
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
            return await session.call_tool("check_out", {"item_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV"})

    result = anyio.run(scenario)
    assert result.is_error
    assert "no item with id 01ARZ3NDEKTSV4RRFFQ69G5FAV" in result.content[0].text


def test_a_coerced_type_is_refused_at_the_wire_not_silently_converted(db_path, who, inventory):
    """A JSON string is not a count, over MCP's own transport, not just the arg model in isolation."""
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
            return await session.call_tool("search_items", {"include_retired": "true"})

    result = anyio.run(scenario)
    assert result.is_error
    assert "include_retired" in result.content[0].text


# --- arguments validate strictly, the same as the event log -----------------------------------


def _arg_model(name):
    """The real model the SDK generated for one tool's arguments, coercion rules and all."""
    return assistant.build_server()._tool_manager.get_tool(name).fn_metadata.arg_model


def test_set_group_refuses_true_for_overdue_days():
    with pytest.raises(pydantic.ValidationError):
        _arg_model("set_group").model_validate({"fields": {"overdue_days": True}})


def test_check_out_refuses_a_string_count():
    with pytest.raises(pydantic.ValidationError):
        _arg_model("check_out").model_validate({"item_id": "x", "count": "3"})


def test_set_user_active_refuses_one_for_active():
    with pytest.raises(pydantic.ValidationError):
        _arg_model("set_user_active").model_validate({"user_id": "x", "active": 1})


def test_update_user_refuses_an_unknown_field():
    with pytest.raises(pydantic.ValidationError):
        _arg_model("update_user").model_validate({"user_id": "x", "fields": {"name": "Bea", "role": "admin"}})


def test_update_user_refuses_a_bad_email():
    with pytest.raises(pydantic.ValidationError):
        _arg_model("update_user").model_validate({"user_id": "x", "fields": {"email": "not-an-email"}})


def test_add_calendar_feed_refuses_a_url_that_is_not_http():
    with pytest.raises(pydantic.ValidationError):
        _arg_model("add_calendar_feed").model_validate({"url": "ftp://example.org/feed.ics"})


def test_recount_refuses_a_float_count():
    with pytest.raises(pydantic.ValidationError):
        _arg_model("recount").model_validate({"item_id": "x", "count": 2.0, "reason": "shelf check"})


def test_create_reservation_refuses_true_for_a_generic_lines_quantity():
    with pytest.raises(pydantic.ValidationError):
        _arg_model("create_reservation").model_validate(
            {
                "event": "Camp",
                "starts": "2026-01-01",
                "ends": "2026-01-02",
                "generics": [{"item_id": "x", "quantity": True}],
            }
        )


def test_a_json_whole_number_still_works_for_a_float_price():
    validated = _arg_model("update_item").model_validate({"item_id": "x", "fields": {"price": 3}})
    assert validated.fields.price == 3.0


def test_create_join_link_refuses_a_string_for_expiry_days():
    with pytest.raises(pydantic.ValidationError):
        _arg_model("create_join_link").model_validate({"expiry_days": "7"})


def test_create_join_link_refuses_a_day_count_that_is_not_one_of_the_three_choices():
    with pytest.raises(pydantic.ValidationError):
        _arg_model("create_join_link").model_validate({"expiry_days": 14})


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


def test_a_generic_or_a_pool_cannot_be_marked_missing(tools, pool_id):
    with pytest.raises(BadRequest, match="one of its units does"):
        assistant.mark_missing(tools["tents"])
    with pytest.raises(BadRequest, match="use recount"):
        assistant.mark_missing(pool_id)


def test_unassign_code_releases_it_and_needs_one_bound_first(db_path, tools):
    with pytest.raises(BadRequest):
        assistant.unassign_code(tools["stove"])

    with open_db(db_path) as conn:
        events.append_server(conn, ALICE, "code", "ABCDEFGH23", "created", {})
        events.append_server(conn, ALICE, "code", "ABCDEFGH23", "code_bound", {"item_id": tools["stove"]})

    released = assistant.unassign_code(tools["stove"])
    assert released == {"item_id": tools["stove"], "code": "ABCDEFGH23"}
    assert entity(db_path, "code", "ABCDEFGH23")["item_id"] is None

    with pytest.raises(BadRequest):
        assistant.unassign_code(tools["stove"])


def test_deleting_merging_and_unmerging_are_admin_only(tools):
    with pytest.raises(Forbidden) as exc:
        assistant.delete_item(tools["stove"])
    assert exc.value.message == "Admins only"
    with pytest.raises(Forbidden):
        assistant.merge_items(tools["t1"], tools["t2"])
    with pytest.raises(Forbidden):
        assistant.unmerge_item(tools["t1"])


def test_an_admin_deletes_an_item_that_is_in(db_path, admin_tools):
    deleted = assistant.delete_item(admin_tools["stove"])
    assert deleted == {"item_id": admin_tools["stove"], "deleted": True}
    assert entity(db_path, "item", admin_tools["stove"])["deleted"] is True
    with pytest.raises(NotFound):
        assistant.get_item(admin_tools["stove"])


def test_an_item_that_is_out_cannot_be_deleted(admin_tools):
    assistant.check_out(admin_tools["stove"])
    with pytest.raises(BadRequest):
        assistant.delete_item(admin_tools["stove"])


def test_a_generic_with_units_cannot_be_deleted(admin_tools):
    with pytest.raises(BadRequest):
        assistant.delete_item(admin_tools["tents"])


def test_an_admin_merges_a_duplicate_and_can_undo_it(db_path, admin_tools):
    merged = assistant.merge_items(admin_tools["t1"], admin_tools["stove"])
    assert merged == {"duplicate_id": admin_tools["t1"], "survivor_id": admin_tools["stove"]}
    assert entity(db_path, "item", admin_tools["t1"])["merged_into"] == admin_tools["stove"]
    assert assistant.get_item(admin_tools["t1"])["item_id"] == admin_tools["stove"]

    with pytest.raises(BadRequest):
        assistant.merge_items(admin_tools["t1"], admin_tools["stove"])

    unmerged = assistant.unmerge_item(admin_tools["t1"])
    assert unmerged == {"item_id": admin_tools["t1"], "merged_into": None}
    assert entity(db_path, "item", admin_tools["t1"])["merged_into"] is None


def test_an_item_that_is_out_cannot_be_merged(admin_tools):
    assistant.check_out(admin_tools["t1"])
    with pytest.raises(BadRequest):
        assistant.merge_items(admin_tools["t1"], admin_tools["stove"])


def test_an_item_never_merged_refuses_to_unmerge(admin_tools):
    with pytest.raises(BadRequest, match="not merged"):
        assistant.unmerge_item(admin_tools["stove"])


def test_a_pool_with_stock_out_cannot_be_deleted_or_merged(db_path, admin_tools):
    with open_db(db_path) as conn:
        pool = _new(conn, "item", {"name": "Tent pegs", "generic": True, "pool": True, "quantity": 40})
    assistant.check_out(pool, count=10)
    with pytest.raises(BadRequest):
        assistant.delete_item(pool)
    with pytest.raises(BadRequest):
        assistant.merge_items(pool, admin_tools["stove"])


def test_get_item_shows_the_current_code(db_path, tools):
    with open_db(db_path) as conn:
        events.append_server(conn, ALICE, "code", "ABCDEFGH23", "created", {})
        events.append_server(conn, ALICE, "code", "ABCDEFGH23", "code_bound", {"item_id": tools["stove"]})
    assert assistant.get_item(tools["stove"])["code"] == "ABCDEFGH23"
    assert "code" not in assistant.get_item(tools["t1"])


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


def test_get_item_lists_its_upcoming_reservations(tools):
    """Named directly, named through a generic line, cancelled, or ended (FR-INV-37, FR-RES-13)."""
    named = assistant.create_reservation(**FALL, items=[tools["stove"]])["reservation_id"]
    by_generic = assistant.create_reservation(
        event="Spring camp",
        starts="2026-11-01",
        ends="2026-11-03",
        generics=[{"item_id": tools["tents"], "quantity": 1}],
    )["reservation_id"]
    cancelled = assistant.create_reservation(
        event="Cub camp", starts="2026-12-01", ends="2026-12-03", items=[tools["stove"]]
    )["reservation_id"]
    assistant.cancel_reservation(cancelled)
    assistant.create_reservation(event="Last spring", starts="2020-04-01", ends="2020-04-03", items=[tools["stove"]])

    assert assistant.get_item(tools["stove"])["reservations"] == [
        {"reservation_id": named, "event": "Fall Camp", "starts": "2026-10-02", "ends": "2026-10-04"}
    ]

    # A generic's line reserves the type, not one particular unit: every unit sees it.
    assert [r["reservation_id"] for r in assistant.get_item(tools["t1"])["reservations"]] == [by_generic]
    assert [r["reservation_id"] for r in assistant.get_item(tools["t2"])["reservations"]] == [by_generic]
    assert assistant.get_item(tools["tents"])["reservations"] == [
        {"reservation_id": by_generic, "event": "Spring camp", "starts": "2026-11-01", "ends": "2026-11-03"}
    ]


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


def test_packing_is_derived_from_what_went_out_for_the_reservation(tools):
    made = assistant.create_reservation(
        **FALL, items=[tools["stove"]], generics=[{"item_id": tools["tents"], "quantity": 1}]
    )["reservation_id"]
    assistant.check_out(tools["stove"], event="Fall Camp", reservation_id=made)
    assistant.check_out(tools["t2"], event="Fall Camp", reservation_id=made)

    packed = assistant.get_reservation(made)
    assert [row["name"] for row in packed["packed"]] == ["Camp stove"]
    assert packed["to_pack"] == []
    assert packed["generic_lines"][0]["done"] == 1
    assert packed["fully_packed"] is True


def test_a_check_out_under_the_event_name_alone_packs_nothing(tools):
    made = assistant.create_reservation(**FALL, items=[tools["stove"]])["reservation_id"]
    assistant.check_out(tools["stove"], event="Fall Camp")
    assert [row["name"] for row in assistant.get_reservation(made)["to_pack"]] == ["Camp stove"]


def test_check_out_for_an_unknown_reservation_is_refused(tools):
    with pytest.raises(NotFound):
        assistant.check_out(tools["stove"], reservation_id="01ARZ3NDEKTSV4RRFFQ69G5FAV")


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


# --- admin tools (FR-MCP-10) ------------------------------------------------------------------


def test_admin_tools_refuse_a_user_the_same_way_the_app_does(tools):
    with pytest.raises(Forbidden) as exc:
        assistant.list_users()
    assert exc.value.message == "Admins only"
    with pytest.raises(Forbidden):
        assistant.get_mail()
    with pytest.raises(Forbidden):
        assistant.update_user(ALICE, accounts.UserEdit(name="Not Alice"))
    with pytest.raises(Forbidden):
        assistant.list_calendar_feeds()
    with pytest.raises(Forbidden):
        assistant.add_calendar_feed("https://example.org/feed.ics")
    with pytest.raises(Forbidden):
        assistant.refresh_calendar_feeds()
    with pytest.raises(Forbidden):
        assistant.clear_mail()
    with pytest.raises(Forbidden):
        assistant.add_location("Trailer")
    with pytest.raises(Forbidden):
        assistant.delete_location(tools["warm"])
    with pytest.raises(Forbidden):
        assistant.print_codes()
    with pytest.raises(Forbidden):
        assistant.preview_csv_import("id,kind,name\n")
    with pytest.raises(Forbidden):
        assistant.apply_csv_import("id,kind,name\n")

    # Group settings are an event the sync layer itself gates for `setting` (sync._check_entity_rules),
    # so this one is refused with the app's own rejection reason rather than "Admins only".
    with pytest.raises(BadRequest) as settings_exc:
        assistant.set_group(assistant.GroupFields(name="10th Richmond"))
    assert settings_exc.value.message == "settings are changed by an Admin"


def test_a_user_can_see_their_own_devices_but_not_anyone_elses(tools):
    assert assistant.list_devices(ALICE) == {"devices": []}
    with pytest.raises(Forbidden):
        assistant.list_devices("01ZZZZZZZZZZZZZZZZZZZZZZZZ")


def test_an_admin_invites_promotes_and_deactivates_people(admin_tools, admin_id):
    invited = assistant.invite_user("Bea", "bea@example.org", "user")
    assert invited["token"]
    assert invited["link"] is None  # no site address is set yet (FR-USR-12)
    assert "site address" in invited["note"]
    assert invited["emailed"] is False

    listed = {u["email"]: u for u in assistant.list_users()["users"]}
    assert "bea@example.org" in listed
    bea_id = listed["bea@example.org"]["user_id"]
    assert listed["bea@example.org"]["role"] == "user"

    promoted = assistant.set_user_role(bea_id, "admin")
    assert promoted["user"]["role"] == "admin"

    reset = assistant.reset_link(bea_id)
    assert reset["token"] and reset["token"] != invited["token"]

    deactivated = assistant.set_user_active(bea_id, False)
    assert deactivated["user"]["active"] is False
    reactivated = assistant.set_user_active(bea_id, True)
    assert reactivated["user"]["active"] is True

    # The last Admin cannot be deactivated or demoted (FR-USR-03): it holds once Bea is a User again.
    assistant.set_user_role(bea_id, "user")
    with pytest.raises(Conflict):
        assistant.set_user_active(admin_id, False)
    with pytest.raises(Conflict):
        assistant.set_user_role(admin_id, "user")


def test_an_admin_fixes_a_name_and_an_email(admin_tools, admin_id):
    assistant.invite_user("Bea", "bea@example.org", "user")
    listed = {u["email"]: u for u in assistant.list_users()["users"]}
    bea_id = listed["bea@example.org"]["user_id"]

    fixed = assistant.update_user(bea_id, accounts.UserEdit(name="Beatrice", email="beatrice@example.org"))
    assert fixed["user"]["name"] == "Beatrice"
    assert fixed["user"]["email"] == "beatrice@example.org"

    with pytest.raises(Conflict, match="email"):
        assistant.update_user(bea_id, accounts.UserEdit(email="alex@example.org"))
    with pytest.raises(BadRequest, match="say what to change"):
        assistant.update_user(bea_id, accounts.UserEdit())


def test_devices_are_listed_and_revoked_for_self_or_by_an_admin(admin_tools, admin_id):
    devices = assistant.list_devices(admin_id)["devices"]
    assert [d["device_id"] for d in devices] == ["mcp-01CCCCCCCCCCCCCCCCCCCCCCCC"]

    # Revoking the token making the call is "sign out instead" (accounts.revoke_device's own rule).
    with pytest.raises(Conflict):
        assistant.revoke_device(admin_id, "mcp-01CCCCCCCCCCCCCCCCCCCCCCCC")


def test_an_admin_creates_lists_and_revokes_a_join_link(admin_tools, admin_id):
    made = assistant.create_join_link()
    assert made["token"]
    assert made["url"] is None  # no site address is set yet (FR-USR-19), the same as invite_user
    assert "site address" in made["note"]

    listed = assistant.list_join_links()["links"]
    assert [line["id"] for line in listed] == [made["id"]]
    assert listed[0]["created_by"] == admin_id
    assert "token" not in listed[0]

    assistant.set_group(assistant.GroupFields(code_url="https://example.org/gear"))
    built = assistant.create_join_link(expiry_days=1)
    assert built["url"] == f"https://example.org/gear/join?link={built['token']}"
    assert built["qr_svg"].startswith("<?xml")

    revoked = assistant.revoke_join_link(made["id"])
    assert [line["id"] for line in revoked["links"]] == [built["id"]]


def test_join_links_are_admin_only(tools):
    with pytest.raises(Forbidden):
        assistant.create_join_link()
    with pytest.raises(Forbidden):
        assistant.list_join_links()
    with pytest.raises(Forbidden):
        assistant.revoke_join_link("nope")


class _Mailbox:
    """Every message a local SMTP server accepted, for send_test_mail to be exercised for real."""

    def __init__(self) -> None:
        self.messages: list[email.message.Message] = []

    async def handle_DATA(self, _server, _session, envelope) -> str:  # noqa: N802 (aiosmtpd's name)
        self.messages.append(email.message_from_bytes(envelope.content))
        return "250 OK"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def smtp():
    """A real SMTP server on localhost. Plain, since TLS on localhost tests the certificate store, not us."""
    box = _Mailbox()
    controller = Controller(box, hostname="127.0.0.1", port=_free_port(), auth_require_tls=False)
    controller.start()
    box.port = controller.port
    try:
        yield box
    finally:
        controller.stop()


def test_an_admin_sets_up_mail_and_sends_a_test(admin_tools, smtp):
    assert assistant.get_mail() == {"mail": None}

    saved = assistant.set_mail(host="127.0.0.1", from_address="gear@example.org", port=smtp.port, encryption="none")
    assert saved["mail"]["host"] == "127.0.0.1"
    assert saved["mail"]["has_password"] is False

    sent = assistant.send_test_mail()
    assert sent["sent_to"] == "alex@example.org"
    assert smtp.messages[0]["To"] == "alex@example.org"


def test_an_admin_changes_group_settings(admin_tools):
    assert assistant.get_group() == {"name": "", "code_url": "", "contact": "", "overdue_days": None}

    saved = assistant.set_group(
        assistant.GroupFields(name="10th Richmond", code_url="https://example.org/gear", contact="qm@example.org")
    )
    assert saved == {
        "name": "10th Richmond",
        "code_url": "https://example.org/gear",
        "contact": "qm@example.org",
        "overdue_days": None,
    }

    changed = assistant.set_group(assistant.GroupFields(overdue_days=14))
    assert changed["overdue_days"] == 14
    assert changed["name"] == "10th Richmond"  # untouched


def test_an_admin_manages_calendar_feeds(admin_tools):
    assert assistant.list_calendar_feeds() == {"feeds": []}

    # Port 1 refuses the connection right away, so the feed's own fetch failure is exercised
    # without a real ICS server (calendars.py already covers a successful fetch).
    added = assistant.add_calendar_feed("http://127.0.0.1:1/feed.ics", label="Troop")
    feed = added["feed"]
    assert feed["label"] == "Troop"
    assert feed["url_redacted"] == "http://127.0.0.1:1/feed.ics"
    assert feed["last_error"]

    assert assistant.list_calendar_feeds() == {"feeds": [feed]}

    removed = assistant.remove_calendar_feed(feed["id"])
    assert removed == {"feed_id": feed["id"], "deleted": True}
    assert assistant.list_calendar_feeds() == {"feeds": []}

    with pytest.raises(NotFound):
        assistant.remove_calendar_feed(feed["id"])


def test_an_invite_link_is_built_from_the_group_site_address_once_it_is_set(admin_tools):
    assistant.set_group(assistant.GroupFields(code_url="https://example.org/gear"))
    invited = assistant.invite_user("Bea", "bea@example.org")
    assert invited["link"] == f"https://example.org/gear/join?token={invited['token']}"
    assert "note" not in invited


def test_an_admin_manages_locations_and_categories(db_path, admin_tools):
    added = assistant.add_location("Trailer")
    assert added["name"] == "Trailer"
    renamed = assistant.rename_location(added["location_id"], "Trailer 2")
    assert renamed["name"] == "Trailer 2"
    assert entity(db_path, "location", added["location_id"])["name"] == "Trailer 2"

    added_cat = assistant.add_category("Stoves")
    renamed_cat = assistant.rename_category(added_cat["category_id"], "Camp stoves")
    assert renamed_cat["name"] == "Camp stoves"

    with pytest.raises(NotFound):
        assistant.rename_location("nope", "Somewhere")
    with pytest.raises(NotFound):
        assistant.delete_category("nope")

    deleted = assistant.delete_location(added["location_id"])
    assert deleted == {"location_id": added["location_id"], "deleted": True}
    assert added["location_id"] not in [loc["location_id"] for loc in assistant.list_locations()["locations"]]


def test_deleting_a_location_or_category_still_in_use_is_blocked_and_names_what_uses_it(admin_tools):
    with pytest.raises(Conflict) as loc_exc:
        assistant.delete_location(admin_tools["warm"])
    assert "Camp stove" in loc_exc.value.message

    with pytest.raises(Conflict) as cat_exc:
        assistant.delete_category(admin_tools["tents_cat"])
    assert "4-person tent" in cat_exc.value.message


def test_print_codes_needs_the_group_set_up_first(admin_tools):
    with pytest.raises(Conflict):
        assistant.print_codes()

    assistant.set_group(
        assistant.GroupFields(name="10th Richmond", code_url="https://example.org/gear", contact="qm@example.org")
    )
    made = assistant.print_codes()
    assert len(made["codes"]) == 32  # one sheet, the default
    assert made["pdf_base64"]

    with pytest.raises(BadRequest):
        assistant.print_codes(sheets=11)


def test_csv_export_is_open_to_a_user_but_import_is_admin_only(db_path, who, admin, inventory):
    with assistant.acting_as(who, db_path):
        exported = assistant.export_csv()["csv"]
        assert "Camp stove" in exported
        with pytest.raises(Forbidden):
            assistant.preview_csv_import("id,kind,name\n,single,New tent\n")

    with assistant.acting_as(admin, db_path):
        preview = assistant.preview_csv_import("id,kind,name\n,single,New tent\n")
        assert preview["adds"] == 1
        applied = assistant.apply_csv_import("id,kind,name\n,single,New tent\n")
        assert applied["added"] == 1
        assert "New tent" in assistant.export_csv()["csv"]


def test_anyone_adds_a_category_and_a_repeat_name_returns_the_first(tools):
    first = assistant.add_category("Stoves")
    again = assistant.add_category(" stoves ")
    assert again == first
    with pytest.raises(Forbidden):
        assistant.rename_category(first["category_id"], "Burners")


# --- pools (FR-INV-34 to FR-INV-36, FR-OUT-22 to FR-OUT-24, FR-MCP-08) -----------------------------


@pytest.fixture
def pool_id(db_path, tools) -> str:
    """A pool of tent pegs, 20 on the shelf, alongside the rest of the inventory fixture."""
    with open_db(db_path) as conn:
        return _new(conn, "item", {"name": "Tent pegs", "generic": True, "pool": True, "quantity": 20})


def test_creating_a_pool_implies_generic_and_needs_a_quantity(db_path, tools):
    made = assistant.create_item("Bowls", pool=True, quantity=12)
    assert made["generic"] is True and made["pool"] is True
    stored = entity(db_path, "item", made["item_id"])
    assert stored["pool"] is True and stored["generic"] is True and stored["quantity"] == 12

    with pytest.raises(BadRequest):
        assistant.create_item("Cups", pool=True)  # no quantity
    with pytest.raises(BadRequest):
        assistant.create_item("Plates", quantity=5)  # quantity without pool


def test_a_pools_page_reports_owned_in_and_out_by_holder(tools, pool_id):
    got = assistant.get_item(pool_id)
    assert got["pool"] is True
    assert got["owned"] == 20 and got["in"] == 20 and got["out"] == []
    assert "units" not in got and "code" not in got

    assistant.check_out(pool_id, count=6, event="Fall Camp")
    got = assistant.get_item(pool_id)
    assert got["owned"] == 20 and got["in"] == 14
    assert got["out"] == [{"holder": "Alice", "count": 6}]


def test_a_pools_history_carries_checkouts_and_recounts(tools, pool_id):
    assistant.check_out(pool_id, count=10, event="Fall Camp")
    assistant.recount(pool_id, count=28, reason="shelf count")

    history = assistant.get_item(pool_id)["history"]
    assert [h["type"] for h in history] == ["recounted", "checked_out"]
    assert history[0]["count"] == 28 and history[0]["reason"] == "shelf count"
    assert history[1]["count"] == 10 and history[1]["event"] == "Fall Camp"


def test_search_marks_a_pool_row_and_carries_its_counts(tools, pool_id):
    assistant.check_out(pool_id, count=6)
    rows = {r["name"]: r for r in assistant.search_items()["rows"]}
    assert rows["Tent pegs"]["kind"] == "pool"
    assert rows["Tent pegs"]["owned"] == 20
    assert rows["Tent pegs"]["in"] == 14
    assert rows["Tent pegs"]["out"] == [{"holder": "Alice", "count": 6}]


def test_check_out_and_in_a_pool_move_by_count(tools, pool_id):
    with pytest.raises(BadRequest):
        assistant.check_out(pool_id)  # a pool moves by count
    with pytest.raises(BadRequest):
        assistant.check_out(tools["stove"], count=1)  # count is only for a pool
    with pytest.raises(BadRequest):
        assistant.check_in(tools["stove"], count=1)

    out = assistant.check_out(pool_id, count=6, event="Fall Camp")
    assert out == {"item_id": pool_id, "event": "Fall Camp", "count": 6}

    back = assistant.check_in(pool_id, count=2)
    assert back == {"item_id": pool_id, "count": 2}
    left = assistant.get_item(pool_id)
    assert left["in"] == 16 and left["out"] == [{"holder": "Alice", "count": 4}]

    # Left off, it defaults to what is still out (FR-OUT-23).
    rest = assistant.check_in(pool_id)
    assert rest == {"item_id": pool_id, "count": 4}
    assert assistant.get_item(pool_id)["out"] == []

    with pytest.raises(BadRequest):
        assistant.check_in(pool_id)  # nothing left out


def test_checking_in_more_of_a_pool_than_you_have_out_is_refused(tools, pool_id):
    assistant.check_out(pool_id, count=6)
    with pytest.raises(BadRequest, match="only 6 out"):
        assistant.check_in(pool_id, count=50)
    back = assistant.check_in(pool_id, count=6)
    assert back == {"item_id": pool_id, "count": 6}


def test_taking_more_than_are_in_a_pool_warns_and_does_not_block(tools, pool_id):
    out = assistant.check_out(pool_id, count=25)
    assert out["warning"] == "only 20 were in"
    assert assistant.get_item(pool_id)["in"] == 0


def test_recount_sets_what_is_on_the_shelf_and_leaves_what_is_out(tools, pool_id):
    assistant.check_out(pool_id, count=5)
    result = assistant.recount(pool_id, count=3, reason="shelf count")
    assert result == {"item_id": pool_id, "in": 3, "owned": 8}

    with pytest.raises(BadRequest):
        assistant.recount(tools["stove"], count=1, reason="why not")
    with pytest.raises(BadRequest):
        assistant.recount(pool_id, count=1, reason="   ")


def test_a_reservation_records_who_created_it_and_when(tools):
    made = assistant.create_reservation(**FALL)["reservation_id"]
    got = assistant.get_reservation(made)
    assert got["created_by"] == "Alice"
    assert got["added_at"] is not None

    listed = assistant.list_reservations()["reservations"][0]
    assert listed["created_by"] == "Alice"
    assert listed["added_at"] == got["added_at"]


def test_assign_code_binds_a_printed_code_to_a_unit(db_path, tools):
    with pytest.raises(BadRequest):
        assistant.assign_code("not a code", tools["stove"])
    with pytest.raises(NotFound):
        assistant.assign_code("ABCDEFGH23", tools["stove"])

    with open_db(db_path) as conn:
        events.append_server(conn, ALICE, "code", "ABCDEFGH23", "created", {})

    with pytest.raises(BadRequest):
        assistant.assign_code("ABCDEFGH23", tools["tents"])  # a generic takes no code
    assert assistant.assign_code("ABCDEFGH23", tools["stove"]) == {"item_id": tools["stove"], "code": "ABCDEFGH23"}
    assert entity(db_path, "code", "ABCDEFGH23")["item_id"] == tools["stove"]

    with pytest.raises(Conflict):
        assistant.assign_code("ABCDEFGH23", tools["stove"])


def test_retire_item_and_bring_it_back(db_path, tools):
    assert assistant.retire_item(tools["stove"]) == {"item_id": tools["stove"], "retired": True}
    assert entity(db_path, "item", tools["stove"])["retired"] is True
    assert assistant.retire_item(tools["stove"])["already"] is True
    assert assistant.retire_item(tools["stove"], retired=False) == {"item_id": tools["stove"], "retired": False}
    assert entity(db_path, "item", tools["stove"])["retired"] is False


def test_retire_generic_needs_its_units_retired_first(db_path, tools):
    with pytest.raises(BadRequest):
        assistant.retire_item(tools["tents"])
    for key in ("t1", "t2", "t3"):
        assistant.retire_item(tools[key])
    assert assistant.retire_item(tools["tents"])["retired"] is True


def test_found_reports_are_listed_until_resolved(db_path, tools):
    assert assistant.list_found_reports() == {"reports": []}
    with open_db(db_path) as conn:
        report = {"code": "ABCDEFGH23", "item_id": tools["stove"], "note": "By the gate", "contact": "555-0100"}
        events.append_server(conn, "public", "found_report", "01REPORT00000000000000000A", "created", report)

    listed = assistant.list_found_reports()["reports"]
    assert len(listed) == 1
    assert listed[0]["report_id"] == "01REPORT00000000000000000A"
    assert listed[0]["item"] == "Camp stove"
    assert listed[0]["note"] == "By the gate"

    resolved = assistant.resolve_found_report("01REPORT00000000000000000A")
    assert resolved == {"report_id": "01REPORT00000000000000000A", "resolved": True}
    assert assistant.list_found_reports() == {"reports": []}
    assert assistant.resolve_found_report("01REPORT00000000000000000A")["already"] is True
    with pytest.raises(NotFound):
        assistant.resolve_found_report("nope")


def test_notification_categories_round_trip(admin_tools):
    before = assistant.get_notifications()
    assert before["categories"] == {"found": False, "repair": False, "joined": False}
    assert before["mail_configured"] is False

    saved = assistant.set_notifications(notify.Preferences(found=True, repair=False, joined=True))
    assert saved["categories"] == {"found": True, "repair": False, "joined": True}
    assert assistant.get_notifications()["categories"] == saved["categories"]


def test_link_out_to_reservation_corrects_the_movement_and_adds_the_item(db_path, tools):
    stove = tools["stove"]
    rid = assistant.create_reservation(**FALL)["reservation_id"]
    with pytest.raises(BadRequest):
        assistant.link_out_to_reservation(rid, stove)  # not out yet

    assistant.check_out(stove, event="camp")
    linked = assistant.link_out_to_reservation(rid, stove)
    assert linked == {"reservation_id": rid, "item_id": stove, "corrected": True}

    item = entity(db_path, "item", stove)
    assert item["movement"]["event"] == FALL["event"]
    assert item["movement"]["reservation_id"] == rid
    assert stove in entity(db_path, "reservation", rid)["items"]

    assert assistant.link_out_to_reservation(rid, stove)["corrected"] is False


def test_clear_mail_forgets_the_account(admin_tools):
    assistant.set_mail(host="mail.example.org", from_address="gear@example.org", password="x")
    assert assistant.get_mail()["mail"] is not None
    assert assistant.clear_mail() == {"mail": None}
    assert assistant.get_mail()["mail"] is None


def test_refresh_calendar_feeds_reports_each_feed(admin_tools):
    assistant.add_calendar_feed("http://127.0.0.1:1/feed.ics", label="Troop")
    feeds = assistant.refresh_calendar_feeds()["feeds"]
    assert len(feeds) == 1
    assert feeds[0]["label"] == "Troop"
    assert feeds[0]["last_error"]
