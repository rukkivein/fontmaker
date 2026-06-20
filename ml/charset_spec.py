#!/usr/bin/env python3
"""Class set for the RuneType glyph recognizer — the single source of truth.

Mirrors the app's shared/charsets.js ranges (so the model's labels line up with
the glyph slots the panel fills) and adds a configurable CJK Han tier. Emits an
ordered, de-duplicated class list -> classes.json, which BOTH the dataset
renderer and the in-panel onnxruntime-web inference load (model output index ->
char -> glyph slot by unicode).

Run:  python charset_spec.py --han gb2312l1 --out classes.json
Tiers: none | common (~app subset) | gb2312l1 (3755) | gb2312 (6763)
"""
import argparse, json, unicodedata


def rng(a, b):
    return list(range(a, b + 1))


def cps(*xs):
    return list(xs)


def chars(s):
    return [ord(c) for c in s]


# ---- non-Han scripts (exactly the charsets.js repertoire) -------------------
SCRIPTS = {
    "latinUpper": chars("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    "latinLower": chars("abcdefghijklmnopqrstuvwxyz"),
    # Latin-1 Supplement letters, minus × (00D7) and ÷ (00F7)
    "latinWest": [c for c in rng(0x00C0, 0x00FF) if c not in (0x00D7, 0x00F7)],
    "latinExtA": rng(0x0100, 0x017F),
    "vietnamese": rng(0x1EA0, 0x1EF9) + cps(0x01A0, 0x01A1, 0x01AF, 0x01B0, 0x0110, 0x0111),
    "cyrillic": rng(0x0410, 0x044F) + cps(0x0401, 0x0451),
    "greek": cps(0x0386, 0x0388, 0x0389, 0x038A, 0x038C, 0x038E, 0x038F)
    + [c for c in rng(0x0391, 0x03CE) if c != 0x03A2],
    "arabic": chars("ابتثجحخدذرزسشصضطظعغفقكلمنهوي"),
    "hebrew": chars("אבגדהוזחטיכךלמםנןסעפףצץקרשת"),
    "hiragana": chars("あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"),
    "katakana": chars("アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン"),
    "armenian": rng(0x0531, 0x0556) + rng(0x0561, 0x0586),
    "georgian": rng(0x10D0, 0x10FA),
    "thai": rng(0x0E01, 0x0E3A) + rng(0x0E40, 0x0E4E),
    "devanagari": rng(0x0905, 0x0939) + rng(0x093E, 0x094D),
    "hangulJamo": rng(0x3131, 0x3163),
    "numbers": chars("0123456789"),
    # punctuation / symbols / math / fractions (space U+0020 is intentionally excluded — no glyph)
    "punct": chars(".,;:!?'\"()-/&@#") + cps(0x2013, 0x2014, 0x2026, 0x2018, 0x2019, 0x201C, 0x201D),
    "punctExtra": chars("[]{}\\_") + cps(0x00AB, 0x00BB, 0x2039, 0x203A, 0x2022, 0x00B7, 0x00A1, 0x00BF),
    "symbols": chars("*") + cps(0x0024, 0x20AC, 0x00A3, 0x00A5, 0x00A2, 0x20BA, 0x00A4,
                                0x00A9, 0x00AE, 0x2122, 0x00A7, 0x00B6, 0x00B0, 0x2020, 0x2021),
    "math": chars("+<>=~^|") + cps(0x2212, 0x00D7, 0x00F7, 0x2260, 0x00B1, 0x2264, 0x2265,
                                   0x0025, 0x2030, 0x221A, 0x221E, 0x2248, 0x00B5, 0x03C0),
    "fractions": chars("½¼¾") + cps(0x2153, 0x2154, 0x215B, 0x215C, 0x215D, 0x215E, 0x2044,
                                    0x00B9, 0x00B2, 0x00B3, 0x2070, 0x2074, 0x2075, 0x2076,
                                    0x2077, 0x2078, 0x2079) + rng(0x2080, 0x2089),
}

# A coarse script tag per class (useful for a script-aware head / analysis).
SCRIPT_TAG = {
    "latinUpper": "latin", "latinLower": "latin", "latinWest": "latin",
    "latinExtA": "latin", "vietnamese": "latin", "cyrillic": "cyrillic",
    "greek": "greek", "arabic": "arabic", "hebrew": "hebrew",
    "hiragana": "kana", "katakana": "kana", "armenian": "armenian",
    "georgian": "georgian", "thai": "thai", "devanagari": "devanagari",
    "hangulJamo": "hangul", "numbers": "common", "punct": "common",
    "punctExtra": "common", "symbols": "common", "math": "common", "fractions": "common",
}


def gb2312_level1():
    """The 3755 GB2312 Level-1 'frequently used' hanzi, in standard order
    (rows/qu 16-55). Deterministic via the gb2312 codec."""
    out = []
    for row in range(16, 56):           # Level-1 occupies rows 16..55
        for col in range(1, 95):        # positions 1..94
            try:
                ch = bytes([0xA0 + row, 0xA0 + col]).decode("gb2312")
                if len(ch) == 1 and 0x4E00 <= ord(ch) <= 0x9FFF:
                    out.append(ord(ch))
            except Exception:
                pass
    return out


def gb2312_level2():
    out = []
    for row in range(56, 88):
        for col in range(1, 95):
            try:
                ch = bytes([0xA0 + row, 0xA0 + col]).decode("gb2312")
                if len(ch) == 1 and 0x4E00 <= ord(ch) <= 0x9FFF:
                    out.append(ord(ch))
            except Exception:
                pass
    return out


# A small everyday-Han tier (the app's own representative subset; ~170 chars).
HANZI_COMMON = ("的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对"
                "能而小多天然方还样想看好但平体高第因主同水力理化外门间什从分性面意美法民政经度等动两长所重")


def build(han_tier="gb2312l1"):
    classes = []          # list of dicts {cp, char, script}
    seen = set()

    def add(cp, script):
        if cp in seen:
            return
        ch = chr(cp)
        # skip control/format/space and unassigned
        cat = unicodedata.category(ch)
        if cat in ("Cc", "Cf", "Zs", "Cn"):
            return
        seen.add(cp)
        classes.append({"cp": cp, "char": ch, "script": script})

    for key, cplist in SCRIPTS.items():
        tag = SCRIPT_TAG[key]
        for cp in cplist:
            add(cp, tag)

    han = []
    if han_tier == "common":
        han = [ord(c) for c in HANZI_COMMON]
    elif han_tier == "gb2312l1":
        han = gb2312_level1()
    elif han_tier == "gb2312":
        han = gb2312_level1() + gb2312_level2()
    elif han_tier in ("none", ""):
        han = []
    else:
        raise SystemExit(f"unknown han tier: {han_tier}")
    for cp in han:
        add(cp, "han")

    return classes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--han", default="gb2312l1", help="none|common|gb2312l1|gb2312")
    ap.add_argument("--out", default="classes.json")
    args = ap.parse_args()
    classes = build(args.han)
    by_script = {}
    for c in classes:
        by_script[c["script"]] = by_script.get(c["script"], 0) + 1
    meta = {"version": 1, "han_tier": args.han, "img_size": 96,
            "count": len(classes), "by_script": by_script}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "classes": classes}, f, ensure_ascii=False)
    print(f"{len(classes)} classes  (han={args.han})")
    for k, v in sorted(by_script.items(), key=lambda kv: -kv[1]):
        print(f"  {k:12s} {v}")


if __name__ == "__main__":
    main()
