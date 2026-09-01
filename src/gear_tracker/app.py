"""HTTP in front of sync.py and accounts.py. JSON in and out.

create_app takes an `authenticate` callable so tests can say who is calling
without a password. The default is the real one: a bearer token from
accounts.authenticate.
"""

import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Annotated, Any

from fastapi import Body, Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from gear_tracker import accounts, sync
from gear_tracker.db import connect
from gear_tracker.errors import ApiError, Unauthorized
from gear_tracker.events import now_ms
from gear_tracker.sync import Principal

Authenticator = Callable[[Request, sqlite3.Connection], Principal | None]


def bearer(request: Request) -> str | None:
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    return token if scheme.lower() == "bearer" and token else None


def by_token(request: Request, conn: sqlite3.Connection) -> Principal | None:
    return accounts.authenticate(conn, bearer(request))


def create_app(db_path: str | Path, authenticate: Authenticator = by_token) -> FastAPI:
    app = FastAPI(title="Gear Tracker")

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

    return app


def main(argv: list[str] | None = None) -> int:
    """Run the server for development. Deployment is M9's problem."""
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="Serve Gear Tracker.")
    parser.add_argument("--db", required=True, help="path to the SQLite file")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)
    uvicorn.run(create_app(args.db), host=args.host, port=args.port)
    return 0
