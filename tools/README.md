# Asset build scripts (not needed to run the site)

- `make_blobs.py` — extracts the four globules from `assets/reigonalpha6.jpg`, completes the
  silhouettes cropped by the frame, adds the globule in `tools/blob_extra.png`, and writes the baked signed-distance atlas
  (`assets/hero3d/sdf_atlas.png`), colour textures and `blobs.json` used by `js/blobs.js`.
  Needs numpy, scipy, opencv-python, pillow.
- `make_font.py OUT.json [FONT.otf]` — builds the letter shapes for the 3D name
  (`assets/hero3d/hero_compact_text.json`) from an installed SF Compact Text Heavy Italic.
  Needs fonttools, uharfbuzz, opencv-python, numpy.
