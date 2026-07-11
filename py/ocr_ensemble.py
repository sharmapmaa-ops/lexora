"""Ensemble OCR voting core — Test.html ke tested JS algorithms ka Python port.

Multiple vision models se same page ke blocks lekar:
  1. Hungarian (globally-optimal) bbox assignment se blocks match hote hain
  2. Weighted tiered agreement (strong >= 0.97 / near >= 0.85) par voting
  3. Near-agreement par token-level fusion + per-character consensus
     (glyph/rasm-aware: dots-only differences alignment nahi todte)
  4. Consensus na ho to anchor ka ORIGINAL preserve hota hai (no forcing)
  5. Recovery: anchor ne miss ki lekin 2 independent witnesses agree — add
  6. Dedupe: same visual block ki duplicate copies hatao

Sab pure-python, stdlib only. lease_engine par koi dependency nahi —
caller blocks deta hai, fused blocks wapas milte hain.
"""

# ---------------------------------------------------------------------
# Text normalisation + similarity
# ---------------------------------------------------------------------
import re as _re

_DIACRITICS = _re.compile(u"[\u064B-\u065F\u0670\u0640]")   # harakat + tatweel
_WS = _re.compile(r"\s+")


def norm_for_vote(s):
    s = _DIACRITICS.sub("", u"%s" % (s or ""))
    return _WS.sub(" ", s).strip()


def levenshtein(a, b):
    m, n = len(a), len(b)
    if not m:
        return n
    if not n:
        return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i] + [0] * n
        ca = a[i - 1]
        for j in range(1, n + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1,
                         prev[j - 1] + (0 if ca == b[j - 1] else 1))
        prev = cur
    return prev[n]


def similarity(a, b):
    m = max(len(a), len(b))
    if not m:
        return 1.0
    return 1.0 - levenshtein(a, b) / float(m)


# ---------------------------------------------------------------------
# Glyph similarity engine — stroke/rasm-based confusion groups
# (same group = same skeleton, sirf dots/hamza ka fark)
# ---------------------------------------------------------------------
GLYPH_GROUPS = [
    u"\u0628\u062a\u062b\u0646\u064a\u0626\u0649\u067e",
    u"\u062c\u062d\u062e\u0686",
    u"\u062f\u0630",
    u"\u0631\u0632\u0698",
    u"\u0633\u0634",
    u"\u0635\u0636",
    u"\u0637\u0638",
    u"\u0639\u063a",
    u"\u0641\u0642\u06a4",
    u"\u0643\u06af",
    u"\u0647\u0629",
    u"\u0648\u0624",
    u"\u0627\u0623\u0625\u0622\u0671",
]
GLYPH_MAP = {}
for _gi, _g in enumerate(GLYPH_GROUPS):
    for _ch in _g:
        GLYPH_MAP[_ch] = _gi


def glyph_sim(a, b):
    if a == b:
        return 1.0
    ga, gb = GLYPH_MAP.get(a), GLYPH_MAP.get(b)
    return 0.7 if (ga is not None and ga == gb) else 0.0


# ---------------------------------------------------------------------
# Per-character consensus (aligned + weighted, glyph-aware DP)
# ---------------------------------------------------------------------
def char_vote_stats(strings, weights):
    anchor = strings[0]
    if not anchor:
        return None
    cols = [[(ch, weights[0])] for ch in anchor]
    for c in range(1, len(strings)):
        b = strings[c]
        n, m = len(anchor), len(b)
        dp = [[0.0] * (m + 1) for _ in range(n + 1)]
        for i in range(n + 1):
            dp[i][0] = float(i)
        for j in range(m + 1):
            dp[0][j] = float(j)
        for i in range(1, n + 1):
            ai = anchor[i - 1]
            for j in range(1, m + 1):
                sub = dp[i - 1][j - 1] + (1.0 - glyph_sim(ai, b[j - 1]))
                dp[i][j] = min(sub, dp[i - 1][j] + 1.0, dp[i][j - 1] + 1.0)
        i, j = n, m
        while i > 0 and j > 0:
            sub = dp[i - 1][j - 1] + (1.0 - glyph_sim(anchor[i - 1], b[j - 1]))
            if abs(dp[i][j] - sub) < 1e-9:
                cols[i - 1].append((b[j - 1], weights[c]))
                i -= 1; j -= 1
            elif abs(dp[i][j] - (dp[i - 1][j] + 1.0)) < 1e-9:
                i -= 1
            else:
                j -= 1
    out, unresolved, dots_uncertain = [], 0, 0
    for col in cols:
        by_ch, total = {}, 0.0
        for ch, w in col:
            by_ch[ch] = by_ch.get(ch, 0.0) + w
            total += w
        best, bw = col[0][0], by_ch[col[0][0]]      # tie -> anchor char
        for ch, w in by_ch.items():
            if w > bw:
                bw, best = w, ch
        out.append(best)
        distinct = list(by_ch.keys())
        if len(distinct) > 1:
            g0 = GLYPH_MAP.get(distinct[0])
            same_rasm = g0 is not None and all(GLYPH_MAP.get(ch) == g0 for ch in distinct)
            if same_rasm:
                dots_uncertain += 1                  # skeleton pakka, nuqte nahi
            elif bw < 0.55 * total:
                unresolved += 1
    return {"text": "".join(out), "unresolved": unresolved,
            "dots_uncertain": dots_uncertain}


