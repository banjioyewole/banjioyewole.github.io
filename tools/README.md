# Asset build scripts (not needed to run the site)

- `make_blobs.py` — extracts the four globules from `assets/reigonalpha6.jpg`, completes the
  silhouettes cropped by the frame, inflates them and writes the baked signed-distance volumes
  (`assets/hero3d/sdf_*.png`), colour textures and `blobs.json` used by `js/lava.js`.
  Needs numpy, scipy, scikit-image, opencv-python, pillow.
- `make_font.py OUT.json Roboto-Italic[wdth,wght].ttf` — builds the Roboto Black Italic
  subset (overlaps merged) used for the 3D name. Needs fonttools, opencv-python, numpy.
