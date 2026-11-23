"""Requirement IDs belong in comments and docstrings, not in text a person reads."""

import ast
import re
from pathlib import Path

ID = re.compile(r"\bN?FR-[A-Z]+-\d+")
SRC = Path(__file__).resolve().parent.parent / "src" / "gear_tracker"


def _docstrings(tree: ast.AST) -> set[int]:
    """Bare string statements: docstrings, and the text under an attribute."""
    return {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant)}


def test_no_string_a_person_can_read_carries_a_requirement_id():
    bad = []
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text())
        skip = _docstrings(tree)
        for node in ast.walk(tree):
            is_text = isinstance(node, ast.Constant) and isinstance(node.value, str)
            if is_text and id(node) not in skip and ID.search(node.value):
                bad.append(f"{path.name}:{node.lineno}: {node.value}")
    assert bad == []
