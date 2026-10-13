"""The label sheet, read back from the PDF it makes."""

from __future__ import annotations

import functools
import io
import math

import pdfplumber
import pytest
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from gear_tracker import labels

CODES = [f"{n:010d}" for n in range(33)]
SITE = "https://10thrichmond.ca/gear"

# The stock, measured from the vendor's blank template, in inches from the page's top-left. Kept apart from labels.py
# so a wrong constant there fails here.
INCH = 72
LEFT, TOP, PITCH_X, PITCH_Y = 0.46875, 0.5, 1.9375, 1.25
WIDTH, HEIGHT, RADIUS = 1.75, 1.25, 0.094
TOLERANCE = 0.001


def label_rects() -> list[tuple[float, float, float, float]]:
    """(x0, top, x1, bottom) in inches, in reading order."""
    return [
        (LEFT + c * PITCH_X, TOP + r * PITCH_Y, LEFT + c * PITCH_X + WIDTH, TOP + r * PITCH_Y + HEIGHT)
        for r in range(8)
        for c in range(4)
    ]


def inside(x: float, y: float, rect: tuple[float, float, float, float]) -> bool:
    """Whether (x, y) is on the label, rounded corners and all."""
    x0, top, x1, bottom = rect
    if not (x0 - TOLERANCE <= x <= x1 + TOLERANCE and top - TOLERANCE <= y <= bottom + TOLERANCE):
        return False
    cx = min(max(x, x0 + RADIUS), x1 - RADIUS)
    cy = min(max(y, top + RADIUS), bottom - RADIUS)
    return math.hypot(x - cx, y - cy) <= RADIUS + TOLERANCE


def box_inside(obj: dict, rect: tuple[float, float, float, float]) -> bool:
    x0, x1, top, bottom = (obj[k] / INCH for k in ("x0", "x1", "top", "bottom"))
    return all(inside(x, y, rect) for x in (x0, x1) for y in (top, bottom))


@functools.cache
def sheet(count: int, site_url: str = SITE) -> bytes:
    return labels.sheet(CODES[:count], site_url)


@functools.cache
def read(pdf: bytes) -> tuple[tuple[list[dict], list[dict]], ...]:
    """Each page's (rects, chars). The reader is closed before this returns."""
    with pdfplumber.open(io.BytesIO(pdf)) as doc:
        return tuple((page.rects, page.chars) for page in doc.pages)


def font_size(chars: list[dict]) -> float:
    """A turned line's size in points: its extent across the label, which the PDF reader sets at one em."""
    return max(c["x1"] for c in chars) - min(c["x0"] for c in chars)


def per_label(objs: list[dict]) -> list[list[dict]]:
    """Each object under the one label it sits wholly on. Fails if one sits on none."""
    rects = label_rects()
    found: list[list[dict]] = [[] for _ in rects]
    for obj in objs:
        homes = [i for i, rect in enumerate(rects) if box_inside(obj, rect)]
        assert homes, f"off every label: {obj['x0'] / INCH:.3f}, {obj['top'] / INCH:.3f}"
        found[homes[0]].append(obj)
    return found


def test_a_sheet_is_a_pdf():
    assert sheet(1).startswith(b"%PDF")


@pytest.mark.parametrize(("count", "pages"), [(1, 1), (32, 1), (33, 2), (320, 10)])
def test_pages_needed(count, pages):
    assert labels.pages_needed(count) == pages


def test_thirty_three_codes_need_a_second_page():
    assert len(read(sheet(32))) == 1
    assert len(read(sheet(33))) == 2


def qr_alone(url: str) -> list[tuple[float, float, float, float]]:
    """The modules of url's QR, drawn where the first label's QR goes."""
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=letter)
    labels.qr_drawing(url, labels.QR_SIZE).drawOn(pdf, LEFT * INCH, (11 - TOP - HEIGHT) * INCH)
    pdf.showPage()
    pdf.save()
    return boxes(read(buffer.getvalue())[0][0])


def boxes(rects: list[dict]) -> list[tuple[float, float, float, float]]:
    return sorted((round(r["x0"], 2), round(r["top"], 2), round(r["x1"], 2), round(r["bottom"], 2)) for r in rects)


@pytest.mark.parametrize("site_url", [SITE, SITE + "/"])
def test_the_qr_encodes_base_slash_g_slash_code(site_url):
    """The URL must be short (FR-TAG-13). A trailing slash on the base must not double up."""
    printed = boxes(read(sheet(1, site_url))[0][0])
    assert printed == qr_alone(f"{SITE}/g/{CODES[0]}")
    assert printed != qr_alone(f"{SITE}//g/{CODES[0]}")


def test_every_qr_and_address_sits_wholly_on_its_label():
    rects, chars = read(sheet(32))[0]
    assert all(per_label(rects)), "a label with no QR"
    assert all(per_label(chars)), "a label with no address"


@pytest.mark.parametrize(
    ("site_url", "text"),
    [
        ("https://10thrichmond.ca/gear", "10thrichmond.ca"),
        ("https://10thrichmond.ca/", "10thrichmond.ca"),
        ("  https://10thrichmond.ca/gear  ", "10thrichmond.ca"),
        ("10thrichmond.ca/gear", "10thrichmond.ca"),
        ("example.org/a//b", "example.org"),
        ("http://example.org:8080/gear", "example.org:8080"),
        ("https://user:secret@example.org/gear", "example.org"),
    ],
)
def test_the_address_is_the_host_alone(site_url, text):
    assert labels.site_text(site_url) == text


def test_the_label_prints_the_host():
    _, chars = read(sheet(1))[0]
    assert "".join(c["text"] for c in chars) == "10thrichmond.ca"


def test_the_qr_fills_the_label_height_and_keeps_its_quiet_zone():
    rect = label_rects()[0]
    rects, chars = read(sheet(1))[0]
    modules = per_label(rects)[0]
    module = min(min(r["width"], r["height"]) for r in modules) / INCH
    x0 = min(r["x0"] for r in modules) / INCH
    x1 = max(r["x1"] for r in modules) / INCH
    top = min(r["top"] for r in modules) / INCH
    bottom = max(r["bottom"] for r in modules) / INCH
    quiet = 4 * module
    assert bottom - top + 2 * quiet >= 1.2
    # The whole quiet zone is on the label, and wider than the rounded corner.
    assert x0 - quiet >= rect[0] - TOLERANCE
    assert top - quiet >= rect[1] - TOLERANCE
    assert bottom + quiet <= rect[3] + TOLERANCE
    assert quiet > RADIUS
    # The address is to the right of the QR, not over it.
    assert min(c["x0"] for c in chars) / INCH >= x1 + quiet - TOLERANCE


def test_the_address_runs_along_the_label_at_a_readable_size():
    _, chars = read(sheet(1))[0]
    assert all(not c["upright"] for c in chars)
    assert font_size(chars) >= 9
    length = (max(c["bottom"] for c in chars) - min(c["top"] for c in chars)) / INCH
    assert length > 0.9


def test_a_long_address_shrinks_and_still_fits():
    long = "https://the-extraordinarily-long-named-scout-group-of-somewhere.example.org/gear"
    _, chars = read(sheet(32, long))[0]
    letters = per_label(chars)
    assert all(letters)
    assert "".join(c["text"] for c in letters[0]) == labels.site_text(long)
    assert font_size(letters[0]) >= labels.MIN_FONT_SIZE - 0.01
