# Pre-render the four hero globules for the lava lamp (js/lava.js).
# 1. segment each blob from the old wallpaper
# 2. blobs cropped by the wallpaper frame get their silhouette completed with a smooth
#    tangent-continuous curve (so they're whole blobs, not cut-off slabs)
# 3. pre-render a 16-bit metaball field sprite: Poisson "balloon" dome inside the silhouette,
#    soft falloff outside (field_*.png, R = high byte, G = low byte)
# 4. colour: cleaned wallpaper colours, extended (inpainted) into the completed parts,
#    packed into blob_color_atlas.webp
import numpy as np, cv2, json, struct, sys
from scipy import ndimage, sparse
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

def complete_silhouette(mask_full):
    """mask_full: HxW uint8 in image coords. Returns closed contour (N,2) in image coords."""
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
    tA = curve[-1] - curve[-12]; tA /= np.linalg.norm(tA)
    tB = curve[11] - curve[0]; tB /= np.linalg.norm(tB)
    L = np.linalg.norm(B - A) * 0.62
    P0, P1, P2, P3 = A, A + tA * L, B - tB * L, B
    t = np.linspace(0, 1, 200)[:, None]
    bez = (1 - t) ** 3 * P0 + 3 * (1 - t) ** 2 * t * P1 + 3 * (1 - t) * t ** 2 * P2 + t ** 3 * P3
    closed = np.vstack([curve, bez[1:-1]])
    closed = resample(np.vstack([closed, closed[:1]]), 4.0)[:-1]
    # smooth the joins (circular gaussian on the point list)
    sig = 6
    closed = np.stack([ndimage.gaussian_filter1d(closed[:, i], sig, mode='wrap') for i in range(2)], 1)
    return closed

def _unused_taubin(V, F, iters=12, lam=0.5, mu=-0.53):
    nV = len(V)
    i = np.r_[F[:, 0], F[:, 1], F[:, 2], F[:, 1], F[:, 2], F[:, 0]]
    j = np.r_[F[:, 1], F[:, 2], F[:, 0], F[:, 0], F[:, 1], F[:, 2]]
    A = sparse.coo_matrix((np.ones(len(i)), (i, j)), shape=(nV, nV)).tocsr()
    A.data[:] = 1
    deg = np.asarray(A.sum(1)).ravel(); deg[deg == 0] = 1
    Dinv = sparse.diags(1 / deg)
    Wm = Dinv @ A
    for _ in range(iters):
        V = V + lam * (Wm @ V - V)
        V = V + mu * (Wm @ V - V)
    return V

