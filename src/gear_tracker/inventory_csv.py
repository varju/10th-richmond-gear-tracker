"""CSV export and import of the inventory (FR-RPT-03, NFR-DATA-10, FR-SET-11).

Export reads derived state; nothing here writes for it. Import is a plan, built and
checked against a snapshot before anything is written (`plan`), then applied as
ordinary events, authored by the server as the Admin who ran it (`apply`).
"""

from __future__ import annotations

import csv
import io
import re
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from gear_tracker import derived, events, views
from gear_tracker.errors import BadRequest
from gear_tracker.replay import State
from gear_tracker.ulid import new_ulid

COLUMNS = [
    "id",
    "kind",
    "name",
    "generic",
    "number",
    "nickname",
    "category",
    "home",
    "shelf",
    "description",
    "purchase_date",
    "price",
    "retired",
    "code",
    "status",
    "holder",
    "quantity",
    "in",
    "out",
]

EDITABLE = (
    "name",
    "number",
    "nickname",
    "category",
    "home",
    "shelf",
    "description",
    "purchase_date",
    "price",
    "retired",
)

IGNORED_COLUMNS = frozenset({"supplier"})
"""Accepted on import but no longer read or written (FR-INV-12). An old export may still have it."""

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

BOM = "\ufeff"

INJECTION_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
"""A leading character a spreadsheet reads as "this cell is a formula" (CWE-1236).
A stored name starting with one, opened by an Admin, would run as code."""


def _safe(text: str) -> str:
    """`text`, with a leading quote added if it would otherwise be read as a formula."""
    return f"'{text}" if text.startswith(INJECTION_PREFIXES) else text


def _unsafe(text: str) -> str:
    """Undo `_safe`: drop a leading quote that exists only to defuse the character after it."""
    if len(text) >= 2 and text[0] == "'" and text[1] in INJECTION_PREFIXES:
        return text[1:]
    return text


# --- export -------------------------------------------------------------------------------


def export(state: State) -> str:
    """Every item that is not deleted or merged, retired ones included.

    Order: generics and singles sorted by display name, each generic followed by its
    units in number order — the same grouping `views.rows()` uses, but with both
    retired and live items in one list instead of split by the UI's filters.
    """
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(COLUMNS)
    for it in _ordered(state):
        writer.writerow(_row(state, it))
    return BOM + buf.getvalue()


def _ordered(state: State) -> list[dict[str, Any]]:
    top = [it for it in views.items(state) if not it.get("merged_into") and not it.get("parent_id")]
    top.sort(key=lambda it: views.display_name(state, it))
    ordered = []
    for it in top:
        ordered.append(it)
        if it.get("generic"):
            ordered.extend(views.units_of(state, it["id"]))
    return ordered


def _row(state: State, it: dict[str, Any]) -> list[str]:
    is_unit = bool(it.get("parent_id"))
    parent = views.item(state, it["parent_id"]) if is_unit else None
    is_pool = views.is_pool(it)
    kind = "unit" if is_unit else ("pool" if is_pool else ("generic" if it.get("generic") else "single"))
    status = "" if it.get("generic") else (it.get("status") or "")
    price = it.get("price")
    counts = views.pool_counts(it) if is_pool else None
    return [
        it["id"],
        kind,
        "" if is_unit else _safe(it.get("name") or ""),
        _safe((parent or {}).get("name") or "") if is_unit else "",
        (it.get("number") or "") if is_unit else "",
        _safe(it.get("nickname") or "") if is_unit else "",
        "" if is_unit else _safe("; ".join(views.category_name(state, cid) for cid in views.categories_of(state, it))),
        _safe(views.location_name(state, it.get("home_location_id"))),
        _safe(it.get("sub_location") or ""),
        _safe(it.get("description") or ""),
        it.get("purchase_date") or "",
        "" if price is None else str(price),
        "yes" if it.get("retired") else "",
        _code_for(state, it["id"]) or "",
        status,
        _safe(views.user_name(state, it.get("holder_id"))) if status == "out" else "",
        "" if counts is None else str(counts["owned"]),
        "" if counts is None else str(counts["in"]),
        "" if counts is None else str(sum(o["count"] for o in counts["out"])),
    ]


