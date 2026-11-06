# Rebuild the four hero globules as closed, seamless 3D blobs.
# 1. segment each blob from the old wallpaper
# 2. blobs cropped by the wallpaper frame get their silhouette completed with a smooth
#    tangent-continuous curve (so they're whole blobs, not cut-off slabs)
# 3. inflate the silhouette into a 3D occupancy volume, blur it, marching-cubes it,
#    then Taubin-smooth → one watertight surface with no rim seam
# 4. colour texture: cleaned wallpaper colours, extended (inpainted) into the completed parts
import numpy as np, cv2, json, struct, sys
from scipy import ndimage, sparse
from skimage import measure
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

def taubin(V, F, iters=12, lam=0.5, mu=-0.53):
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
    Image.fromarray(tex).save(OUT + f'blob_{name}.webp', quality=88, method=6)

    # ---- inflate into a volume ----
    N = 110  # voxels on the long side
    vs = max(bw, bh) / N  # px per voxel
    gw, gh = int(np.ceil(bw / vs)), int(np.ceil(bh / vs))
    s2 = cv2.resize(sil, (gw, gh), interpolation=cv2.INTER_AREA).astype(float) / 255
    s2b = (s2 > 0.5).astype(np.uint8)
    # balloon inflation: solve ∇²u = -1 inside the silhouette (u = 0 outside). sqrt(u) is an
    # exact hemisphere for a disc and a round tube for a strip — smooth, with no medial ridge.
    inside = s2b > 0
    ids = -np.ones(inside.shape, int); ids[inside] = np.arange(inside.sum())
    yy, xx = np.nonzero(inside)
    rows = [np.arange(len(yy))]; cols = [np.arange(len(yy))]; vals = [np.full(len(yy), 4.0)]
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = yy + dy, xx + dx
        ok = (ny >= 0) & (ny < gh) & (nx >= 0) & (nx < gw)
        nb = np.full(len(yy), -1); nb[ok] = ids[ny[ok], nx[ok]]
        good = nb >= 0
        rows.append(np.arange(len(yy))[good]); cols.append(nb[good]); vals.append(-np.ones(good.sum()))
    Am = sparse.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(len(yy),) * 2)
    from scipy.sparse.linalg import spsolve
    u = np.zeros(inside.shape); u[inside] = spsolve(Am.tocsc(), np.ones(len(yy)))
    half = 1.75 * np.sqrt(np.maximum(u, 0))   # 2.0 = sphere for a disc; slightly flattened
    zmax = int(np.ceil(half.max())) + 4
    zs = np.arange(-zmax, zmax + 1)
    vol = (np.abs(zs)[:, None, None] <= half[None, :, :]).astype(np.float32)
    vol = np.pad(vol, 6)
    vol = ndimage.gaussian_filter(vol, 2.6)
    verts, faces, normals, _ = measure.marching_cubes(vol, 0.5, step_size=1)
    verts -= 6
    # vol axes: (z, y, x) → image px, centred on bbox centre; three.js y up
    Z = (verts[:, 0] - zmax) * vs
    Y = verts[:, 1] * vs
    X = verts[:, 2] * vs
    V = np.stack([X - bw / 2, -(Y - bh / 2), Z], 1)
    F = faces[:, ::-1].copy()  # winding → outward normals in three.js
    V = taubin(V, F, iters=40)
    nv = len(V)
    print(name, 'verts', nv, 'tris', len(F), 'bbox', bw, bh, 'origin', ox, oy, 'thick', round(2 * half.max() * vs))
    # ---- signed distance volume (px), resampled to a fixed grid ----
    inside = vol > 0.5
    sdf_vox = ndimage.distance_transform_edt(~inside) - ndimage.distance_transform_edt(inside)
    sdf_vox = sdf_vox - np.sign(sdf_vox) * 0.5        # EDT counts to voxel centres
    # near the surface use the smooth field: d ≈ (0.5 - vol) / |∇vol| (sub-voxel accurate)
    gz, gy, gx = np.gradient(vol)
    gm = np.sqrt(gx * gx + gy * gy + gz * gz)
    near = (0.5 - vol) / np.maximum(gm, 1e-3)
    wnear = np.clip(1 - (np.abs(near) - 1.5) / 1.5, 0, 1) * (gm > 0.02)
    sdf_vox = wnear * near + (1 - wnear) * sdf_vox
    sdf_vox = ndimage.gaussian_filter(sdf_vox, 0.8)
    sdf_px = sdf_vox * vs
    nz, ny, nx = vol.shape
    GX, GY, GZ = 96, 96, 80
    zi = np.linspace(0, nz - 1, GZ); yi = np.linspace(0, ny - 1, GY); xi = np.linspace(0, nx - 1, GX)
    Zg, Yg, Xg = np.meshgrid(zi, yi, xi, indexing='ij')
    grid = ndimage.map_coordinates(sdf_px, [Zg, Yg, Xg], order=1)
    RANGE = max(bw, bh) * 0.25
    # sqrt encoding: most of the 8-bit precision sits near the surface (d = 0)
    g = np.clip(grid / RANGE, -1, 1)
    q8 = np.clip(np.round((np.sign(g) * np.sqrt(np.abs(g)) * 0.5 + 0.5) * 255), 0, 255).astype(np.uint8)  # (GZ, GY, GX), y down
    q8 = q8[:, ::-1, :]  # store with y up (row 0 = bottom) to match three.js
    tiles = np.zeros((10 * GY, 8 * GX), np.uint8)
    for k in range(GZ):
        r, c = divmod(k, 8)
        tiles[r * GY:(r + 1) * GY, c * GX:(c + 1) * GX] = q8[k]
    Image.fromarray(tiles).save(OUT + f'sdf_{name}.png', optimize=True)
    # box of the grid in blob-local px (centred on bbox centre, y up)
    X0 = -PADV * vs - bw / 2; X1 = X0 + (nx - 1) * vs
    Ytop = bh / 2 + PADV * vs; Y1 = Ytop - (ny - 1) * vs   # y index 0 is top
    Z0 = (-PADV - zmax) * vs; Z1 = Z0 + (nz - 1) * vs
    volume_px3 = inside.sum() * vs ** 3
    meta.append(dict(name=name, x=int(ox), y=int(oy), w=int(bw), h=int(bh),
                     box=[float(X0), float(Y1), float(Z0), float(X1), float(Ytop), float(Z1)],
                     range=float(RANGE), grid=[GX, GY, GZ],
                     rEq=float((3 * volume_px3 / (4 * np.pi)) ** (1 / 3))))
    texs.append(Image.open(OUT + f'blob_{name}.webp').convert('RGB').resize((512, 512), Image.LANCZOS))

atlas = Image.new('RGB', (512 * len(texs), 512))
for i, t in enumerate(texs): atlas.paste(t, (i * 512, 0))
atlas.save(OUT + 'blob_color_atlas.webp', quality=88, method=6)
json.dump(dict(imageW=W0, imageH=H0, blobs=meta), open(OUT + 'blobs.json', 'w'), indent=1)
