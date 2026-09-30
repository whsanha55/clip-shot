#!/usr/bin/env python3
"""Clip Shot 확장 아이콘 생성기 (표준 라이브러리만 사용).

디자인: 인디고 라운드 사각형 배경 + 흰색 뷰파인더 브래킷(4모서리) + 중앙 점.
실행: python3 tools/make_icons.py  → icons/ 아래에 16/48/128 px PNG 생성
"""
import os
import struct
import zlib

BG = (79, 70, 229)   # indigo-600
FG = (255, 255, 255) # white
SIZES = [16, 48, 128]
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'icons')

# 도형 비율 (아이콘 크기 대비)
MARGIN = 0.20     # 가장자리 여백
STROKE = 0.09     # 브래킷 선 두께
ARM = 0.17        # 브래킷 팔 길이
DOT_R = 0.075     # 중앙 점 반지름
CORNER_R = 0.21   # 배경 라운딩 반지름
SS = 4            # 픽셀당 서브샘플 수 (안티앨리어싱)


def clamp01(v):
    return max(0.0, min(1.0, v))


def coverage(dist):
    """SDF 거리 → 픽셀 커버리지 (0~1)."""
    return clamp01(0.5 - dist)


def rounded_rect_dist(x, y, half, r):
    qx = abs(x) - (half - r)
    qy = abs(y) - (half - r)
    return (max(qx, 0) ** 2 + max(qy, 0) ** 2) ** 0.5 + min(max(qx, qy), 0) - r


def rect_dist(x, y, cx, cy, hw, hh):
    """부호 있는 거리: 내부는 음수, 경계는 0, 외부는 양수."""
    dx = abs(x - cx) - hw
    dy = abs(y - cy) - hh
    return (max(dx, 0) ** 2 + max(dy, 0) ** 2) ** 0.5 + min(max(dx, dy), 0)


def circle_dist(x, y, cx, cy, r):
    return ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 - r


def sample(x, y, s):
    """단일 서브픽셀의 RGBA. 좌표는 중심 기준 픽셀 단위."""
    bg_a = coverage(rounded_rect_dist(x, y, s / 2, CORNER_R * s))

    # 4모서리 뷰파인더 브래킷 (수평 팔 + 수직 팔)
    fg_a = 0.0
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx = sx * (s / 2 - MARGIN * s)
            cy = sy * (s / 2 - MARGIN * s)
            fg_a = max(fg_a, coverage(
                rect_dist(x, y, cx - sx * ARM * s / 2, cy, ARM * s / 2, STROKE * s / 2)))
            fg_a = max(fg_a, coverage(
                rect_dist(x, y, cx, cy - sy * ARM * s / 2, STROKE * s / 2, ARM * s / 2)))

    fg_a = max(fg_a, coverage(circle_dist(x, y, 0, 0, DOT_R * s)))
    fg_a = min(fg_a, bg_a)  # 배경 밖으로 나가지 않게 클리핑

    out_a = fg_a + bg_a * (1 - fg_a)
    if out_a <= 0:
        return (0, 0, 0, 0)
    r = (FG[0] * fg_a + BG[0] * bg_a * (1 - fg_a)) / out_a
    g = (FG[1] * fg_a + BG[1] * bg_a * (1 - fg_a)) / out_a
    b = (FG[2] * fg_a + BG[2] * bg_a * (1 - fg_a)) / out_a
    return (r, g, b, out_a * 255)


def render(s):
    """s×s 크기 RGBA 픽셀 버퍼 생성."""
    buf = bytearray()
    for iy in range(s):
        for ix in range(s):
            ar = ag = ab = aa = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = ix + (sx + 0.5) / SS - s / 2
                    y = iy + (sy + 0.5) / SS - s / 2
                    r, g, b, a = sample(x, y, s)
                    ar += r
                    ag += g
                    ab += b
                    aa += a
            n = SS * SS
            buf += bytes((round(ar / n), round(ag / n), round(ab / n), round(aa / n)))
    return buf


def write_png(path, s, buf):
    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

    stride = s * 4
    raw = b''.join(b'\x00' + bytes(buf[y * stride:(y + 1) * stride]) for y in range(s))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', s, s, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in SIZES:
        path = os.path.join(OUT_DIR, f'icon{s}.png')
        write_png(path, s, render(s))
        print(f'생성: {os.path.normpath(path)}')


if __name__ == '__main__':
    main()