def _code_for(state: State, item_id: str) -> str | None:
    return views.current_code(state, item_id)


# --- plan -----------------------------------------------------------------------------


@dataclass
class Plan:
    adds: list[dict[str, Any]] = field(default_factory=list)
    changes: list[dict[str, Any]] = field(default_factory=list)
    unchanged: int = 0
    new_locations: list[str] = field(default_factory=list)
    new_categories: list[str] = field(default_factory=list)
    errors: list[dict[str, Any]] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        rows = [{"row": a["row"], "action": "add", "name": _add_name(a), "changes": []} for a in self.adds]
        rows += [
            {
                "row": c["row"],
                "action": "change",
                "name": c["name"],
                "changes": [
                    {"field": ch["field"], "old": ch["old_display"], "new": ch["new_display"]} for ch in c["changes"]
                ],
            }
            for c in self.changes
        ]
        rows.sort(key=lambda r: r["row"])
        return {
            "adds": len(self.adds),
            "changes": len(self.changes),
            "unchanged": self.unchanged,
            "new_locations": list(self.new_locations),
            "new_categories": list(self.new_categories),
            "rows": rows,
            "errors": [dict(e) for e in self.errors],
        }


def _add_name(a: dict[str, Any]) -> str:
    payload = a["payload"]
    if a["kind"] == "unit":
        return f"{payload.get('generic', '')} #{payload.get('number', '')}"
    if a["kind"] == "pool":
        return f"{payload.get('name', '')} (pool of {payload.get('quantity', 0)})"
    return payload.get("name", "")


def plan(state: State, text: str) -> Plan:
    """Parse and validate a file against a snapshot. Never writes anything."""
    p = Plan()
    rows = list(csv.reader(io.StringIO(text.removeprefix(BOM))))
    if not rows:
        return p

    cols = [c.strip().lower() for c in rows[0]]
    unknown = next((c for c in cols if c not in COLUMNS and c not in IGNORED_COLUMNS), None)
    if unknown is not None:
        p.errors.append({"row": 1, "message": f"unknown column {unknown!r}"})
        return p
    seen_cols: set[str] = set()
    for name in cols:
        if name in seen_cols:
            p.errors.append({"row": 1, "message": f"column {name!r} appears twice"})
            return p
        seen_cols.add(name)
    idx = {name: i for i, name in enumerate(cols)}
    data_rows: list[tuple[int, list[str]]] = []
    for n, raw in enumerate(rows[1:], start=2):
        padded = _pad(raw, len(cols))
        if any(cell.strip() for cell in padded):  # a blank line (an Excel trailer, say) is not a row
            data_rows.append((n, padded))

    existing_locations = {loc["name"]: loc["id"] for loc in views.locations(state)}
    existing_categories = {cat["name"]: cat["id"] for cat in views.categories(state)}
    existing_generics = {
        it["name"]: it["id"]
        for it in views.items(state)
        if it.get("generic") and not views.is_pool(it) and not it.get("merged_into")
    }
    existing_pools = {it["name"] for it in views.items(state) if views.is_pool(it) and not it.get("merged_into")}

    # A unit-add row may name a generic that is itself an add elsewhere in the file.
    # A generic row with a quantity becomes a pool (FR-INV-34) and is never a valid parent.
    file_generics: dict[str, list[int]] = {}
    file_pools: set[str] = set()
    for row_num, vals in data_rows:
        if _cell(vals, idx, "id"):
            continue
        if (_cell(vals, idx, "kind") or "").lower() == "generic":
            name = _cell(vals, idx, "name")
            if not name:
                continue
            if _cell(vals, idx, "quantity"):
                file_pools.add(name)
            else:
                file_generics.setdefault(name, []).append(row_num)
    pools = existing_pools | file_pools

    used_numbers: dict[str, set[str]] = {
        name: {_number(u) for u in views.units_of(state, gid)} for name, gid in existing_generics.items()
    }

    for row_num, vals in data_rows:
        item_id = _cell(vals, idx, "id")
        if item_id:
            _plan_change(state, p, row_num, item_id, vals, idx, existing_locations, existing_categories)
        else:
            _plan_add(
                p,
                row_num,
                vals,
                idx,
                existing_locations,
                existing_categories,
                existing_generics,
                file_generics,
                pools,
                used_numbers,
            )
    return p


