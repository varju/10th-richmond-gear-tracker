"""Errors that become HTTP responses. Each carries a status and a short code the client can switch on."""

from __future__ import annotations


class ApiError(Exception):
    status = 500
    code = "error"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class BadRequest(ApiError):
    status = 400
    code = "bad_request"


class Unauthorized(ApiError):
    status = 401
    code = "unauthorized"


class Forbidden(ApiError):
    status = 403
    code = "forbidden"


class Deactivated(Forbidden):
    code = "deactivated"


class NotFound(ApiError):
    status = 404
    code = "not_found"


class Conflict(ApiError):
    status = 409
    code = "conflict"


class TooMany(ApiError):
    status = 429
    code = "rate_limited"


class Rebootstrap(ApiError):
    """The cursor cannot be honoured. Not silence: the device must start again from a snapshot."""

    status = 410
    code = "re-bootstrap"
