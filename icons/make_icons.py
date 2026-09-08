"""Generate simple cute tomato PNG icons for the extension.

Run once to (re)create icon16.png, icon48.png, icon128.png.
No third-party libs: writes valid PNGs by hand with zlib + struct.
"""
import struct
import zlib


def draw(size):
    # RGBA canvas, transparent background
    px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]

    cx = cy = size / 2
    body_r = size * 0.36

    def blend(x, y, color):
        r, g, b, a = color
        if 0 <= x < size and 0 <= y < size:
            px[y][x] = (r, g, b, a)

    # Tomato body (red circle) with a soft highlight
    for y in range(size):
        for x in range(size):
            dx = x + 0.5 - cx
            dy = y + 0.5 - (cy + size * 0.06)
            d = (dx * dx + dy * dy) ** 0.5
            if d <= body_r:
                # highlight toward upper-left
                hl = max(0.0, 1 - ((dx + body_r * 0.4) ** 2 + (dy + body_r * 0.4) ** 2) ** 0.5 / (body_r * 1.4))
                r = int(255)
                g = int(107 + 70 * hl)
                b = int(107 + 70 * hl)
                blend(x, y, (r, g, b, 255))

    # Little green leaf/stem on top
    leaf_cy = cy - body_r * 0.55
    leaf_r = size * 0.16
    for y in range(size):
        for x in range(size):
            dx = x + 0.5 - cx
            dy = y + 0.5 - leaf_cy
            d = (dx * dx + (dy * 1.6) ** 2) ** 0.5
            if d <= leaf_r:
                blend(x, y, (78, 205, 96, 255))
    # stem
    for y in range(int(leaf_cy - size * 0.14), int(leaf_cy)):
        for x in range(int(cx - size * 0.02), int(cx + size * 0.03)):
            blend(x, y, (60, 160, 80, 255))

    return px


def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0
        for x in range(size):
            raw.extend(px[y][x])

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return c + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


for s in (16, 48, 128):
    write_png(f"icon{s}.png", draw(s))
    print(f"wrote icon{s}.png")
