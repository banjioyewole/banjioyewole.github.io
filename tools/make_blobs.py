# Rebuild the four hero globules as closed, seamless 2D outlines.
# 1. segment each blob from the old wallpaper
# 2. blobs cropped by the wallpaper frame get their silhouette completed with a smooth
#    tangent-continuous curve (so they're whole blobs, not cut-off slabs)
# 3. signed distance to that outline, baked into one atlas for js/blobs.js
# 4. soft shading: the outline inflated like a balloon and lit, baked alongside it
# 4. colour texture: cleaned wallpaper colours, extended (inpainted) into the completed parts
import numpy as np, cv2, json, struct, sys
from scipy import ndimage, sparse
from scipy.sparse.linalg import spsolve
from PIL import Image

import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets/reigonalpha6.jpg')
OUT = os.path.join(ROOT, 'assets/hero3d/')

img = cv2.imread(SRC)
H0, W0 = img.shape[:2]
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
m = (hsv[..., 2] > 70).astype(np.uint8) * 255
m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
n, lab, st, cen = cv2.connectedComponentsWithStats(m)
order = np.argsort(-st[1:, 4])[:4] + 1

clean = cv2.bilateralFilter(cv2.medianBlur(img, 9), 9, 30, 9)

PAD = 1600  # canvas margin so completed shapes can extend past the frame
def resample(pts, step):
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
    t = np.arange(0, d[-1], step)
    return np.stack([np.interp(t, d, pts[:, 0]), np.interp(t, d, pts[:, 1])], 1)

