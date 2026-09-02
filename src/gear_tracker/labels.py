"""A PDF of codes laid out on label stock, one QR and the group name per label (FR-TAG-03)."""

from __future__ import annotations

import math
from io import BytesIO

from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

# Avery 6576 template values. Confirm against real stock before the first
# print run; that M0 task is still open. Everything below is in points.
PAGE_WIDTH, PAGE_HEIGHT = letter  # 8.5 x 11 in
LABEL_WIDTH = 1.75 * inch
LABEL_HEIGHT = 1.25 * inch
COLUMNS = 4
ROWS = 8
TOP_MARGIN = 0.5 * inch
LEFT_MARGIN = 0.3125 * inch
PITCH_X = 2.0625 * inch
PITCH_Y = 1.25 * inch

LABELS_PER_SHEET = COLUMNS * ROWS

QR_MARGIN = 0.05 * inch
"""Between the QR's quiet zone and the label edge, so a slightly misaligned print does not clip it."""

FONT = "Helvetica"
FONT_SIZE = 9
MIN_FONT_SIZE = 5
"""The name shrinks to fit beside the QR, one word per line, but no smaller than this."""


def pages_needed(count: int) -> int:
    return math.ceil(count / LABELS_PER_SHEET)


def sheet(codes: list[str], group_name: str, url_base: str) -> bytes:
    """One label per code, as many pages as needed. The QR encodes url_base/code; keep url_base short."""
    base = url_base.rstrip("/")
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=letter)
    pdf.setTitle("codes")
    for n, code in enumerate(codes):
        slot = n % LABELS_PER_SHEET
        if n and slot == 0:
            pdf.showPage()
        x = LEFT_MARGIN + (slot % COLUMNS) * PITCH_X
        y = PAGE_HEIGHT - TOP_MARGIN - (slot // COLUMNS + 1) * PITCH_Y
        _label(pdf, x, y, f"{base}/{code}", group_name)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def _label(pdf: canvas.Canvas, x: float, y: float, url: str, group_name: str) -> None:
    """(x, y) is the label's bottom-left corner."""
    size = LABEL_HEIGHT - 2 * QR_MARGIN
    qr = QrCodeWidget(url, barLevel="M")
    left, bottom, right, top = qr.getBounds()
    drawing = Drawing(size, size)
    drawing.scale(size / (right - left), size / (top - bottom))
    drawing.add(qr)
    drawing.drawOn(pdf, x + QR_MARGIN, y + QR_MARGIN)

    text_x = x + size + 2 * QR_MARGIN
    width = LABEL_WIDTH - (text_x - x) - QR_MARGIN
    _name(pdf, text_x, y + LABEL_HEIGHT / 2, width, group_name)


def _name(pdf: canvas.Canvas, x: float, centre_y: float, width: float, text: str) -> None:
    """One word per line, at the largest size where the widest word fits, centred on centre_y."""
    lines = text.split() or [text]
    widest = max(stringWidth(line, FONT, FONT_SIZE) for line in lines)
    font_size = max(MIN_FONT_SIZE, min(FONT_SIZE, FONT_SIZE * width / widest))
    leading = font_size * 1.2
    pdf.setFont(FONT, font_size)
    top = centre_y + leading * len(lines) / 2 - font_size
    for i, line in enumerate(lines):
        pdf.drawString(x, top - i * leading, line)
