"""HTTP in front of sync.py. Three routes, JSON in and out.

create_app takes an `authenticate` callable so the sync layer can exist before
accounts do (M4). It returns a Principal, or None for 401. There is no default:
an app with no way to say who is calling refuses everyone.
"""

import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Annotated, Any

from fastapi import Body, Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from gear_tracker import sync
from gear_tracker.db import connect
from gear_tracker.events import now_ms
from gear_tracker.sync import Principal, SyncError, Unauthorized

Authenticator = Callable[[Request], Principal | None]


def create_app(db_path: str | Path, authenticate: Authenticator) -> FastAPI:
    app = FastAPI(title="Gear Tracker")

    def db() -> Iterator[sqlite3.Connection]:
        conn = connect(db_path)
        try:
            yield conn
        finally:
            conn.close()

    def principal(request: Request) -> Principal:
        p = authenticate(request)
        if p is None:
            raise Unauthorized("sign in first")
        return p

    Db = Annotated[sqlite3.Connection, Depends(db)]
    Who = Annotated[Principal, Depends(principal)]

    def error(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse({"error": code, "message": message, "server_time": now_ms()}, status_code=status)

    @app.exception_handler(SyncError)
    async def sync_error(_request: Request, exc: SyncError) -> JSONResponse:
        return error(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0]
        loc = ".".join(str(part) for part in first["loc"])
        return error(400, "bad_request", f"{loc}: {first['msg']}")

    @app.get("/sync/bootstrap")
    def bootstrap(conn: Db, who: Who) -> dict[str, Any]:
        return sync.bootstrap(conn, who)

    @app.post("/sync/push")
    def push(conn: Db, who: Who, body: Annotated[Any, Body()]) -> dict[str, Any]:
        return sync.push(conn, who, body)

    @app.get("/sync/pull")
    def pull(conn: Db, who: Who, since: Annotated[int, Query(ge=0)]) -> dict[str, Any]:
        return sync.pull(conn, who, since)

    return app
