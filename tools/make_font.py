# Build a three.js typeface JSON subset of Roboto Black Italic with overlapping contours merged.
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.recordingPen import RecordingPen
import numpy as np, cv2, json, sys

# Roboto-Italic[wdth,wght].ttf from github.com/google/fonts (ofl/roboto)
SRC = sys.argv[2] if len(sys.argv) > 2 else 'Roboto-Italic[wdth,wght].ttf'
OUT = sys.argv[1]
TEXT = "BANJI OYEWOLE SOFTWARE CHEF"

f = TTFont(SRC)
inst = instancer.instantiateVariableFont(f, {'wght': 900, 'wdth': 100})
gs = inst.getGlyphSet(); cmap = inst.getBestCmap(); upm = inst['head'].unitsPerEm; hmtx = inst['hmtx']

def flatten(rec):
    contours = []; cur = []
    for op, args in rec:
        if op == 'moveTo': cur = [args[0]]
        elif op == 'lineTo': cur.append(args[0])
        elif op == 'qCurveTo':
            offs = list(args[:-1]); end = args[-1]
            for k, c in enumerate(offs):
                nx = end if k == len(offs) - 1 else ((c[0] + offs[k + 1][0]) / 2, (c[1] + offs[k + 1][1]) / 2)
                p0 = np.array(cur[-1]); c1 = np.array(c); p1 = np.array(nx)
                for t in np.linspace(0, 1, 25)[1:]:
                    cur.append(tuple((1 - t) ** 2 * p0 + 2 * (1 - t) * t * c1 + t * t * p1))
        elif op == 'curveTo':
            c1, c2, e = map(np.array, args); p0 = np.array(cur[-1])
            for t in np.linspace(0, 1, 25)[1:]:
                cur.append(tuple((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * c1 + 3 * (1 - t) * t * t * c2 + t ** 3 * e))
        elif op in ('closePath', 'endPath'):
            contours.append(np.array(cur)); cur = []
    return contours

def area(c):
    x, y = c[:, 0], c[:, 1]
    return 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)

SC = 4; PAD = 50
glyphs = {}
for ch in sorted(set(TEXT)):
    gn = cmap[ord(ch)]; adv = hmtx[gn][0]
    if ch == ' ':
        glyphs[ch] = dict(ha=adv, o=''); continue
    rec = RecordingPen(); gs[gn].draw(rec)
    cs = flatten(rec.value)
    allp = np.vstack(cs)
    xmin, ymin = allp.min(0) - PAD; xmax, ymax = allp.max(0) + PAD
    W = int((xmax - xmin) * SC) + 1; H = int((ymax - ymin) * SC) + 1
    img = np.zeros((H, W), np.uint8)
    topx = lambda c: np.round(np.stack([(c[:, 0] - xmin) * SC, (ymax - c[:, 1]) * SC], 1) * 16).astype(np.int32)
    # true non-zero winding via scanline crossings (contours here self-intersect)
    diff = np.zeros((H, W + 1), np.int32)
    ys = np.arange(H) + 0.5
    for c in cs:
        P = np.stack([(c[:, 0] - xmin) * SC, (ymax - c[:, 1]) * SC], 1)
        A = P; B = np.roll(P, -1, 0)
        for (x0, y0), (x1, y1) in zip(A, B):
            if y0 == y1: continue
            d = 1 if y1 > y0 else -1
            lo, hi = min(y0, y1), max(y0, y1)
            rows = ys[(ys >= lo) & (ys < hi)]
            if not len(rows): continue
            xs = x0 + (rows - y0) * (x1 - x0) / (y1 - y0)
            cols = np.clip(np.ceil(xs - 0.5).astype(int), 0, W)
            np.add.at(diff, ((rows - 0.5).astype(int), cols), d)
    wind = np.cumsum(diff, axis=1)[:, :W]
    img = (wind != 0).astype(np.uint8) * 255
    cnts, hier = cv2.findContours(img, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    o = []
    for k, c in enumerate(cnts):
        c = c[:, 0, :].astype(np.float32)
        ap = cv2.approxPolyDP(c.reshape(-1, 1, 2), 1.6, True)[:, 0, :]
        pts = np.stack([ap[:, 0] / SC + xmin, ymax - ap[:, 1] / SC], 1)
        is_hole = hier[0][k][3] != -1
        a = area(pts)
        if (not is_hole and a > 0) or (is_hole and a < 0):
            pts = pts[::-1]
        o += ['m', f'{pts[0][0]:.1f}', f'{pts[0][1]:.1f}']
        for p in pts[1:]:
            o += ['l', f'{p[0]:.1f}', f'{p[1]:.1f}']
        o += ['z']
    glyphs[ch] = dict(ha=adv, o=' '.join(o))
    print(ch, len(cs), '->', len(cnts), 'contours,', sum(1 for x in o if x == 'l'), 'pts')

hh = inst['hhea']
data = dict(glyphs=glyphs, familyName='Roboto Black Italic (subset, overlaps removed)',
            ascender=hh.ascent, descender=hh.descent, underlinePosition=-150, underlineThickness=100,
            boundingBox=dict(xMin=-1500, yMin=-555, xMax=2500, yMax=2163), resolution=upm,
            original_font_information=dict(license='SIL Open Font License 1.1 (Roboto, Google) - see ROBOTO_OFL.txt'))
json.dump(data, open(OUT, 'w'), separators=(',', ':'))
