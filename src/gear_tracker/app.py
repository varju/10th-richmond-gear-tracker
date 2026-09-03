"""HTTP in front of sync.py and accounts.py. JSON in and out.

create_app takes an `authenticate` callable so tests can say who is calling
without a password. The default is the real one: a bearer token from
accounts.authenticate.
"""

import json
import sqlite3
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Body, Depends, FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import Field, StringConstraints

from gear_tracker import accounts, assistant, codes, derived, events, inventory_csv, labels, mail, sync
from gear_tracker.db import connect
from gear_tracker.errors import ApiError, BadRequest, Conflict, Deactivated, NotFound, TooLarge, TooMany, Unauthorized
from gear_tracker.events import PHOTO_ENTITIES, PHOTO_TYPES, PUBLIC_ACTOR, Strict, now_ms
from gear_tracker.ratelimit import RateLimit
from gear_tracker.sync import Principal, _require_active
from gear_tracker.ulid import is_ulid, new_ulid

Authenticator = Callable[[Request, sqlite3.Connection], Principal | None]
LinkKind = Literal["invite", "reset"]

HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS

PHOTO_MAX_BYTES = 5 * 1024 * 1024
"""A phone shrinks a photo before sending it; this is the ceiling for one that did not."""

PHOTO_EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

FOUND_PER_ADDRESS = (5, HOUR_MS)
FOUND_PER_CODE = (3, DAY_MS)
FOUND_IN_ALL = (30, HOUR_MS)
"""How often a stranger may report gear found (FR-PUB-04): per address, per sticker, and in total."""


def client_address(request: Request) -> str:
    """The first hop of X-Forwarded-For when a proxy is in front, as in deployment; else the peer."""
    first = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    return first or (request.client.host if request.client else "?")


def group_name(conn: sqlite3.Connection) -> str:
    return (derived.get_entity(conn, "setting", "group") or {}).get("name") or ""


def bearer(request: Request) -> str | None:
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    return token if scheme.lower() == "bearer" and token else None


def by_token(request: Request, conn: sqlite3.Connection) -> Principal | None:
    return accounts.authenticate(conn, bearer(request))