def _pad(row: list[str], width: int) -> list[str]:
    return row + [""] * (width - len(row)) if len(row) < width else row


def _cell(vals: list[str], idx: dict[str, int], name: str) -> str | None:
    """The cell's text, stripped and unescaped — or None if the column is not in the header at all."""
    i = idx.get(name)
    return None if i is None else _unsafe(vals[i].strip())


def _number(it: dict[str, Any]) -> str:
    """Events written early hold a whole number; the file always holds text."""
    return str(it.get("number") or "").strip()


def _parse_bool(text: str) -> bool | None:
    t = text.lower()
    if t in ("yes", "true", "1"):
        return True
    if t in ("no", "false", "0"):
        return False
    return None


# --- id rows: changes -------------------------------------------------------------------


def _plan_change(
    state: State,
    p: Plan,
    row_num: int,
    item_id: str,
    vals: list[str],
    idx: dict[str, int],
    existing_locations: dict[str, str],
    existing_categories: dict[str, str],
) -> None:
    it = (state.get("item") or {}).get(item_id)
    if it is None or it.get("deleted"):
        p.errors.append({"row": row_num, "message": f"no such item {item_id!r}"})
        return
    is_unit = bool(it.get("parent_id"))
    kind = "unit" if is_unit else ("pool" if it.get("pool") else ("generic" if it.get("generic") else "single"))

    given_kind = _cell(vals, idx, "kind")
    if given_kind and given_kind.lower() != kind:
        p.errors.append({"row": row_num, "message": f"the item is a {kind}, not {given_kind}"})
        return

    if is_unit:
        given_generic = _cell(vals, idx, "generic")
        if given_generic:
            parent = views.item(state, it["parent_id"])
            if not parent or parent.get("name") != given_generic:
                p.errors.append({"row": row_num, "message": "moving a unit to another generic is done in the app"})
                return
        if _cell(vals, idx, "name"):
            p.errors.append({"row": row_num, "message": "a unit takes its name from its generic"})
            return
        if _cell(vals, idx, "category"):
            p.errors.append({"row": row_num, "message": "a unit takes its generic's categories"})
            return
    else:
        for col in ("number", "nickname"):
            if _cell(vals, idx, col):
                p.errors.append({"row": row_num, "message": f"{col} applies only to a unit"})
                return

    changes = []
    for col in EDITABLE:
        if col not in idx:
            continue
        if is_unit and col in ("name", "category"):
            continue
        if not is_unit and col in ("number", "nickname"):
            continue
        change = _diff_field(state, p, row_num, it, col, _cell(vals, idx, col), existing_locations, existing_categories)
        if change is not None:
            changes.append(change)

    if changes:
        name = views.display_name(state, it)
        p.changes.append({"row": row_num, "item_id": item_id, "name": name, "changes": changes})
    else:
        p.unchanged += 1