meta = []
texs = []
PADV = 6
for idx in order:
    x, y, w, h, area = st[idx]
    cx, cy = cen[idx]
    name = ('t' if cy < H0 / 2 else 'b') + ('l' if cx < W0 / 2 else 'r')
    comp = (lab == idx).astype(np.uint8) * 255
    contour = complete_silhouette(comp)

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
    ksmall = cv2.resize(known, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
    filled = cv2.inpaint(small, (ksmall == 0).astype(np.uint8), 12, cv2.INPAINT_TELEA)
    filled = cv2.GaussianBlur(filled, (0, 0), 3)
    filled = cv2.resize(filled, (bw, bh), interpolation=cv2.INTER_CUBIC)
    col = np.where(known[..., None] > 0, col, filled)
    TS = min(1.0, 1024 / max(bw, bh))
    tex = cv2.resize(cv2.cvtColor(col, cv2.COLOR_BGR2RGB), (int(bw * TS), int(bh * TS)), interpolation=cv2.INTER_AREA)
    tex_img = Image.fromarray(tex)

    # ---- 2D metaball field sprite (pre-rendered) ----
    # F = T on the silhouette; inside it rises as a Poisson "balloon" dome (sqrt(u)), outside it
    # falls to 0 over a margin M — the same contract as the wax globules' procedural falloff,
    # so the originals merge with them seamlessly in js/lava.js.
    T = 0.25
    area_px = (sil > 127).sum()
    r2d = float(np.sqrt(area_px / np.pi))          # area-equivalent radius (local px)
    M = 0.42 * r2d                                  # outside falloff, matches a ball's (1-x²)² skirt
    FR = 256                                        # sprite texels on the long side
    SS = 3                                          # supersampling for a sub-texel smooth edge
    q = (max(bw, bh) + 2 * M) / FR                  # local px per output texel
    EW0, EH0 = int(np.ceil((bw + 2 * M) / q)), int(np.ceil((bh + 2 * M) / q))
    EW, EH = EW0 * SS, EH0 * SS
    q = q / SS
    padpx = int(np.ceil(M))
    silp = cv2.copyMakeBorder(sil, padpx, padpx, padpx, padpx, cv2.BORDER_CONSTANT, value=0)
    frac = cv2.resize(silp, (EW, EH), interpolation=cv2.INTER_AREA).astype(float) / 255
    inside = frac > 0.5
    ids = -np.ones(inside.shape, int); ids[inside] = np.arange(inside.sum())
    yy, xx = np.nonzero(inside)
    rows = [np.arange(len(yy))]; cols = [np.arange(len(yy))]; vals = [np.full(len(yy), 4.0)]
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = yy + dy, xx + dx
        ok = (ny >= 0) & (ny < EH) & (nx >= 0) & (nx < EW)
        nb = np.full(len(yy), -1); nb[ok] = ids[ny[ok], nx[ok]]
        good = nb >= 0
        rows.append(np.arange(len(yy))[good]); cols.append(nb[good]); vals.append(-np.ones(good.sum()))
    Am = sparse.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(len(yy),) * 2)
    from scipy.sparse.linalg import spsolve
    u = np.zeros(inside.shape); u[inside] = spsolve(Am.tocsc(), np.ones(len(yy)))
    hn = np.sqrt(np.maximum(u, 0)); hn /= hn.max()
    # sub-texel signed distance to the silhouette (texels), from the antialiased coverage
    dout = ndimage.distance_transform_edt(~inside) - 0.5 + (0.5 - frac).clip(-0.5, 0.5) * (~inside)
    s_px = np.maximum(dout, 0) * q
    Fin = T + (1 - T) * hn
    # match the outside falloff's slope to the inside slope at the edge (no kink at the
    # threshold, so the bilinear-upsampled field gives a smooth, sub-texel outline)
    gyi, gxi = np.gradient(Fin)
    edge = inside & ~ndimage.binary_erosion(inside, iterations=2)
    k_in = np.median(np.hypot(gxi, gyi)[edge]) / q          # per local px
    M = float(np.clip(2 * T / k_in, 0.12 * r2d, 0.42 * r2d))
    F = np.where(inside, Fin, T * np.clip(1 - s_px / M, 0, 1) ** 2)
    F = ndimage.gaussian_filter(F, 0.5 * SS)
    F = F.reshape(EH0, SS, EW0, SS).mean(axis=(1, 3))   # area-average down to the sprite size
    EW, EH, q = EW0, EH0, q * SS
    F16 = np.round(np.clip(F, 0, 1) * 65535).astype(np.uint32)[::-1]   # row 0 = bottom (y up)
    enc = np.dstack([(F16 >> 8).astype(np.uint8), (F16 & 255).astype(np.uint8), np.zeros_like(F16, np.uint8)])
    Image.fromarray(enc).save(OUT + f'field_{name}.png', optimize=True)
    # equivalent wax radius when it melts (area-preserving, so it doesn't jump in size)
    meta.append(dict(name=name, x=int(ox), y=int(oy), w=int(bw), h=int(bh),
                     field=dict(w=EW, h=EH, x0=float(-bw / 2 - padpx), y0=float(-bh / 2 - padpx),
                                x1=float(-bw / 2 - padpx + EW * q), y1=float(-bh / 2 - padpx + EH * q)),
                     r2d=r2d, T=T))
    print(name, 'field', EW, EH, 'q', round(q, 2), 'r2d', round(r2d), 'M', round(M), 'k_in', k_in)
    texs.append(tex_img.convert('RGB').resize((512, 512), Image.LANCZOS))

atlas = Image.new('RGB', (512 * len(texs), 512))
for i, t in enumerate(texs): atlas.paste(t, (i * 512, 0))
atlas.save(OUT + 'blob_color_atlas.webp', quality=88, method=6)
json.dump(dict(imageW=W0, imageH=H0, blobs=meta), open(OUT + 'blobs.json', 'w'), indent=1)