def create_app(
    db_path: str | Path,
    authenticate: Authenticator = by_token,
    static: str | Path | None = None,
    photos: str | Path | None = None,
) -> FastAPI:
    """`static` is the built client (client/dist). Without it the server is API only, as in development.

    `photos` is the file store (FR-INV-11). By default a directory beside the database, so
    whatever backs up the one backs up the other.
    """
    # The assistant's endpoint, and the transport it needs running behind it (FR-MCP-01).
    mcp = assistant.Endpoint(db_path, authenticate)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        async with mcp.session_manager.run():
            yield

    app = FastAPI(title="Gear Tracker", lifespan=lifespan)
    app.router.routes.append(assistant.route(mcp))
    photo_dir = Path(photos) if photos is not None else Path(db_path).parent / "photos"

    # In memory, in this process. One uvicorn worker serves the group, so that is the whole picture.
    found_limits = {
        "address": RateLimit(*FOUND_PER_ADDRESS),
        "code": RateLimit(*FOUND_PER_CODE),
        "all": RateLimit(*FOUND_IN_ALL),
    }

    def db() -> Iterator[sqlite3.Connection]:
        conn = connect(db_path)
        try:
            yield conn
        finally:
            conn.close()

    Db = Annotated[sqlite3.Connection, Depends(db)]

    def principal(request: Request, conn: Db) -> Principal:
        p = authenticate(request, conn)
        if p is None:
            raise Unauthorized("sign in first")
        return p

    Who = Annotated[Principal, Depends(principal)]

    def error(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse({"error": code, "message": message, "server_time": now_ms()}, status_code=status)

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return error(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0]
        loc = ".".join(str(part) for part in first["loc"] if part != "body")
        return error(400, "bad_request", f"{loc}: {first['msg']}")

    def stamped(payload: dict[str, Any]) -> dict[str, Any]:
        return {**payload, "server_time": now_ms()}

    def posted(conn: sqlite3.Connection, kind: LinkKind, to: str, link: str | None) -> dict[str, Any]:
        """Try to mail a one-time link (FR-USR-15).

        Never fatal. The link is in the reply either way, so a wrong SMTP
        password costs an Admin a copy and paste, not the invite (FR-USR-12).
        """
        if link is None or not mail.configured(conn):
            return {"emailed": False}
        subject, body = mail.link_message(kind, group_name(conn), link)
        try:
            mail.send(conn, to, subject, body)
        except ApiError as exc:
            return {"emailed": False, "mail_error": exc.message}
        return {"emailed": True}

    # --- sync ---------------------------------------------------------------------

    @app.get("/sync/bootstrap")
    def bootstrap(conn: Db, who: Who) -> dict[str, Any]:
        return sync.bootstrap(conn, who)

    @app.post("/sync/push")
    def push(request: Request, conn: Db, who: Who, body: Annotated[Any, Body()]) -> dict[str, Any]:
        result = sync.push(conn, who, body)
        if not who.active:
            # That was the one push a deactivated account gets (FR-OFF-06). The session ends here.
            accounts.sign_out(conn, bearer(request) or "")
        return result

    @app.get("/sync/pull")
    def pull(
        conn: Db,
        who: Who,
        since: Annotated[int, Query(ge=0)],
        log: Annotated[str | None, Query()] = None,
    ) -> dict[str, Any]:
        return sync.pull(conn, who, since, log=log)

    # --- history -----------------------------------------------------------------

    def _entity_type(entity_type: str) -> str:
        if entity_type not in events.ENTITY_TYPES:
            raise BadRequest(f"entity_type must be one of {', '.join(sorted(events.ENTITY_TYPES))}")
        return entity_type

    @app.get("/history/{entity_type}/{entity_id}")
    def history(conn: Db, _who: Who, entity_type: str, entity_id: str) -> dict[str, Any]:
        """One entity's whole slice of the log, in replay order (FR-INV-31).

        A device keeps 90 days (NFR-DATA-03); the server keeps everything. The
        events are shaped as pull sends them, so the screen that renders what
        the device holds renders this without knowing the difference. A merged
        duplicate is its own entity, so a reader that follows the pointer asks
        again for that id.
        """
        return stamped(
            {"events": [asdict(e) for e in events.in_replay_order(conn, _entity_type(entity_type), entity_id)]}
        )

    @app.get("/history/{entity_type}")
    def history_of_type(conn: Db, _who: Who, entity_type: str) -> dict[str, Any]:
        """Every event of one kind, in replay order. The repair report reads its whole record this way."""
        return stamped({"events": [asdict(e) for e in events.in_replay_order(conn, _entity_type(entity_type))]})

    # --- auth ----------------------------------------------------------------------

    def session_response(session: accounts.Session) -> dict[str, Any]:
        return stamped({"token": session.token, "user": session.user})

    @app.post("/auth/sign-in")
    def sign_in(conn: Db, body: accounts.SignIn) -> dict[str, Any]:
        return session_response(accounts.sign_in(conn, body))

    @app.post("/auth/redeem")
    def redeem(conn: Db, body: accounts.Redeem) -> dict[str, Any]:
        return session_response(accounts.redeem(conn, body))

    @app.post("/auth/sign-out")
    def sign_out(request: Request, conn: Db, _who: Who) -> dict[str, Any]:
        accounts.sign_out(conn, bearer(request) or "")
        return stamped({})

    # --- assistants ------------------------------------------------------------------------

    @app.post("/assistant/connect")
    def connect_assistant(conn: Db, who: Who) -> dict[str, Any]:
        """A token for an MCP client, minted by whoever is signed in (FR-MCP-01).

        Shown once, like an invite link. It is a device session, so it is in the
        user's device list and revoked the same way (FR-MCP-02).
        """
        device_id, session = accounts.connect_assistant(conn, who)
        return stamped({"token": session.token, "device_id": device_id, "path": assistant.MCP_PATH})

    # --- users (Admins) ------------------------------------------------------------------

    @app.get("/users")
    def users(conn: Db, who: Who) -> dict[str, Any]:
        accounts._require_admin(who)
        return stamped({"users": accounts.list_users(conn)})

    @app.post("/users/invite")
    def invite(conn: Db, who: Who, body: accounts.Invite) -> dict[str, Any]:
        user_id, token = accounts.invite(conn, who, body)
        link = body.link.replace("TOKEN", token) if body.link else None
        return stamped({"user_id": user_id, "token": token, **posted(conn, "invite", str(body.email), link)})

    @app.post("/users/{user_id}/role")
    def set_role(conn: Db, who: Who, user_id: str, body: accounts.RoleChange) -> dict[str, Any]:
        accounts.set_role(conn, who, user_id, body.role)
        return stamped({"user": accounts.get_user(conn, user_id)})

    @app.post("/users/{user_id}/deactivate")
    def deactivate(conn: Db, who: Who, user_id: str) -> dict[str, Any]:
        accounts.deactivate(conn, who, user_id)
        return stamped({"user": accounts.get_user(conn, user_id)})

    @app.post("/users/{user_id}/reactivate")
    def reactivate(conn: Db, who: Who, user_id: str) -> dict[str, Any]:
        accounts.reactivate(conn, who, user_id)
        return stamped({"user": accounts.get_user(conn, user_id)})

    @app.post("/users/{user_id}/reset-link")
    def reset_link(conn: Db, who: Who, user_id: str, body: accounts.ResetRequest | None = None) -> dict[str, Any]:
        token = accounts.reset_link(conn, who, user_id)
        link = body.link.replace("TOKEN", token) if body and body.link else None
        return stamped({"token": token, **posted(conn, "reset", accounts.email_of(conn, user_id), link)})

    @app.get("/users/{user_id}/devices")
    def devices(conn: Db, who: Who, user_id: str) -> dict[str, Any]:
        return stamped({"devices": accounts.list_devices(conn, who, user_id)})

    @app.post("/users/{user_id}/devices/{device_id}/revoke")
    def revoke_device(conn: Db, who: Who, user_id: str, device_id: str) -> dict[str, Any]:
        """One device, not the person (FR-USR-14).

        Anyone can do it for their own account; an Admin, for anyone (FR-USR-17).
        """
        return stamped({"devices": accounts.revoke_device(conn, who, user_id, device_id)})

    # --- mail (Admins) --------------------------------------------------------------------

    @app.get("/mail")
    def mail_settings(conn: Db, who: Who) -> dict[str, Any]:
        accounts._require_admin(who)
        return stamped({"mail": mail.describe(conn)})

    @app.put("/mail")
    def set_mail(conn: Db, who: Who, body: mail.MailSettings) -> dict[str, Any]:
        accounts._require_admin(who)
        mail.save(conn, body)
        return stamped({"mail": mail.describe(conn)})

    @app.delete("/mail")
    def clear_mail(conn: Db, who: Who) -> dict[str, Any]:
        """Stop sending. Links go back to being copied by hand (FR-USR-12)."""
        accounts._require_admin(who)
        mail.forget(conn)
        return stamped({"mail": None})

    @app.post("/mail/test")
    def test_mail(conn: Db, who: Who) -> dict[str, Any]:
        """To the Admin\'s own address, so a wrong password is found now rather than at a reset (FR-USR-16)."""
        accounts._require_admin(who)
        to = accounts.email_of(conn, who.user_id)
        subject, body = mail.test_message(group_name(conn))
        mail.send(conn, to, subject, body)
        return stamped({"sent_to": to})

    # --- codes ----------------------------------------------------------------------------

    @app.post("/codes/sheets")
    def code_sheets(conn: Db, who: Who, body: SheetRequest) -> Response:
        """Print a batch of unassigned codes (FR-TAG-02). Admins only."""
        accounts._require_admin(who)
        group = derived.get_entity(conn, "setting", "group") or {}
        if not group.get("name") or not group.get("code_url") or not group.get("contact"):
            # Every sticker is a public page from the moment it goes on gear, and a
            # public page with no way to reach us is no use to a finder (FR-PUB-01).
            raise Conflict("set the group name, site address and contact in Settings first")
        made = codes.create_codes(conn, who.user_id, body.sheets * labels.LABELS_PER_SHEET)
        pdf = labels.sheet(made, group["name"], group["code_url"])
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": 'attachment; filename="codes.pdf"'},
        )

    @app.get("/codes/{code}")
    def code(conn: Db, _who: Who, code: str) -> dict[str, Any]:
        if not codes.is_code(code):
            raise BadRequest("not a code")
        state = codes.resolve(conn, code)
        if state is None:
            raise NotFound("not one of our codes")
        return stamped({"code": code, "item_id": state.get("item_id")})

    # --- photos ----------------------------------------------------------------------------

    def photo_path(photo_id: str) -> Path | None:
        for ext in PHOTO_EXTENSIONS.values():
            candidate = photo_dir / f"{photo_id}{ext}"
            if candidate.is_file():
                return candidate
        return None

    @app.put("/photos/{photo_id}")
    async def put_photo(
        request: Request, conn: Db, who: Who, photo_id: str, entity_type: str, entity_id: str
    ) -> dict[str, Any]:
        """A device sends the bytes with an id it made; the server keeps the file and records the event (FR-INV-11).

        Idempotent on the id, like push: a retry after a dropped connection finds the photo
        already on the entity and writes nothing.
        """
        if not who.active:
            raise Deactivated("this account has been deactivated")
        if not is_ulid(photo_id):
            raise BadRequest("photo_id must be a ULID")
        if entity_type not in PHOTO_ENTITIES:
            raise BadRequest(f"entity_type must be one of {', '.join(PHOTO_ENTITIES)}")
        content_type = request.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if content_type not in PHOTO_TYPES:
            raise BadRequest(f"Content-Type must be one of {', '.join(PHOTO_TYPES)}")
        entity = derived.get_entity(conn, entity_type, entity_id)
        if entity is None:
            raise NotFound(f"no such {entity_type}")
        if any(ph["id"] == photo_id for ph in entity.get("photos", [])):
            return stamped({})
        declared = request.headers.get("Content-Length")
        if declared is not None and declared.isdigit() and int(declared) > PHOTO_MAX_BYTES:
            raise TooLarge(f"a photo may be at most {PHOTO_MAX_BYTES // (1024 * 1024)} MB")
        data = await request.body()
        if len(data) == 0:
            raise BadRequest("the photo is empty")
        if len(data) > PHOTO_MAX_BYTES:
            raise TooLarge(f"a photo may be at most {PHOTO_MAX_BYTES // (1024 * 1024)} MB")
        photo_dir.mkdir(parents=True, exist_ok=True)
        (photo_dir / f"{photo_id}{PHOTO_EXTENSIONS[content_type]}").write_bytes(data)
        events.append_server(
            conn,
            who.user_id,
            entity_type,
            entity_id,
            "photo_added",
            {"photo_id": photo_id, "content_type": content_type, "size": len(data)},
        )
        return stamped({})

    @app.get("/photos/{photo_id}")
    def get_photo(_who: Who, photo_id: str) -> FileResponse:
        """Never cached, anywhere: the offline copy stays small (FR-INV-11, NFR-PERF-07)."""
        if not is_ulid(photo_id):
            raise BadRequest("photo_id must be a ULID")
        path = photo_path(photo_id)
        if path is None:
            raise NotFound("no such photo")
        media_type = next(ct for ct, ext in PHOTO_EXTENSIONS.items() if ext == path.suffix)
        return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-store"})

    # --- public -------------------------------------------------------------------------

    @app.get("/public/codes/{code}")
    def public_code(conn: Db, code: str) -> dict[str, Any]:
        """The one route with no account behind it: what a stranger who scans a sticker sees.

        The item name, the group name, and how to reach us (FR-PUB-01). Nothing
        else is read here, so nothing else can leak (NFR-SEC-03). A unit has no
        name of its own, so it answers with its generic's; the number is ours to
        know and no use to a finder.
        """
        if not codes.is_code(code):
            raise BadRequest("not a code")
        state = codes.resolve(conn, code)
        if state is None:
            raise NotFound("not one of our codes")
        item = derived.get_entity(conn, "item", state["item_id"]) if state.get("item_id") else None
        if item is not None and item.get("parent_id"):
            item = derived.get_entity(conn, "item", str(item["parent_id"])) or {}
        group = derived.get_entity(conn, "setting", "group") or {}
        return stamped(
            {
                "item": None if item is None else {"name": item.get("name", "")},
                "group": {"name": group.get("name", ""), "contact": group.get("contact", "")},
            }
        )

    @app.post("/public/codes/{code}/found")
    def report_found(request: Request, conn: Db, code: str, body: FoundBody) -> dict[str, Any]:
        """A stranger says where our gear is (FR-PUB-02). Written to the log, so it reaches the app (FR-PUB-03).

        The server records the event itself, under the actor `public`. Nothing else about
        the item is read here, and nothing is returned (NFR-SEC-03).
        """
        if not codes.is_code(code):
            raise BadRequest("not a code")
        if body.website:
            # No person sees that field. A bot filled it: say thanks and keep nothing (FR-PUB-04).
            return stamped({})
        state = codes.resolve(conn, code)
        if state is None:
            raise NotFound("not one of our codes")
        now = now_ms()
        if not (
            found_limits["address"].allow(client_address(request), now)
            and found_limits["code"].allow(code, now)
            and found_limits["all"].allow("all", now)
        ):
            raise TooMany("too many reports; try again later")
        events.append_server(
            conn,
            PUBLIC_ACTOR,
            "found_report",
            new_ulid(now),
            "created",
            {"code": code, "item_id": state.get("item_id"), "note": body.note, "contact": body.contact},
            now,
        )
        return stamped({})

    # --- inventory CSV -----------------------------------------------------------------

    @app.get("/inventory.csv")
    def export_inventory(conn: Db, who: Who) -> Response:
        """A spreadsheet of the whole inventory (FR-RPT-03). Read-only, so any signed-in active person may pull it."""
        _require_active(who)
        text = inventory_csv.export(derived.snapshot(conn))
        return Response(
            content=text,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="inventory.csv"'},
        )

    @app.post("/inventory/import/preview")
    async def preview_import(conn: Db, who: Who, request: Request) -> dict[str, Any]:
        """What a file would do, without writing it (FR-SET-11). Admins only."""
        accounts._require_admin(who)
        body = await request.body()
        if not body:
            raise BadRequest("the file is empty")
        plan = inventory_csv.plan(derived.snapshot(conn), body.decode("utf-8"))
        return stamped(plan.summary())

    @app.post("/inventory/import")
    async def do_import(conn: Db, who: Who, request: Request) -> dict[str, Any]:
        """Write a file's adds and changes as the Admin who ran it (FR-SET-11)."""
        accounts._require_admin(who)
        body = await request.body()
        if not body:
            raise BadRequest("the file is empty")
        return stamped(inventory_csv.apply(conn, body.decode("utf-8"), who.user_id))

    if static is not None:
        serve_client(app, Path(static), db)
    return app