def _diff_field(
    state: State,
    p: Plan,
    row_num: int,
    it: dict[str, Any],
    col: str,
    cell: str | None,
    existing_locations: dict[str, str],
    existing_categories: dict[str, str],
) -> dict[str, Any] | None:
    """One editable column against the item's current value. None if unchanged; else a change,
    recorded with both a display form (for the preview) and a raw stored form (for `apply`)."""
    if col == "name":
        if cell == "":
            p.errors.append({"row": row_num, "message": "name may not be cleared"})
            return None
        old = it.get("name") or ""
        return None if cell == old else _change("name", old, cell, it.get("name"), cell)
    if col == "number":
        if cell == "":
            p.errors.append({"row": row_num, "message": "number may not be cleared"})
            return None
        old = _number(it)
        return None if cell == old else _change("number", old, cell, it.get("number"), cell)
    if col == "nickname":
        old = it.get("nickname")
        new = cell or None
        return None if (old or None) == new else _change("nickname", old or "", new or "", old, new)
    if col == "category":
        return _diff_categories(state, p, it, cell, existing_categories)
    if col == "home":
        return _diff_named(
            state,
            it.get("home_location_id"),
            cell,
            existing_locations,
            p.new_locations,
            "home_location_id",
            views.location_name,
        )
    if col == "shelf":
        old = it.get("sub_location")
        new = cell or None
        return None if (old or None) == new else _change("sub_location", old or "", new or "", old, new)
    if col == "description":
        old = it.get("description")
        new = cell or None
        return None if (old or None) == new else _change("description", old or "", new or "", old, new)
    if col == "purchase_date":
        old = it.get("purchase_date")
        if not cell:
            return None if old is None else _change("purchase_date", old, "", old, None)
        if not DATE_RE.match(cell):
            p.errors.append({"row": row_num, "message": f"purchase_date {cell!r} is not YYYY-MM-DD"})
            return None
        return None if cell == old else _change("purchase_date", old or "", cell, old, cell)
    if col == "price":
        old = it.get("price")
        old_display = "" if old is None else str(old)
        if not cell:
            return None if old is None else _change("price", old_display, "", old, None)
        try:
            value = float(cell)
        except ValueError:
            p.errors.append({"row": row_num, "message": f"price {cell!r} is not a number"})
            return None
        if value < 0:
            p.errors.append({"row": row_num, "message": "price must not be negative"})
            return None
        if old is not None and float(old) == value:
            return None
        return _change("price", old_display, str(value), old, value)
    if col == "retired":
        old = bool(it.get("retired"))
        if not cell:
            new = False
        else:
            parsed = _parse_bool(cell)
            if parsed is None:
                p.errors.append({"row": row_num, "message": f"retired {cell!r} must be yes/no/true/false/1/0 or blank"})
                return None
            new = parsed
        return None if new == old else _change("retired", "yes" if old else "", "yes" if new else "", old, new)
    raise AssertionError(col)  # every EDITABLE column is handled above


def _diff_named(
    state: State,
    old_id: str | None,
    cell: str | None,
    existing: dict[str, str],
    new_names: list[str],
    field_name: str,
    name_of,
) -> dict[str, Any] | None:
    old_display = name_of(state, old_id) if old_id else ""
    if not cell:
        return None if old_id is None else _change(field_name, old_display, "", old_id, None)
    if cell == old_display:
        return None
    if cell not in existing and cell not in new_names:
        new_names.append(cell)
    return _change(field_name, old_display, cell, old_id, cell)


def _diff_categories(
    state: State, p: Plan, it: dict[str, Any], cell: str | None, existing_categories: dict[str, str]
) -> dict[str, Any] | None:
    """The cell is several names joined with ";"; compared to the item's current names as a set."""
    old_ids = views.categories_of(state, it)
    old_names = [views.category_name(state, cid) for cid in old_ids]
    new_names = sorted({name.strip() for name in (cell or "").split(";") if name.strip()})
    if set(new_names) == set(old_names):
        return None
    for name in new_names:
        if name not in existing_categories and name not in p.new_categories:
            p.new_categories.append(name)
    return _change("category_ids", "; ".join(old_names), "; ".join(new_names), old_ids, new_names)


def _change(field_name: str, old_display: Any, new_display: Any, old_raw: Any, new_raw: Any) -> dict[str, Any]:
    return {
        "field": field_name,
        "old_display": old_display,
        "new_display": new_display,
        "old_raw": old_raw,
        "new_raw": new_raw,
    }


# --- rows with no id: adds ---------------------------------------------------------------


