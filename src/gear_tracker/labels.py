"""A PDF of codes laid out on label stock, one QR and the site address per label (FR-TAG-16)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from io import BytesIO
from typing import Literal
from urllib.parse import urlsplit

from reportlab.graphics import renderSVG
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfbase.pdfmetrics import getAscentDescent, stringWidth
from reportlab.pdfgen import canvas

# Page and label geometry, in points. The standard sheet is 32 labels, each 1.75 x 1.25 in with rounded corners, in 4
# columns of 8 rows, measured from the vendor's blank template; confirm against real stock before the first print run.
# The cards layout is plain paper, 12 cards in 3 columns of 4, cut apart and laminated.
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

CARD_MARGIN = 0.375 * inch
"""Clear of the printer's unprintable edge."""
CARD_WIDTH = (PAGE_WIDTH - 2 * CARD_MARGIN) / 3
CARD_HEIGHT = (PAGE_HEIGHT - 2 * CARD_MARGIN) / 4
CARD_BORDER = 0.25 * inch
"""Blank all round inside the cut line, so laminate can seal past the QR."""
CARD_TEXT_BAND = 0.3125 * inch
"""The height under the QR for the site address."""
CUT_LINE_WIDTH = 0.5
CUT_LINE_GREY = 0.75

FONT = "Helvetica-Bold"
MIN_FONT_SIZE = 5
"""The site address shrinks to fit beside the QR, but no smaller than this. Past it, the letters narrow instead."""
TEXT_INSET = 0.0625 * inch
"""Between the site address and the label edge, so a misaligned print does not clip it."""
TEXT_GAP = 0.03 * inch
"""Between the QR and the site address. The quiet zone is already blank; this only keeps them from touching."""

QR_SCREEN_SIZE = 220
"""A join link's QR (FR-USR-19), sized to read from a phone held up across a table, not a sticker."""


LayoutName = Literal["standard", "cards"]


@dataclass(frozen=True)
class Layout:
    """One sheet of label stock: where the labels sit, and how each is drawn. Subclasses set the drawing."""

    columns: int
    rows: int
    top_margin: float
    left_margin: float
    pitch_x: float
    pitch_y: float
    label_width: float
    label_height: float

    @property
    def labels_per_sheet(self) -> int:
        return self.columns * self.rows

    def fit(self, text: str) -> tuple[float, float]:
        """The font size, and how far to narrow the letters, for the site address on one label."""
        raise NotImplementedError

    def draw(self, pdf: canvas.Canvas, x: float, y: float, url: str, text: str, fit: tuple[float, float]) -> None:
        """One label with its bottom-left corner at (x, y)."""
        raise NotImplementedError


@dataclass(frozen=True)
class StandardLayout(Layout):
    @property
    def _across(self) -> float:
        return self.label_width - self.label_height - TEXT_GAP - TEXT_INSET

    def fit(self, text: str) -> tuple[float, float]:
        return _fit(text, self.label_height - 2 * TEXT_INSET, self._across)

    def draw(self, pdf: canvas.Canvas, x: float, y: float, url: str, text: str, fit: tuple[float, float]) -> None:
        qr_drawing(url, self.label_height).drawOn(pdf, x, y)
        centre_x = x + self.label_width - TEXT_INSET - self._across / 2
        _line(pdf, centre_x, y + self.label_height / 2, text, *fit, -90)


@dataclass(frozen=True)
class CardLayout(Layout):
    @property
    def _inner_width(self) -> float:
        return self.label_width - 2 * CARD_BORDER

    def fit(self, text: str) -> tuple[float, float]:
        return _fit(text, self._inner_width, CARD_TEXT_BAND)

    def draw(self, pdf: canvas.Canvas, x: float, y: float, url: str, text: str, fit: tuple[float, float]) -> None:
        qr = min(self._inner_width, self.label_height - 2 * CARD_BORDER - CARD_TEXT_BAND)
        pdf.saveState()
        pdf.setLineWidth(CUT_LINE_WIDTH)
        pdf.setStrokeGray(CUT_LINE_GREY)
        pdf.rect(x, y, self.label_width, self.label_height)
        pdf.restoreState()
        band = y + CARD_BORDER
        qr_drawing(url, qr).drawOn(pdf, x + (self.label_width - qr) / 2, band + CARD_TEXT_BAND)
        _line(pdf, x + self.label_width / 2, band + CARD_TEXT_BAND / 2, text, *fit, 0)


LAYOUTS: dict[LayoutName, Layout] = {
    "standard": StandardLayout(
        columns=COLUMNS,
        rows=ROWS,
        top_margin=TOP_MARGIN,
        left_margin=LEFT_MARGIN,
        pitch_x=PITCH_X,
        pitch_y=PITCH_Y,
        label_width=LABEL_WIDTH,
        label_height=LABEL_HEIGHT,
    ),
    "cards": CardLayout(
        columns=3,
        rows=4,
        top_margin=CARD_MARGIN,
        left_margin=CARD_MARGIN,
        pitch_x=CARD_WIDTH,
        pitch_y=CARD_HEIGHT,
        label_width=CARD_WIDTH,
        label_height=CARD_HEIGHT,
    ),
}


def pages_needed(count: int, layout: LayoutName = "standard") -> int:
    return math.ceil(count / LAYOUTS[layout].labels_per_sheet)


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


def sheet(codes: list[str], site_url: str, layout: LayoutName = "standard") -> bytes:
    """One label per code, as many pages as needed. The QR encodes site_url/g/code; keep site_url short."""
    stock = LAYOUTS[layout]
    base = site_url.strip().rstrip("/")
    text = site_text(site_url)
    fit = stock.fit(text)
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=letter)
    pdf.setTitle("codes")
    for n, code in enumerate(codes):
        slot = n % stock.labels_per_sheet
        if n and slot == 0:
            pdf.showPage()
        x = stock.left_margin + (slot % stock.columns) * stock.pitch_x
        y = PAGE_HEIGHT - stock.top_margin - (slot // stock.columns) * stock.pitch_y - stock.label_height
        stock.draw(pdf, x, y, f"{base}/g/{code}", text, fit)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def _fit(text: str, length: float, across: float) -> tuple[float, float]:
    """The font size, and how far to narrow the letters, for one line `length` long and `across` tall."""
    ascent, descent = getAscentDescent(FONT, 1)
    width = stringWidth(text, FONT, 1) or 1
    size = max(MIN_FONT_SIZE, min(length / width, across / (ascent - descent)))
    return size, min(1, length / (width * size))


def _line(
    pdf: canvas.Canvas, centre_x: float, centre_y: float, text: str, size: float, squeeze: float, rotation: float
) -> None:
    """One line centred on (centre_x, centre_y), turned by `rotation` degrees."""
    ascent, descent = getAscentDescent(FONT, size)
    pdf.saveState()
    pdf.translate(centre_x, centre_y)
    pdf.rotate(rotation)
    line = pdf.beginText(-stringWidth(text, FONT, size) * squeeze / 2, -(ascent + descent) / 2)
    line.setFont(FONT, size)
    line.setHorizScale(100 * squeeze)
    line.textOut(text)
    pdf.drawText(line)
    pdf.restoreState()