class SheetRequest(Strict):
    sheets: Annotated[int, Field(ge=1, le=10)] = 1


class FoundBody(Strict):
    """What a finder types. `website` is a honeypot: no person sees the field, so anything in it is a bot."""

    note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
    contact: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] = ""
    website: str = ""


def manifest(file: Path, group: str) -> JSONResponse:
    """The name under the home-screen icon is the group's, and the group is a setting (NFR-DEP-06).

    The build cannot know it, so it is written in here. Never cached: a group
    that renames itself should see the new name on the next install.
    """
    body = json.loads(file.read_text())
    if group:
        body["name"] = body["short_name"] = f"{group} Gear"
    return JSONResponse(body, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


def serve_client(app: FastAPI, root: Path, db: Callable[[], Iterator[sqlite3.Connection]]) -> None:
    """Files from the build, and index.html for anything else so the client owns its own routes."""
    root = root.resolve()
    index = root / "index.html"
    Conn = Annotated[sqlite3.Connection, Depends(db)]

    @app.get("/{path:path}", include_in_schema=False)
    def client(path: str, conn: Conn) -> Response:
        target = (root / path).resolve()
        if path and target.is_file() and target.is_relative_to(root):
            if target.name == "manifest.webmanifest":
                return manifest(target, group_name(conn))
            return FileResponse(target)
        return FileResponse(index)


def main(argv: list[str] | None = None) -> int:
    """Run the server for development. Deployment is M9's problem."""
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="Serve Gear Tracker.")
    parser.add_argument("--db", required=True, help="path to the SQLite file")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--static", help="serve the built client from this directory")
    parser.add_argument("--photos", help="where photos are kept; default is a photos/ directory beside the database")
    args = parser.parse_args(argv)
    uvicorn.run(create_app(args.db, static=args.static, photos=args.photos), host=args.host, port=args.port)
    return 0