def tokenize(s):
    return [t for t in (u"%s" % (s or "")).strip().split() if t]


def token_vote(candidate_texts, weights):
    """Weighted token-level voting; token column me clean weighted majority
    (>= 55%% column weight) -> resolved; warna per-character consensus."""
    seqs = [tokenize(t) for t in candidate_texts]
    anchor = seqs[0]
    if not anchor:
        return None
    aligned = [[(t, weights[0])] for t in anchor]
    for c in range(1, len(seqs)):
        b = seqs[c]
        n, m = len(anchor), len(b)
        dp = [[0.0] * (m + 1) for _ in range(n + 1)]
        bt = [[0] * (m + 1) for _ in range(n + 1)]
        for i in range(n + 1):
            dp[i][0] = float(i)
        for j in range(m + 1):
            dp[0][j] = float(j)
        for i in range(1, n + 1):
            na = norm_for_vote(anchor[i - 1])
            for j in range(1, m + 1):
                sub = dp[i - 1][j - 1] + (1.0 - similarity(na, norm_for_vote(b[j - 1])))
                dele, ins = dp[i - 1][j] + 1.0, dp[i][j - 1] + 1.0
                if sub <= dele and sub <= ins:
                    dp[i][j], bt[i][j] = sub, 0
                elif dele <= ins:
                    dp[i][j], bt[i][j] = dele, 1
                else:
                    dp[i][j], bt[i][j] = ins, 2
        i, j = n, m
        while i > 0 and j > 0:
            if bt[i][j] == 0:
                if similarity(norm_for_vote(anchor[i - 1]), norm_for_vote(b[j - 1])) >= 0.5:
                    aligned[i - 1].append((b[j - 1], weights[c]))
                i -= 1; j -= 1
            elif bt[i][j] == 1:
                i -= 1
            else:
                j -= 1
    unresolved = 0
    out_tokens = []
    for col in aligned:
        if len(col) == 1:
            out_tokens.append(col[0][0])
            continue
        w_by, rep_by, total = {}, {}, 0.0
        for tok, w in col:
            k = norm_for_vote(tok)
            w_by[k] = w_by.get(k, 0.0) + w
            rep_by.setdefault(k, tok)
            total += w
        best_k, bw = None, 0.0
        for k, w in w_by.items():
            if w > bw:
                bw, best_k = w, k
        if bw >= 0.55 * total:
            out_tokens.append(rep_by[best_k])
        else:
            unresolved += 1
            cs = char_vote_stats([t for t, _ in col], [w for _, w in col])
            out_tokens.append(cs["text"] if cs else col[0][0])
    return {"text": " ".join(out_tokens), "unresolved": unresolved,
            "total": len(aligned)}


# ---------------------------------------------------------------------
# Spatial alignment — IoU pair score + Hungarian assignment
# ---------------------------------------------------------------------
MATCH_MIN_SCORE = 0.35


def _dims(b):
    return (b["left"], b["top"], b["right"] - b["left"], b["bottom"] - b["top"])


def pair_score(a, b):
    ax, ay, aw, ah = _dims(a)
    bx, by, bw, bh = _dims(b)
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    uni = aw * ah + bw * bh - inter
    iou = inter / uni if uni > 0 else 0.0
    max_h = max(ah, bh, 1.0)
    cy = 1.0 - min(1.0, abs((ay + ah / 2.0) - (by + bh / 2.0)) / (1.5 * max_h))
    max_w = max(aw, bw, 1.0)
    cx = 1.0 - min(1.0, abs((ax + aw / 2.0) - (bx + bw / 2.0)) / (0.8 * max_w))
    return 0.5 * iou + 0.3 * cy + 0.2 * cx


