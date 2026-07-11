"""Manuscript image preprocessing — Test.html pipeline ka Phase-1 Python port.

Pipeline: background/illumination removal (division-normalize with iterative
ink-fill ~ morphological closing) -> CLAHE (local contrast) -> SOFT Sauvola
adaptive threshold (faded ink crisp, bleed-through/stains white; soft ramp
deliberately — vision LLMs anti-aliased strokes ko hard 1-bit se better
padhte hain) -> median despeckle.

NOTE: DESKEW yahan intentionally NAHI hai — deskew coordinates badal deta
hai aur block-coords ko wapas original frame me map karna padta hai (Test.html
me undeskewLines yehi karta hai). Wo Phase 3 me coordinate-mapping ke saath
aayega. Is function ke output ke dimensions input ke 1:1 SAME hain, isliye
vision model ke returned coordinates bina kisi mapping ke valid rehte hain.
"""
import numpy as np
import cv2
from PIL import Image


def enhance_for_ocr(pil_img):
    g = np.asarray(pil_img.convert("L"), dtype=np.float32)
    h, w = g.shape

    # -- background estimate: large blur + iterative ink-fill, taaki dense
    #    text background estimate ko neeche na kheenche --
    r = max(8, int(max(h, w) / 50)) * 2 + 1
    bg = cv2.blur(g, (r, r))
    for _ in range(2):
        filled = np.where(g < bg - 10, bg, g)
        bg = cv2.blur(filled, (r, r))
    norm = np.clip(g / np.maximum(bg, 1.0) * 245.0, 0, 255).astype(np.uint8)

    # -- CLAHE (local contrast) --
    eq = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8)).apply(norm).astype(np.float32)

    # -- SOFT Sauvola: threshold ke ±band me smooth ramp --
    win = max(15, int(max(h, w) / 60) | 1)
    mean = cv2.boxFilter(eq, cv2.CV_32F, (win, win))
    sq = cv2.boxFilter(eq * eq, cv2.CV_32F, (win, win))
    std = np.sqrt(np.maximum(0.0, sq - mean * mean))
    k, R, band = 0.22, 128.0, 12.0
    thr = mean * (1.0 + k * (std / R - 1.0))
    f = np.clip((eq - (thr - band)) / (2.0 * band), 0.0, 1.0)
    out = (eq * 0.35) * (1.0 - f) + 255.0 * f
    out = np.clip(out, 0, 255).astype(np.uint8)

    # -- despeckle --
    out = cv2.medianBlur(out, 3)
    return Image.fromarray(out).convert("RGB")
