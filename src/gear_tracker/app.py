"""HTTP in front of sync.py and accounts.py. JSON in and out.

create_app takes an `authenticate` callable so tests can say who is calling
without a password. The default is the real one: a bearer token from
accounts.authenticate.
"""

import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Annotated, Any

from fastapi import Body, Depends, FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import Field, StringConstraints

from gear_tracker import accounts, codes, derived, events, labels, sync
from gear_tracker.db import connect
from gear_tracker.errors import ApiError, BadRequest, Conflict, NotFound, TooMany, Unauthorized
from gear_tracker.events import PUBLIC_ACTOR, Strict, now_ms
from gear_tracker.ratelimit import RateLimit
from gear_tracker.sync import Principal
from gear_tracker.ulid import new_ulid

Authenticator = Callable[[Request, sqlite3.Connection], Principal | None]

HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS

FOUND_PER_ADDRESS = (5, HOUR_MS)
FOUND_PER_CODE = (3, DAY_MS)
FOUND_IN_ALL = (30, HOUR_MS)
"""How often a stranger may report gear found (FR-PUB-04): per address, per sticker, and in total."""


def client_address(request: Request) -> str:
    """The first hop of X-Forwarded-For when a proxy is in front, as in deployment; else the peer."""
    first = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    return first or (request.client.host if request.client else "?")


def bearer(request: Request) -> str | None:
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    return token if scheme.lower() == "bearer" and token else None


def by_token(request: Request, conn: sqlite3.Connection) -> Principal | None:
    return accounts.authenticate(conn, bearer(request))


def create_app(
    db_path: str | Path, authenticate: Authenticator = by_token, static: str | Path | None = None
) -> FastAPI:
    """`static` is the built client (client/dist). Without it the server is API only, as in development."""
    app = FastAPI(title="Gear Tracker")

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
    def pull(conn: Db, who: Who, since: Annotated[int, Query(ge=0)]) -> dict[str, Any]:
        return sync.pull(conn, who, since)

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

    # --- users (Admins) ------------------------------------------------------------------

    @app.get("/users")
    def users(conn: Db, who: Who) -> dict[str, Any]:
        accounts._require_admin(who)
        return stamped({"users": accounts.list_users(conn)})

    @app.post("/users/invite")
    def invite(conn: Db, who: Who, body: accounts.Invite) -> dict[str, Any]:
        user_id, token = accounts.invite(conn, who, body)
        return stamped({"user_id": user_id, "token": token})

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
    def reset_link(conn: Db, who: Who, user_id: str) -> dict[str, Any]:
        return stamped({"token": accounts.reset_link(conn, who, user_id)})

    @app.get("/users/{user_id}/devices")
    def devices(conn: Db, who: Who, user_id: str) -> dict[str, Any]:
        return stamped({"devices": accounts.list_devices(conn, who, user_id)})

    @app.post("/users/{user_id}/devices/{device_id}/revoke")
    def revoke_device(conn: Db, who: Who, user_id: str, device_id: str) -> dict[str, Any]:
        """One phone, not the person (FR-USR-14)."""
        return stamped({"devices": accounts.revoke_device(conn, who, user_id, device_id)})

    # --- codes ----------------------------------------------------------------------------

    @app.post("/codes/sheets")
    def code_sheets(conn: Db, who: Who, body: SheetRequest) -> Response:
        """Print a batch of unassigned codes (FR-TAG-02). Admins only."""
        accounts._require_admin(who)
        group = derived.get_entity(conn, "setting", "group") or {}
        if not group.get("name") or not group.get("code_url") or not group.get("contact"):
            # Every sticker is a public page from the moment it goes on gear, and a
            # public page with no way to reach us is no use to a finder (FR-PUB-01).
            raise Conflict("set the group name, code URL and contact in Settings first")
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

    # --- public -------------------------------------------------------------------------

    @app.get("/public/codes/{code}")
    def public_code(conn: Db, code: str) -> dict[str, Any]:
        """The one route with no account behind it: what a stranger who scans a sticker sees.

        The item name, the group name, and how to reach us (FR-PUB-01). Nothing
        else is read here, so nothing else can leak (NFR-SEC-03).
        """
        if not codes.is_code(code):
            raise BadRequest("not a code")
        state = codes.resolve(conn, code)
        if state is None:
            raise NotFound("not one of our codes")
        item = derived.get_entity(conn, "item", state["item_id"]) if state.get("item_id") else None
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

    if static is not None:
        serve_client(app, Path(static))
    return app


class SheetRequest(Strict):
    sheets: Annotated[int, Field(ge=1, le=10)] = 1


class FoundBody(Strict):
    """What a finder types. `website` is a honeypot: no person sees the field, so anything in it is a bot."""

    note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
    contact: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] = ""
    website: str = ""


def serve_client(app: FastAPI, root: Path) -> None:
    """Files from the build, and index.html for anything else so the client owns its own routes."""
    root = root.resolve()
    index = root / "index.html"

    @app.get("/{path:path}", include_in_schema=False)
    def client(path: str) -> FileResponse:
        target = (root / path).resolve()
        if path and target.is_file() and target.is_relative_to(root):
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
    args = parser.parse_args(argv)
    uvicorn.run(create_app(args.db, static=args.static), host=args.host, port=args.port)
    return 0
