#!/usr/bin/env python3
"""Extract real horizontal kern (XAdvance applied to the FIRST glyph) for a given set of glyph
names from a font's GPOS PairPos (LookupType 2, formats 1 & 2, including Extension type 9) and,
as a fallback, the legacy 'kern' table (format 0). Returns {(gnameL, gnameR): kern_units}.

Only pairs among the caller's `allowed_pairs` are queried, so class-2 lookups never need
expansion (we just read Class1Record[class(a)].Class2Record[class(b)]). Best-effort: any
malformed table/record is skipped, never raised — a font with junk GPOS simply yields fewer pairs.

This is the REAL foundry kerning that Track B pretrains on so the model proposes what a real type
designer would do (and learns, correctly, that flat pairs like H-H get ~no kern) — then kernvision
verifies it optically. Used by render_kernpair.py; unit-tested in test via the Windows corpus.
"""


def _xadv(v):
    return int(getattr(v, "XAdvance", 0) or 0) if v is not None else 0


def _pairpos_value(st, a, b):
    fmt = getattr(st, "Format", 0)
    if fmt == 1:
        cov = st.Coverage.glyphs
        try:
            i = cov.index(a)
        except ValueError:
            return 0
        for pvr in st.PairSet[i].PairValueRecord:
            if pvr.SecondGlyph == b:
                return _xadv(getattr(pvr, "Value1", None))
        return 0
    if fmt == 2:
        if a not in st.Coverage.glyphs:
            return 0
        c1 = st.ClassDef1.classDefs if st.ClassDef1 else {}
        c2 = st.ClassDef2.classDefs if st.ClassDef2 else {}
        i = c1.get(a, 0); j = c2.get(b, 0)
        try:
            return _xadv(getattr(st.Class1Record[i].Class2Record[j], "Value1", None))
        except Exception:
            return 0
    return 0


def gpos_subtables(tt):
    """All PairPos subtables (unwrapping Extension lookups), in application order."""
    subs = []
    try:
        if "GPOS" in tt and tt["GPOS"].table and tt["GPOS"].table.LookupList:
            for lk in tt["GPOS"].table.LookupList.Lookup:
                lt = lk.LookupType
                for st in lk.SubTable:
                    if lt == 2:
                        subs.append(st)
                    elif lt == 9 and getattr(st, "ExtSubTable", None) is not None and st.ExtSubTable.LookupType == 2:
                        subs.append(st.ExtSubTable)
    except Exception:
        pass
    return subs


def gpos_kern(tt, allowed_pairs):
    """allowed_pairs: iterable of (gnameL, gnameR). Returns {(gnameL,gnameR): kern_units}."""
    out = {}
    subs = gpos_subtables(tt)
    if subs:
        for (a, b) in allowed_pairs:
            v = 0
            for st in subs:
                try:
                    vv = _pairpos_value(st, a, b)
                except Exception:
                    vv = 0
                if vv:
                    v = vv                      # later lookups override earlier (application order)
            if v:
                out[(a, b)] = v
    if not out:                                  # legacy 'kern' (format 0) fallback
        try:
            aset = set(p[0] for p in allowed_pairs); bset = set(p[1] for p in allowed_pairs)
            for kt in tt["kern"].kernTables:
                if getattr(kt, "format", 0) == 0:
                    for (l, r), val in kt.kernTable.items():
                        if val and l in aset and r in bset:
                            out[(l, r)] = int(val)
        except Exception:
            pass
    return out
