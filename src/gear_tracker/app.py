"""HTTP in front of sync.py. Three routes, JSON in and out.

create_app takes an `authenticate` callable so the sync layer can exist before
accounts do (M4). It returns a Principal, or None for 401. There is no default:
an app with no way to say who is calling refuses everyone.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from flask import Flask, Request, g, jsonify, request

from gear_tracker import sync
from gear_tracker.db import connect
from gear_tracker.events import now_ms
from gear_tracker.sync import BadRequest, Principal, SyncError, Unauthorized

Authenticator = Callable[[Request], Principal | None]


def create_app(db_path: str | Path, authenticate: Authenticator) -> Flask:
    app = Flask(__name__)

    def db():
        if "db" not in g:
            g.db = connect(db_path)
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    def principal() -> Principal:
        p = authenticate(request)
        if p is None:
            raise Unauthorized("sign in first")
        return p

    @app.errorhandler(SyncError)
    def sync_error(exc: SyncError):
        return jsonify({"error": exc.code, "message": exc.message, "server_time": now_ms()}), exc.status

    @app.get("/sync/bootstrap")
    def bootstrap():
        return jsonify(sync.bootstrap(db(), principal()))

    @app.post("/sync/push")
    def push():
        body = request.get_json(silent=True)
        if body is None:
            raise BadRequest("body must be JSON")
        return jsonify(sync.push(db(), principal(), body))

    @app.get("/sync/pull")
    def pull():
        raw = request.args.get("since")
        try:
            cursor = int(raw)  # type: ignore[arg-type]
        except TypeError, ValueError:
            raise BadRequest("since must be an integer") from None
        return jsonify(sync.pull(db(), principal(), cursor))

    return app