def _plan_add(
    p: Plan,
    row_num: int,
    vals: list[str],
    idx: dict[str, int],
    existing_locations: dict[str, str],
    existing_categories: dict[str, str],
    existing_generics: dict[str, str],
    file_generics: dict[str, list[int]],
    pools: set[str],
    used_numbers: dict[str, set[str]],
) -> None:
    kind = (_cell(vals, idx, "kind") or "").lower()
    if not kind:
        p.errors.append({"row": row_num, "message": "kind is required"})
        return
    if kind not in ("single", "generic", "unit", "pool"):
        p.errors.append({"row": row_num, "message": f"unknown kind {kind!r}"})
        return

    if kind in ("single", "generic", "pool"):
        name = _cell(vals, idx, "name")
        if not name:
            p.errors.append({"row": row_num, "message": "name is required"})
            return
        quantity_cell = _cell(vals, idx, "quantity")
        if kind == "pool" and not quantity_cell:
            p.errors.append({"row": row_num, "message": "quantity is required for a pool"})
            return
        quantity: int | None = None
        if quantity_cell:
            if kind == "single":
                p.errors.append(
                    {"row": row_num, "message": "quantity is only for a generic (a pool must be generic, FR-INV-34)"}
                )
                return
            if _cell(vals, idx, "code"):
                p.errors.append({"row": row_num, "message": "a pool takes no code (FR-INV-34)"})
                return
            try:
                quantity = int(quantity_cell)
            except ValueError:
                p.errors.append({"row": row_num, "message": f"quantity {quantity_cell!r} is not a whole number"})
                return
            if quantity < 0:
                p.errors.append({"row": row_num, "message": "quantity must not be negative"})
                return
        payload: dict[str, Any] = {"name": name}
        row_kind = kind
        if kind in ("generic", "pool"):
            payload["generic"] = True
        if quantity is not None:
            payload["pool"] = True
            payload["quantity"] = quantity
            row_kind = "pool"
        if not _add_optional(p, row_num, vals, idx, payload, existing_locations, existing_categories, unit=False):
            return
        p.adds.append({"row": row_num, "kind": row_kind, "payload": payload})
        return

    if _cell(vals, idx, "quantity"):
        p.errors.append({"row": row_num, "message": "a pool has no units (FR-INV-34)"})
        return

    generic_name = _cell(vals, idx, "generic")
    if not generic_name:
        p.errors.append({"row": row_num, "message": "generic is required"})
        return
    if generic_name in pools:
        p.errors.append({"row": row_num, "message": "a pool has no units (FR-INV-34)"})
        return
    candidates = (1 if generic_name in existing_generics else 0) + len(file_generics.get(generic_name, []))
    if candidates == 0:
        p.errors.append({"row": row_num, "message": f"no such generic {generic_name!r}"})
        return
    if candidates > 1:
        p.errors.append({"row": row_num, "message": f"two generics named {generic_name!r}"})
        return

    number = _cell(vals, idx, "number")
    if not number:
        p.errors.append({"row": row_num, "message": "number is required"})
        return
    seen = used_numbers.setdefault(generic_name, set())
    if number in seen:
        p.errors.append({"row": row_num, "message": f"two units numbered {number!r} for {generic_name!r}"})
        return
    seen.add(number)

    payload = {"generic": generic_name, "number": number}
    if not _add_optional(p, row_num, vals, idx, payload, existing_locations, existing_categories, unit=True):
        return
    p.adds.append({"row": row_num, "kind": "unit", "payload": payload})


def _add_optional(
    p: Plan,
    row_num: int,
    vals: list[str],
    idx: dict[str, int],
    payload: dict[str, Any],
    existing_locations: dict[str, str],
    existing_categories: dict[str, str],
    unit: bool,
) -> bool:
    """Every optional editable column that applies to this kind, set on `payload` when given.

    `home`/`category` are kept as names; `apply` resolves them once every new one exists.
    Returns False (with an error recorded) if a cell fails validation.
    """
    if unit:
        nickname = _cell(vals, idx, "nickname")
        if nickname:
            payload["nickname"] = nickname
    else:
        category = _cell(vals, idx, "category")
        if category:
            names = sorted({name.strip() for name in category.split(";") if name.strip()})
            for name in names:
                if name not in existing_categories and name not in p.new_categories:
                    p.new_categories.append(name)
            payload["category"] = names

    home = _cell(vals, idx, "home")
    if home:
        if home not in existing_locations and home not in p.new_locations:
            p.new_locations.append(home)
        payload["home"] = home

    shelf = _cell(vals, idx, "shelf")
    if shelf:
        payload["sub_location"] = shelf

    description = _cell(vals, idx, "description")
    if description:
        payload["description"] = description

    purchase_date = _cell(vals, idx, "purchase_date")
    if purchase_date:
        if not DATE_RE.match(purchase_date):
            p.errors.append({"row": row_num, "message": f"purchase_date {purchase_date!r} is not YYYY-MM-DD"})
            return False
        payload["purchase_date"] = purchase_date

    price = _cell(vals, idx, "price")
    if price:
        try:
            value = float(price)
        except ValueError:
            p.errors.append({"row": row_num, "message": f"price {price!r} is not a number"})
            return False
        if value < 0:
            p.errors.append({"row": row_num, "message": "price must not be negative"})
            return False
        payload["price"] = value

    retired = _cell(vals, idx, "retired")
    if retired:
        parsed = _parse_bool(retired)
        if parsed is None:
            p.errors.append({"row": row_num, "message": f"retired {retired!r} must be yes/no/true/false/1/0 or blank"})
            return False
        if parsed:
            payload["retired"] = True

    return True