def complete_silhouette(mask_full, belly=None):
    """mask_full: HxW uint8 in image coords. Returns closed contour (N,2) in image coords.
    belly: (point, degrees): close the shape with a round ball leaving that point in a straight line
    to the screen's edge, at that angle."""
    c, _ = cv2.findContours(mask_full, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(c, key=cv2.contourArea)[:, 0, :].astype(float)
    on_frame = (c[:, 0] <= 1) | (c[:, 0] >= W0 - 2) | (c[:, 1] <= 1) | (c[:, 1] >= H0 - 2)
    if not on_frame.any():
        return c
    # rotate so the frame run is contiguous at the end
    k = np.where(~on_frame)[0]
    # first index after a frame run
    starts = [i for i in k if on_frame[i - 1]]
    s = starts[0]
    c = np.roll(c, -s, 0); on_frame = np.roll(on_frame, -s)
    last = np.where(~on_frame)[0].max()
    curve = c[:last + 1]
    curve = resample(curve, 4.0)
    # trim a little off both ends (pixels hugging the frame bend toward it)
    trim = 25
    curve = curve[trim:-trim]
    A, B = curve[-1], curve[0]
    tA = curve[-1] - curve[-30]; tA /= np.linalg.norm(tA)
    tB = curve[0] - curve[29]; tB /= np.linalg.norm(tB)     # both point out of the visible curve
    # carry both edges straight on until they're well past the frame, so the part that closes
    # the shape stays out of sight, then join them with a curve aimed where the edges would meet
    gap = np.linalg.norm(B - A)
    if belly is not None:
        # leave the edge a little before the wallpaper ends, along its general direction: its last
        # stretch bends outward, and following that into the turn leaves a notch
        lower_first = curve[0][1] > curve[-1][1]
        curve = curve[50:] if lower_first else curve[:-50]
        A, B = curve[-1], curve[0]
        if lower_first:
            tB = curve[0] - curve[90]; tB /= np.linalg.norm(tB)
        else:
            tA = curve[-1] - curve[-91]; tA /= np.linalg.norm(tA)
        # top edge's end → out of sight → straight back in along the bottom line → round the ball → right edge
        start, degrees = belly
        L = np.array(start, float)
        heading = np.array([np.cos(np.radians(degrees)), np.sin(np.radians(degrees))])   # right and down
        E = L - heading * (L[0] + 150) / heading[0]                                       # 150px past the screen's edge
        bezier = lambda a, b, c, d: (lambda t: (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d)(np.linspace(0, 1, 300)[:, None])
        hidden, ball = np.linalg.norm(E - A) * 0.45, np.linalg.norm(B - L) * 0.5
        join = np.vstack([bezier(A, A + tA * hidden, E - heading * hidden, E),
                          np.linspace(E, L, 100)[1:],
                          bezier(L, L + heading * ball, B + tB * ball, B)[1:]])
        closed = np.vstack([curve, join[1:-1]])
        closed = resample(np.vstack([closed, closed[:1]]), 4.0)[:-1]
        return np.stack([ndimage.gaussian_filter1d(closed[:, i], 12, mode='wrap') for i in range(2)], 1)
    ext = max(250, gap * 0.3)
    Ae, Be = A + tA * ext, B + tB * ext
    mid = (Ae + Be) / 2
    out = mid - curve.mean(0); out /= np.linalg.norm(out)
    ctrl = mid + out * ext
    det = tA[0] * tB[1] - tA[1] * tB[0]
    if abs(det) > 0.05:
        u = ((Be - Ae)[0] * tB[1] - (Be - Ae)[1] * tB[0]) / det
        w = ((Be - Ae)[0] * tA[1] - (Be - Ae)[1] * tA[0]) / det
        if 0 < u < gap * 1.5 and 0 < w < gap * 1.5:
            ctrl = Ae + tA * u
    # edges leaving through different sides of the frame: go around the frame corner between them
    near_x = lambda P: 0 if P[0] < 130 else W0 if P[0] > W0 - 130 else None
    near_y = lambda P: 0 if P[1] < 130 else H0 if P[1] > H0 - 130 else None
    cx = near_x(A) if near_x(A) is not None else near_x(B)
    cy = near_y(A) if near_y(A) is not None else near_y(B)
    if cx is not None and cy is not None:
        margin = 200
        corner = np.array([cx - margin if cx == 0 else cx + margin, cy - margin if cy == 0 else cy + margin], float)
        ctrl = 2 * corner - mid      # makes the curve pass through this point
    t = np.linspace(0, 1, 200)[:, None]
    join = (1 - t) ** 2 * Ae + 2 * (1 - t) * t * ctrl + t ** 2 * Be
    closed = np.vstack([curve, join])
    closed = resample(np.vstack([closed, closed[:1]]), 4.0)[:-1]
    # smooth the joins (circular gaussian on the point list)
    sig = 12
    closed = np.stack([ndimage.gaussian_filter1d(closed[:, i], sig, mode='wrap') for i in range(2)], 1)
    return closed

def balloon_shading(sil):
    """Lighting of the outline inflated into a dome, -1..0.5 relative to a surface facing the viewer.

    Taking slopes from the distance to the edge would crease along the middle of long shapes,
    where the nearest edge flips sides. Solving Poisson's equation (the shape of an inflated
    membrane) gives a surface with no such ridge.
    """
    k = TILE / max(sil.shape)
    gw, gh = max(2, round(sil.shape[1] * k)), max(2, round(sil.shape[0] * k))
    inside = cv2.resize(sil, (gw, gh), interpolation=cv2.INTER_AREA) > 127
    ids = -np.ones(inside.shape, int); ids[inside] = np.arange(inside.sum())
    yy, xx = np.nonzero(inside)
    rows, cols = [np.arange(len(yy))], [np.arange(len(yy))]
    vals = [np.full(len(yy), 4.0)]
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = yy + dy, xx + dx
        ok = (ny >= 0) & (ny < gh) & (nx >= 0) & (nx < gw)
        nb = np.full(len(yy), -1); nb[ok] = ids[ny[ok], nx[ok]]
        good = nb >= 0
        rows.append(np.arange(len(yy))[good]); cols.append(nb[good]); vals.append(-np.ones(good.sum()))
    A = sparse.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(len(yy),) * 2)
    u = np.zeros(inside.shape); u[inside] = spsolve(A.tocsc(), np.ones(len(yy)))
    h = ndimage.gaussian_filter(1.75 * np.sqrt(np.maximum(u, 0)), 1.5)   # 2.0 would be a sphere for a disc
    dh_row, dh_col = np.gradient(h)
    n = np.dstack([-dh_col, dh_row, np.ones_like(h)])                    # x right, y up, z to the viewer
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    L = np.array([-0.6, 0.8, 1.0]); L /= np.linalg.norm(L)
    shade = n @ L - L[2]
    # carry the edge's shading outward, so antialiased edge pixels aren't shaded as flat
    idx = ndimage.distance_transform_edt(~inside, return_distances=False, return_indices=True)
    shade = ndimage.gaussian_filter(shade[idx[0], idx[1]], 1.0)
    return cv2.resize(shade.astype(np.float32), (TILE, TILE), interpolation=cv2.INTER_LINEAR)[::-1]   # row 0 = bottom

def carry_rim(col, sil, wallpaper_shape, frame_row, screen_left):
    """Below the wallpaper's edge there are no real colours: carry the rim's gradient, measured from
    the real outline just above that edge, along the completed outline, by distance from the outline.
    It starts higher up, where the completed outline has already left the real one."""
    DEPTH, REF, FADE_FROM, FADE_TO = 340, 70, 480, 200
    inside = sil > 127
    sd = (ndimage.distance_transform_edt(~inside) - ndimage.distance_transform_edt(inside)).astype(np.float32)
    # Deep inside, where the nearest edge flips sides, plain distance creases: use a blurred one there.
    # Right at the edge it stays exact, so the rim keeps its shape.
    ramp = lambda a, b, v: (lambda u: u * u * (3 - 2 * u))(np.clip((v - a) / (b - a), 0, 1))
    near_edge = ramp(-170, -30, sd)
    sd = near_edge * sd + (1 - near_edge) * cv2.GaussianBlur(sd, (0, 0), 70)
    row = frame_row - REF
    edge = np.nonzero(wallpaper_shape[row])[0].max()
    ds = np.arange(-DEPTH, 41)
    xs = np.clip(edge + ds, 0, col.shape[1] - 1)
    rim = cv2.GaussianBlur(col[row - 6:row + 7].astype(np.float32), (0, 0), 3)[6][xs]
    yy, xx = np.mgrid[:col.shape[0], :col.shape[1]]
    below = ramp(frame_row - FADE_FROM, frame_row - FADE_TO, yy)
    depth = ramp(-DEPTH, -DEPTH * 0.45, sd)
    around = ramp(screen_left - 160, screen_left, xx)   # all the way to the screen's edge
    weight = (below * depth * around)[..., None]
    idx = np.clip(np.round(sd + DEPTH).astype(int), 0, len(ds) - 1)
    return np.round((1 - weight) * col + weight * rim[idx]).astype(np.uint8)

# The bottom line leaves the ball 45° round from its lowest point and reaches the screen's edge at an
# angle close to the top edge's 24°, just below the wallpaper's bottom edge (2846), so the corner stays covered.
BL_BELLY = ((225, 3017), 28)
meta = []
texs = []
sdf_tiles = []
shade_tiles = []
TILE = 320   # outline resolution per blob
for idx in order:
    x, y, w, h, area = st[idx]
    cx, cy = cen[idx]
    name = ('t' if cy < H0 / 2 else 'b') + ('l' if cx < W0 / 2 else 'r')
    comp = (lab == idx).astype(np.uint8) * 255
    contour = complete_silhouette(comp, belly=BL_BELLY if name == 'bl' else None)   # bl's completed part is seen as it floats up

    # full silhouette on a padded canvas (image coords + PAD)
    canvas = np.zeros((H0 + 2 * PAD, W0 + 2 * PAD), np.uint8)
    cv2.fillPoly(canvas, [np.round((contour + PAD) * 4).astype(np.int32)], 255, lineType=cv2.LINE_AA, shift=2)
    ys, xs = np.where(canvas > 127)
    bx0, by0, bx1, by1 = xs.min() - 30, ys.min() - 30, xs.max() + 31, ys.max() + 31
    sil = canvas[by0:by1, bx0:bx1]
    bw, bh = sil.shape[1], sil.shape[0]
    ox, oy = bx0 - PAD, by0 - PAD  # bbox origin in image coords

    # ---- colour texture: wallpaper colours inside the frame, inpainted outside ----
    col = np.zeros((bh, bw, 3), np.uint8)
    known = np.zeros((bh, bw), np.uint8)
    ix0, iy0 = max(ox, 0), max(oy, 0)
    ix1, iy1 = min(ox + bw, W0), min(oy + bh, H0)
    col[iy0 - oy:iy1 - oy, ix0 - ox:ix1 - ox] = clean[iy0:iy1, ix0:ix1]
    inside_orig = np.zeros((bh, bw), np.uint8)
    inside_orig[iy0 - oy:iy1 - oy, ix0 - ox:ix1 - ox] = comp[iy0:iy1, ix0:ix1]
    known = cv2.erode(inside_orig, np.ones((9, 9), np.uint8))
    S = 0.2
    small = cv2.resize(col, None, fx=S, fy=S, interpolation=cv2.INTER_AREA)
    # only pixels entirely inside what's known: shrinking mixes the rest with the empty black around it
    ksmall = (cv2.resize(known, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_AREA) == 255).astype(np.uint8) * 255
    filled = cv2.inpaint(small, (ksmall == 0).astype(np.uint8), 12, cv2.INPAINT_TELEA)
    filled = cv2.GaussianBlur(filled, (0, 0), 3)
    filled = cv2.resize(filled, (bw, bh), interpolation=cv2.INTER_CUBIC)
    # feather from real to invented colours: the blobs drift, so this join can come into view
    fade = cv2.erode(known, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61, 61)))
    fade = cv2.GaussianBlur(fade.astype(np.float32) / 255, (0, 0), 18)[..., None]
    col = np.round(fade * col + (1 - fade) * filled).astype(np.uint8)
    if name == 'bl':
        col = carry_rim(col, sil, inside_orig, H0 - oy, -ox)
    TS = min(1.0, 1024 / max(bw, bh))
    tex = cv2.resize(cv2.cvtColor(col, cv2.COLOR_BGR2RGB), (int(bw * TS), int(bh * TS)), interpolation=cv2.INTER_AREA)
    Image.fromarray(tex).save(OUT + f'blob_{name}.webp', quality=88, method=6)

    # ---- signed distance to the outline (image px), negative inside, resampled to one tile ----
    inside = sil > 127
    sd = ndimage.distance_transform_edt(~inside) - ndimage.distance_transform_edt(inside)
    sd = cv2.GaussianBlur(sd.astype(np.float32), (0, 0), 2.5)
    tile = cv2.resize(sd, (TILE, TILE), interpolation=cv2.INTER_AREA)[::-1]   # row 0 = bottom (three.js y up)
    RANGE = max(bw, bh) * 0.25
    sdf_tiles.append(np.round((np.clip(tile / RANGE, -1, 1) * 0.5 + 0.5) * 4095).astype(np.uint16))
    shade_tiles.append(np.round((np.clip(balloon_shading(sil), -1, 0.5) + 1) / 1.5 * 255).astype(np.uint8))
    print(name, 'bbox', bw, bh, 'origin', ox, oy)
    meta.append(dict(name=name, x=int(ox), y=int(oy), w=int(bw), h=int(bh),
                     range=float(RANGE), rEq=float(np.sqrt(inside.sum() / np.pi))))
    texs.append(Image.open(OUT + f'blob_{name}.webp').convert('RGB').resize((512, 512), Image.LANCZOS))