def hungarian(cost):
    """Classic O(n^3) (potentials + augmenting paths). Minimizes; returns
    row -> col assignment list for a square matrix."""
    n = len(cost)
    INF = 1e9
    u = [0.0] * (n + 1)
    v = [0.0] * (n + 1)
    p = [0] * (n + 1)
    way = [0] * (n + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [INF] * (n + 1)
        used = [False] * (n + 1)
        while True:
            used[j0] = True
            i0, delta, j1 = p[j0], INF, -1
            for j in range(1, n + 1):
                if used[j]:
                    continue
                cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(n + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while j0:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
    ans = [-1] * n
    for j in range(1, n + 1):
        if p[j] > 0:
            ans[p[j] - 1] = j - 1
    return ans


def assign_blocks(a, b):
    """a ki har block ke liye b me globally-optimal match index ya -1."""
    if not a or not b:
        return [-1] * len(a)
    n = max(len(a), len(b))
    cost = []
    for i in range(n):
        row = []
        for j in range(n):
            if i < len(a) and j < len(b):
                s = pair_score(a[i], b[j])
                row.append(1.0 - s if s >= MATCH_MIN_SCORE else 2.0)
            else:
                row.append(1.0)                      # dummy = unmatched
        cost.append(row)
    asn = hungarian(cost)
    out = [-1] * len(a)
    for i in range(len(a)):
        j = asn[i]
        if 0 <= j < len(b) and pair_score(a[i], b[j]) >= MATCH_MIN_SCORE:
            out[i] = j
    return out


# ---------------------------------------------------------------------
# Page-level voting over multi-model block lists
# ---------------------------------------------------------------------
def _txt(b):
    return u"%s" % (b.get("text") or "")


def _is_text(b):
    return (b.get("class") or "text") == "text" and _txt(b).strip()


def _best_translation(cands, fused_text):
    """Fused text ke sabse kareeb wale candidate ki translation lo —
    translation kabhi generate nahi karte, sirf models me se choose."""
    best, bs = None, -1.0
    nf = norm_for_vote(fused_text)
    for b in cands:
        s = similarity(norm_for_vote(_txt(b)), nf)
        if s > bs:
            bs, best = s, b
    return best.get("translation") if best else None


def vote_page(results, log=None, page_no=0, deep=False):
    """results: [{"model": str, "weight": float, "blocks": [block,...]}]
    Returns fused block list (anchor layout + voted text/translation).
    Kisi bhi single result par as-is wapas — graceful degradation."""
    log = log or (lambda m: None)
    results = [r for r in results if r.get("blocks")]
    if not results:
        return []
    if len(results) == 1:
        log(f"Page {page_no}: ensemble - only 1 model responded, voting skipped")
        return results[0]["blocks"]

    near_floor = 0.80 if deep else 0.85   # High Accuracy: zyada lines fusion me

    results.sort(key=lambda r: len(r["blocks"]))
    anchor = results[len(results) // 2]
    others = [r for r in results if r is not anchor]
    a_text = [b for b in anchor["blocks"] if _is_text(b)]
    o_text = [[b for b in o["blocks"] if _is_text(b)] for o in others]
    asn = [assign_blocks(a_text, ot) for ot in o_text]

    full = partial = disputed = 0
    for li, blk in enumerate(a_text):
        matches = []
        for oi, o in enumerate(others):
            j = asn[oi][li]
            if j != -1:
                mb = o_text[oi][j]
                matches.append({"blk": mb, "norm": norm_for_vote(_txt(mb)),
                                "weight": float(o.get("weight", 1.0))})
        if not matches:
            blk["ensemble"] = "unwitnessed"          # kisi aur model ne nahi dekha
            disputed += 1
            continue
        a_norm = norm_for_vote(_txt(blk))
        anchor_w = float(anchor.get("weight", 1.0))
        strong_w, strong_c, near_c = 0.0, 0, 0
        for m in matches:
            m["sim"] = similarity(a_norm, m["norm"])
            if m["sim"] >= 0.97:
                strong_w += m["weight"]; strong_c += 1
            if m["sim"] >= near_floor:
                near_c += 1
        if len(matches) >= 2 and strong_c == len(matches):
            blk["ensemble"] = "full-agree"; full += 1
        elif strong_w >= 1.0 or strong_c >= 1:
            blk["ensemble"] = "strong-support"; full += 1
        elif near_c >= 1:
            texts = [_txt(blk)] + [_txt(m["blk"]) for m in matches if m["sim"] >= near_floor]
            wts = [anchor_w] + [m["weight"] for m in matches if m["sim"] >= near_floor]
            tv = token_vote(texts, wts)
            if tv and tv["text"] and tv["text"] != _txt(blk):
                blk["alternatives"] = [_txt(blk)]
                tr = _best_translation([blk] + [m["blk"] for m in matches], tv["text"])
                blk["text"] = tv["text"]
                if tr:
                    blk["translation"] = tr
            blk["ensemble"] = "token-fused" + ("" if (tv and tv["unresolved"] == 0) else "-unresolved")
            partial += 1
        else:
            # weighted outvote: others ka strongly-agreeing cluster, combined
            # weight anchor se zyada AND >= 1.8 (kam se kam ~2 models)
            best_cl, best_w = None, 0.0
            for i, mi in enumerate(matches):
                cw = mi["weight"]
                for j, mj in enumerate(matches):
                    if i != j and similarity(mi["norm"], mj["norm"]) >= 0.97:
                        cw += mj["weight"]
                if cw > best_w:
                    best_w, best_cl = cw, mi
            if best_cl and best_w > anchor_w and best_w >= 1.8:
                blk["alternatives"] = [_txt(blk)]
                blk["text"] = _txt(best_cl["blk"])
                if best_cl["blk"].get("translation"):
                    blk["translation"] = best_cl["blk"]["translation"]
                blk["ensemble"] = "outvoted"
                partial += 1
            else:
                # CONSENSUS NAHI — original preserve, readings record (no forcing)
                blk["alternatives"] = [_txt(m["blk"]) for m in matches]
                blk["ensemble"] = "disputed"
                disputed += 1
                log(f"Page {page_no}: disputed block: " +
                    " | ".join([_txt(blk)[:30]] + [_txt(m['blk'])[:30] for m in matches]))

    # -- recovery: anchor ne miss ki, 2 independent witnesses agree --
    recovered = 0
    if len(others) >= 2:
        matched_sets = []
        for oi in range(len(others)):
            s = set(j for j in asn[oi] if j != -1)
            matched_sets.append(s)
        for pi in range(len(others)):
            for pj in range(pi + 1, len(others)):
                cross = assign_blocks(o_text[pi], o_text[pj])
                for mi, M in enumerate(o_text[pi]):
                    if mi in matched_sets[pi]:
                        continue
                    tj = cross[mi]
                    if tj == -1 or tj in matched_sets[pj]:
                        continue
                    twin = o_text[pj][tj]
                    if similarity(norm_for_vote(_txt(M)), norm_for_vote(_txt(twin))) < 0.9:
                        continue
                    m_cy = (M["top"] + M["bottom"]) / 2.0
                    m_h = M["bottom"] - M["top"]
                    m_txt = norm_for_vote(_txt(M))
                    dup = False
                    for A in a_text:
                        a_cy = (A["top"] + A["bottom"]) / 2.0
                        a_h = A["bottom"] - A["top"]
                        if (abs(a_cy - m_cy) < 2.5 * max(a_h, m_h) and
                                similarity(norm_for_vote(_txt(A)), m_txt) >= 0.7):
                            dup = True
                            break
                    if dup:
                        continue
                    M["ensemble"] = "recovered"
                    a_text.append(M)
                    anchor["blocks"].append(M)
                    recovered += 1

    log(f"Page {page_no}: ensemble voting - {full} agree, {partial} fused, "
        f"{disputed} disputed" + (f", {recovered} recovered" if recovered else ""))
    return anchor["blocks"]


# ---------------------------------------------------------------------
# Extraction orchestrator — lease_engine ko N models ke saath call karta hai
# ---------------------------------------------------------------------
DEFAULT_ENSEMBLE_MODELS = [
    ("google/gemini-2.5-flash", 1.0),
    ("anthropic/claude-sonnet-4.6", 1.1),
    ("openai/gpt-4o", 0.9),
    ("qwen/qwen2.5-vl-72b-instruct", 1.25),   # manuscript/handwriting specialist
]


def extract_page_ensemble(le, page_image, target_language, llm_config, log,
                          models=None, deep=False):
    """le.extract_page_layout_vision ko har model ke saath call karke voted
    blocks deta hai. Kisi bhi failure par jitne results mile unhi par
    voting (1 par as-is) — poori tarah graceful."""
    import copy
    models = models or DEFAULT_ENSEMBLE_MODELS
    results = []
    iw = ih = None
    for model_name, weight in models:
        try:
            cfg = copy.deepcopy(llm_config) if llm_config else {}
            if isinstance(cfg.get("openrouter"), dict):
                cfg["openrouter"]["model"] = model_name
            else:
                cfg["openrouter"] = {"model": model_name}
            blocks, w, h = le.extract_page_layout_vision(page_image, target_language, cfg)
            if blocks:
                results.append({"model": model_name, "weight": weight, "blocks": blocks})
                iw, ih = w, h
                log(f"ensemble: {model_name} -> {len(blocks)} block(s)")
            else:
                log(f"ensemble: {model_name} -> empty/refused")
        except Exception as err:
            log(f"ensemble: {model_name} FAILED: {err}")
    if not results:
        return None, page_image.width, page_image.height
    fused = vote_page(results, log=log, deep=deep)
    return fused, (iw or page_image.width), (ih or page_image.height)
