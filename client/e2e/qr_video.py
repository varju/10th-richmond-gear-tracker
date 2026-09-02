"""Write a Y4M video whose every frame is one QR code, for Chromium's fake camera.

Usage: qr_video.py <text> <outfile.y4m>

Chromium plays the file in a loop as the camera when launched with
--use-file-for-fake-video-capture. The QR comes from the encoder the label
sheets use, so the browser test decodes what a sticker holds.
"""

from __future__ import annotations

import sys

from reportlab.graphics.barcode import qrencoder

WIDTH, HEIGHT = 640, 480
QR_SIZE = 400
QUIET_MODULES = 4
FRAMES = 30
WHITE, BLACK, GREY = 235, 16, 128  # Y for white and black; U and V at neutral.


def modules(text: str) -> list[list[bool]]:
    qr = qrencoder.QRCode(None, qrencoder.QRErrorCorrectLevel.M)
    qr.addData(text)
    qr.make()
    return qr.modules


def luma(text: str) -> bytes:
    grid = modules(text)
    count = len(grid) + 2 * QUIET_MODULES
    pixel = QR_SIZE // count
    size = pixel * count
    left, top = (WIDTH - size) // 2, (HEIGHT - size) // 2
    rows = bytearray([WHITE]) * (WIDTH * HEIGHT)
    for r, row in enumerate(grid):
        for c, dark in enumerate(row):
            if not dark:
                continue
            x0 = left + (c + QUIET_MODULES) * pixel
            for y in range(top + (r + QUIET_MODULES) * pixel, top + (r + QUIET_MODULES + 1) * pixel):
                rows[y * WIDTH + x0 : y * WIDTH + x0 + pixel] = bytes([BLACK]) * pixel
    return bytes(rows)


def main(text: str, outfile: str) -> None:
    header = f"YUV4MPEG2 W{WIDTH} H{HEIGHT} F30:1 Ip A1:1 C420jpeg\n".encode()
    chroma = bytes([GREY]) * (WIDTH // 2 * HEIGHT // 2)
    body = b"FRAME\n" + luma(text) + chroma + chroma
    with open(outfile, "wb") as f:
        f.write(header)
        for _ in range(FRAMES):
            f.write(body)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
