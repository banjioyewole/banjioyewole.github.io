# Asset build scripts (not needed to run the site)

- `make_blobs.py` — extracts the four globules from `assets/reigonalpha6.jpg`, completes the
  silhouettes cropped by the frame and pre-renders them for the lava lamp: 16-bit metaball
  field sprites (`assets/hero3d/field_*.png`), a colour atlas and `blobs.json`.
  Needs numpy, scipy, opencv-python, pillow.
- `make_font.py OUT.json Roboto-Italic[wdth,wght].ttf` — builds the Roboto Black Italic
  subset (overlaps merged) used for the 3D name. Needs fonttools, opencv-python, numpy.
