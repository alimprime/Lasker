"""Generate Lasker's extension icon (bold "L" on accent-green background).

Run with: python3 make_icons.py
Produces icon16.png, icon48.png, icon128.png in the current directory.
Uses only the standard library (zlib + struct) -- no Pillow / PIL needed.
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
    # Brand colors: Lasker accent green, off-white glyph, darker green rim.
    bg = (34, 139, 85, 255)
    fg = (245, 245, 240, 255)
    border = (20, 80, 50, 255)

    # Rounded-square canvas filled with accent green.
    pixels = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]

    # Pick a corner radius proportional to size. Tiny icons (16px) get a
    # smaller radius so the L still reads cleanly.
    radius = max(1, size // (5 if size >= 48 else 4))

    def inside_rounded_rect(x: int, y: int) -> bool:
        # Point is inside if it's inside the inflated-rect minus the four
        # corner circles.
        if x < 0 or y < 0 or x >= size or y >= size:
            return False
        # Corner regions: check distance to the nearest corner centre.
        corners = [
            (radius, radius),
            (size - 1 - radius, radius),
            (radius, size - 1 - radius),
            (size - 1 - radius, size - 1 - radius),
        ]
        for cx, cy in corners:
            in_corner_box = (
                (x < radius and y < radius and cx == radius and cy == radius)
                or (x >= size - radius and y < radius and cx != radius and cy == radius)
                or (x < radius and y >= size - radius and cx == radius and cy != radius)
                or (x >= size - radius and y >= size - radius and cx != radius and cy != radius)
            )
            if in_corner_box:
                dx = x - cx
                dy = y - cy
                return dx * dx + dy * dy <= radius * radius
        return True

    # Fill the rounded-rect with background and draw a thin border.
    border_thickness = 1 if size <= 16 else 2
    for y in range(size):
        for x in range(size):
            if not inside_rounded_rect(x, y):
                continue
            # Border: if we're within `border_thickness` of the edge of the
            # rounded shape, paint border colour; otherwise background.
            on_border = (
                not inside_rounded_rect(x - border_thickness, y)
                or not inside_rounded_rect(x + border_thickness, y)
                or not inside_rounded_rect(x, y - border_thickness)
                or not inside_rounded_rect(x, y + border_thickness)
            )
            pixels[y][x] = border if on_border else bg

    # Draw a bold capital "L" occupying the vertical+horizontal strokes.
    # Geometry:
    #   margin on each side ~ 22% of size
    #   stem thickness ~ 18% of size
    #   foot thickness ~ 18% of size
    margin = max(2, int(round(size * 0.22)))
    stem_thickness = max(2, int(round(size * 0.18)))
    foot_thickness = max(2, int(round(size * 0.18)))

    # Stem: vertical bar from top margin to bottom margin, left-aligned
    # inside the margin box.
    stem_x0 = margin
    stem_x1 = stem_x0 + stem_thickness
    stem_y0 = margin
    stem_y1 = size - margin

    # Foot: horizontal bar at the bottom of the L, extending from the
    # stem's left edge to (size - margin).
    foot_x0 = margin
    foot_x1 = size - margin
    foot_y0 = stem_y1 - foot_thickness
    foot_y1 = stem_y1

    for y in range(size):
        for x in range(size):
            if pixels[y][x][3] == 0:
                continue  # outside rounded rect
            in_stem = stem_x0 <= x < stem_x1 and stem_y0 <= y < stem_y1
            in_foot = foot_x0 <= x < foot_x1 and foot_y0 <= y < foot_y1
            if in_stem or in_foot:
                pixels[y][x] = fg

    return pixels


if __name__ == "__main__":
    for s in (16, 48, 128):
        write_png(f"icon{s}.png", make_icon(s))
        print(f"wrote icon{s}.png")
