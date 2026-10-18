#!/usr/bin/env python3
"""Generate the Chrome toolbar/management PNG icon sizes using only Python stdlib."""
import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
COLORS = {
    "ink": (25, 42, 55, 255),
    "coral": (239, 105, 71, 255),
    "pink": (217, 118, 156, 255),
    "teal": (84, 185, 166, 255),
    "yellow": (246, 201, 71, 255),
    "cream": (255, 248, 233, 255),
    "transparent": (0, 0, 0, 0),
}


def rounded_rect(x, y, left, top, right, bottom, radius):
    if x < left or x >= right or y < top or y >= bottom:
        return False
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def pixel_color(x, y):
    if not rounded_rect(x, y, 4, 4, 124, 124, 27):
        return COLORS["transparent"]

    color = COLORS["ink"]
    diagonal = x - y
    if diagonal < -60:
        color = COLORS["pink"]
    elif diagonal < -49:
        color = COLORS["coral"]
    elif diagonal > 56:
        color = COLORS["pink"]
    elif diagonal > 45:
        color = COLORS["teal"]

    dx, dy = x - 64, y - 64
    radius = math.sqrt(dx * dx + dy * dy)
    if radius <= 40:
        if radius >= 37:
            return COLORS["ink"]
        band = ((dx * 0.48 + dy * 0.88) + 120) % 22
        if band < 4:
            color = COLORS["ink"]
        elif band < 6:
            color = COLORS["pink"]
        elif 16 < dx < 25 and -18 < dy < -8:
            color = COLORS["teal"]
        else:
            color = COLORS["yellow"]
        if (x - 49) ** 2 + (y - 48) ** 2 < 9:
            color = COLORS["cream"]
    return color


def png_chunk(tag, data):
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)


def make_png(size, path):
    scale = 4
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [pixel_color((x + ox / scale) * 128 / size, (y + oy / scale) * 128 / size)
                       for oy in (0.5, 1.5, 2.5, 3.5) for ox in (0.5, 1.5, 2.5, 3.5)]
            rows.extend(sum(c[channel] for c in samples) // 16 for channel in range(4))
    data = b"\x89PNG\r\n\x1a\n"
    data += png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += png_chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    data += png_chunk(b"IEND", b"")
    with open(path, "wb") as icon:
        icon.write(data)


if __name__ == "__main__":
    for dimension in (16, 32, 48, 128):
        make_png(dimension, os.path.join(HERE, f"icon{dimension}.png"))
