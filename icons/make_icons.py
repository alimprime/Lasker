"""Generate simple placeholder PNG icons (knight silhouette on green background).

Run with: python3 make_icons.py
Produces icon16.png, icon48.png, icon128.png in the current directory.
Uses only the standard library (zlib + struct).
"""

import struct
import zlib


def write_png(path: str, pixels: list[list[tuple[int, int, int, int]]]) -> None:
    height = len(pixels)
    width = len(pixels[0])

    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for r, g, b, a in row:
            raw.extend((r, g, b, a))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def make_icon(size: int) -> list[list[tuple[int, int, int, int]]]:
    bg = (34, 139, 85, 255)
    fg = (245, 245, 240, 255)
    border = (20, 80, 50, 255)

    pixels = [[bg for _ in range(size)] for _ in range(size)]

    for y in range(size):
        for x in range(size):
            if x == 0 or y == 0 or x == size - 1 or y == size - 1:
                pixels[y][x] = border

    cx, cy = size / 2, size / 2
    r = size * 0.28
    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            if dx * dx + dy * dy <= r * r:
                pixels[y][x] = fg

    bar_w = max(2, size // 12)
    bar_h = max(4, size // 3)
    bx0 = int(cx - bar_w / 2)
    by0 = int(cy - bar_h / 2)
    for y in range(by0, by0 + bar_h):
        for x in range(bx0, bx0 + bar_w):
            if 0 <= x < size and 0 <= y < size:
                pixels[y][x] = bg

    return pixels


if __name__ == "__main__":
    for s in (16, 48, 128):
        write_png(f"icon{s}.png", make_icon(s))
        print(f"wrote icon{s}.png")
