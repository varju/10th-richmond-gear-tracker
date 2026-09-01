from __future__ import annotations

from pathlib import Path

import pytest


def write(directory: Path, name: str, sql: str) -> Path:
    path = directory / name
    path.write_text(sql)
    return path


@pytest.fixture
def migrations(tmp_path) -> Path:
    d = tmp_path / "migrations"
    d.mkdir()
    return d