# ---- one more globule, from its own image rather than the wallpaper ----
extra = np.asarray(Image.open(os.path.join(ROOT, 'tools/blob_extra.png')).convert('RGBA'))
PAD_EXTRA = 30
sil = np.pad(extra[..., 3], PAD_EXTRA)
rgb = np.pad(extra[..., :3], ((PAD_EXTRA, PAD_EXTRA), (PAD_EXTRA, PAD_EXTRA), (0, 0)))
# carry the colours out past the soft edge, so the outline never reads colour from empty pixels
idx = ndimage.distance_transform_edt(sil < 250, return_distances=False, return_indices=True)
rgb = rgb[idx[0], idx[1]]
inside = sil > 127
sd = ndimage.distance_transform_edt(~inside) - ndimage.distance_transform_edt(inside)
sd = cv2.GaussianBlur(sd.astype(np.float32), (0, 0), 2.5)
tile = cv2.resize(sd, (TILE, TILE), interpolation=cv2.INTER_AREA)[::-1]
bh, bw = sil.shape
RANGE = max(bw, bh) * 0.25
sdf_tiles.append(np.round((np.clip(tile / RANGE, -1, 1) * 0.5 + 0.5) * 4095).astype(np.uint16))
shade_tiles.append(np.round((np.clip(balloon_shading(sil), -1, 0.5) + 1) / 1.5 * 255).astype(np.uint8))
meta.append(dict(name='extra', x=0, y=0, w=int(bw), h=int(bh), range=float(RANGE), rEq=float(np.sqrt(inside.sum() / np.pi))))
texs.append(Image.fromarray(rgb.astype(np.uint8)).resize((512, 512), Image.LANCZOS))

atlas = Image.new('RGB', (512 * len(texs), 512))
for i, t in enumerate(texs): atlas.paste(t, (i * 512, 0))
atlas.save(OUT + 'blob_color_atlas.webp', quality=88, method=6)
# 12-bit linear distances: red = high byte, green = low bits. Linear matters: the GPU blends
# between texels, and blending a non-linear encoding would crease the edges at every texel.
# Blue holds the baked shading.
q = np.hstack(sdf_tiles)
Image.fromarray(np.dstack([q >> 4, (q & 15) << 4, np.hstack(shade_tiles)]).astype(np.uint8)).save(OUT + 'sdf_atlas.png', optimize=True)
json.dump(dict(imageW=W0, imageH=H0, blobs=meta), open(OUT + 'blobs.json', 'w'), indent=1)
