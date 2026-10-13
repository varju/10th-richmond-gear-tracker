"""A PDF of codes laid out on label stock, one QR and the site address per label (FR-TAG-16)."""

from __future__ import annotations

import math
from io import BytesIO
from urllib.parse import urlsplit

from reportlab.graphics import renderSVG
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfbase.pdfmetrics import getAscentDescent, stringWidth
from reportlab.pdfgen import canvas

# A US Letter sheet of 32 labels, each 1.75 x 1.25 in with rounded corners, in 4 columns of 8 rows. Measured from the
# vendor's blank template; confirm against real stock before the first print run. Everything below is in points.
PAGE_WIDTH, PAGE_HEIGHT = letter  # 8.5 x 11 in
LABEL_WIDTH = 1.75 * inch
LABEL_HEIGHT = 1.25 * inch
CORNER_RADIUS = 0.094 * inch
COLUMNS = 4
ROWS = 8
TOP_MARGIN = 0.5 * inch
LEFT_MARGIN = 0.46875 * inch
PITCH_X = 1.9375 * inch
PITCH_Y = 1.25 * inch

LABELS_PER_SHEET = COLUMNS * ROWS

QR_SIZE = LABEL_HEIGHT
"""The QR fills the label's height, with no margin outside it. Its 4-module quiet zone is the margin: a misaligned
print eats into that blank border first, and it is wider than the corner radius, so no module falls in a rounded
corner. The test print on real stock will confirm it is enough."""

FONT = "Helvetica-Bold"
MIN_FONT_SIZE = 5
"""The site address shrinks to fit beside the QR, but no smaller than this. Past it, the letters narrow instead."""
TEXT_INSET = 0.0625 * inch
"""Between the site address and the label edge, so a misaligned print does not clip it."""
TEXT_GAP = 0.03 * inch
"""Between the QR and the site address. The quiet zone is already blank; this only keeps them from touching."""
TEXT_LENGTH = LABEL_HEIGHT - 2 * TEXT_INSET
TEXT_ACROSS = LABEL_WIDTH - QR_SIZE - TEXT_GAP - TEXT_INSET


QR_SCREEN_SIZE = 220
"""A join link's QR (FR-USR-19), sized to read from a phone held up across a table, not a sticker."""


def pages_needed(count: int) -> int:
    return math.ceil(count / LABELS_PER_SHEET)


def qr_drawing(url: str, size: float) -> Drawing:
    """One URL as a size x size square, quiet zone included. The label sheet and the join link both draw this."""
    qr = QrCodeWidget(url, barLevel="M")
    left, bottom, right, top = qr.getBounds()
    drawing = Drawing(size, size)
    drawing.scale(size / (right - left), size / (top - bottom))
    drawing.add(qr)
    return drawing


def qr_svg(url: str, size: float = QR_SCREEN_SIZE) -> str:
    """One URL as inline SVG (FR-USR-19)."""
    return renderSVG.drawToString(qr_drawing(url, size))


def site_text(site_url: str) -> str:
    """What a label prints: the site address's host and any port. `https://example.org/gear/` prints `example.org`."""
    address = site_url.strip()
    parts = urlsplit(address if "://" in address else f"//{address}")
    host = parts.hostname or ""
    try:
        port = parts.port
    except ValueError:
        port = None
    if host and port:
        host = f"{host}:{port}"
    return host or address.rstrip("/")


def sheet(codes: list[str], site_url: str) -> bytes:
    """One label per code, as many pages as needed. The QR encodes site_url/g/code; keep site_url short."""
    base = site_url.strip().rstrip("/")
    text = site_text(site_url)
    size, squeeze = _fit(text)
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=letter)
    pdf.setTitle("codes")
    for n, code in enumerate(codes):
        slot = n % LABELS_PER_SHEET
        if n and slot == 0:
            pdf.showPage()
        x = LEFT_MARGIN + (slot % COLUMNS) * PITCH_X
        y = PAGE_HEIGHT - TOP_MARGIN - (slot // COLUMNS + 1) * PITCH_Y
        qr_drawing(f"{base}/g/{code}", QR_SIZE).drawOn(pdf, x, y)
        _site(pdf, x + LABEL_WIDTH - TEXT_INSET - TEXT_ACROSS / 2, y + LABEL_HEIGHT / 2, text, size, squeeze)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def _fit(text: str) -> tuple[float, float]:
    """The font size, and how far to narrow the letters, for one line along the label beside the QR."""
    ascent, descent = getAscentDescent(FONT, 1)
    width = stringWidth(text, FONT, 1) or 1
    size = max(MIN_FONT_SIZE, min(TEXT_LENGTH / width, TEXT_ACROSS / (ascent - descent)))
    return size, min(1, TEXT_LENGTH / (width * size))


def _site(pdf: canvas.Canvas, centre_x: float, centre_y: float, text: str, size: float, squeeze: float) -> None:
    """One line centred on (centre_x, centre_y), turned to read top to bottom."""
    ascent, descent = getAscentDescent(FONT, size)
    pdf.saveState()
    pdf.translate(centre_x, centre_y)
    pdf.rotate(-90)
    line = pdf.beginText(-stringWidth(text, FONT, size) * squeeze / 2, -(ascent + descent) / 2)
    line.setFont(FONT, size)
    line.setHorizScale(100 * squeeze)
    line.textOut(text)
    pdf.drawText(line)
    pdf.restoreState()