# --- apply ------------------------------------------------------------------------------


def apply(conn: sqlite3.Connection, text: str, actor_id: str, now: int | None = None) -> dict[str, Any]:
    """Write a plan's adds and changes as events, authored by the server as `actor_id`.

    Everything is checked, via `plan`, before the first write — one bad row stops the
    whole file rather than leaving a half-applied import.
    """
    now = events.now_ms() if now is None else now
    state = derived.snapshot(conn)
    p = plan(state, text)
    if p.errors:
        shown = p.errors[:5]
        message = "; ".join(f"row {e['row']}: {e['message']}" for e in shown)
        if len(p.errors) > 5:
            message += f" ... and {len(p.errors) - 5} more"
        raise BadRequest(message)

    locations = {loc["name"]: loc["id"] for loc in views.locations(state)}
    categories = {cat["name"]: cat["id"] for cat in views.categories(state)}
    generics = {
        it["name"]: it["id"]
        for it in views.items(state)
        if it.get("generic") and not views.is_pool(it) and not it.get("merged_into")
    }

    # One transaction for the whole file: a failure on any row rolls every earlier
    # write in this import back too, so a bad row never leaves a half-applied file.
    conn.execute("BEGIN IMMEDIATE")
    try:
        for name in p.new_locations:
            locations[name] = _created(conn, actor_id, "location", {"name": name}, now)
        for name in p.new_categories:
            categories[name] = _created(conn, actor_id, "category", {"name": name}, now)

        added = 0
        for a in p.adds:
            if a["kind"] != "generic":
                continue
            item_id = _created(conn, actor_id, "item", _resolve_payload(a["payload"], locations, categories), now)
            generics[a["payload"]["name"]] = item_id
            added += 1

        for a in p.adds:
            if a["kind"] == "generic":
                continue
            payload = dict(a["payload"])
            if a["kind"] == "unit":
                payload["parent_id"] = generics[payload.pop("generic")]
            _created(conn, actor_id, "item", _resolve_payload(payload, locations, categories), now)
            added += 1

        for c in p.changes:
            for ch in c["changes"]:
                value = ch["new_raw"]
                if ch["field"] == "home_location_id" and value is not None:
                    value = locations[value]
                elif ch["field"] == "category_ids" and value is not None:
                    value = [categories[name] for name in value]
                events.append_server(
                    conn,
                    actor_id,
                    "item",
                    c["item_id"],
                    "field_changed",
                    {"field": ch["field"], "value": value, "old": ch["old_raw"]},
                    now,
                )
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise

    return {
        "added": added,
        "changed": len(p.changes),
        "created_locations": list(p.new_locations),
        "created_categories": list(p.new_categories),
    }


def _resolve_payload(payload: dict[str, Any], locations: dict[str, str], categories: dict[str, str]) -> dict[str, Any]:
    resolved = dict(payload)
    if "home" in resolved:
        resolved["home_location_id"] = locations[resolved.pop("home")]
    if "category" in resolved:
        resolved["category_ids"] = [categories[name] for name in resolved.pop("category")]
    return resolved


def _created(conn: sqlite3.Connection, actor_id: str, entity_type: str, payload: dict[str, Any], now: int) -> str:
    entity_id = new_ulid(now)
    events.append_server(conn, actor_id, entity_type, entity_id, "created", payload, now)
    return entity_id
