#!/usr/bin/env python3
"""Download the open/libre font corpus for the glyph recognizer.

Sources (all OFL / Apache / libre — safe to render & ship a derived model;
we never redistribute the font files, only the trained weights):
  - google/fonts            broad + display/handwriting/blackletter core (~1.6GB)
  - notofonts.github.io     all non-CJK Unicode scripts (~1.5GB)
  - Noto CJK release zips    Han/Kana/Hangul, compact (~234MB)
  - velvetyne org repos     experimental/display/decorative diversity (~0.5GB)

Resumable: skips anything already present. Network note: github + the Noto
release CDN are reachable here; pypi is not (irrelevant to this script).

Usage:  python download_fonts.py --out E:/glyphset/fonts
        python download_fonts.py --out E:/glyphset/fonts --skip velvetyne
"""
import argparse, json, os, shutil, stat, subprocess, sys, urllib.request, zipfile, glob


def force_rmtree(path):
    """Delete a tree even with git's read-only .git/objects (Windows): clear the
    read-only bit and retry, instead of silently skipping (which left the dir
    non-empty and broke re-clone)."""
    def onerr(func, p, exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except Exception:
            pass
    if os.path.isdir(path):
        shutil.rmtree(path, onerror=onerr)

REPOS = [
    ("google-fonts", "https://github.com/google/fonts.git"),
    ("noto", "https://github.com/notofonts/notofonts.github.io.git"),
]
CJK_ZIPS = [
    ("NotoSansCJK.ttc.zip", "https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/00_NotoSansCJK.ttc.zip"),
    ("NotoSerifCJK.ttc.zip", "https://github.com/notofonts/noto-cjk/releases/download/Serif2.003/01_NotoSerifCJK.ttc.zip"),
]


def run(cmd, **kw):
    print("  $", " ".join(cmd))
    return subprocess.run(cmd, **kw)


def count_fonts(d):
    n = 0
    for ext in ("*.ttf", "*.otf", "*.ttc", "*.otc"):
        n += len(glob.glob(os.path.join(d, "**", ext), recursive=True))
    return n


def looks_complete(dest):
    """A finished git clone: has a .git, real font files, and a CLEAN working tree
    (an interrupted checkout leaves a dirty/incomplete tree). Lets us keep an
    already-downloaded corpus instead of re-fetching it."""
    if not os.path.isdir(os.path.join(dest, ".git")) or count_fonts(dest) < 1:
        return False
    try:
        r = subprocess.run(["git", "-C", dest, "status", "--porcelain"],
                           capture_output=True, text=True, timeout=180)
        return r.returncode == 0 and r.stdout.strip() == ""
    except Exception:
        return False


def curl_download(url, dest, tries=4):
    """Robust large-file download. curl handles flaky links far better than git's
    index-pack (which corrupts: 'invalid index-pack output'). NOTE: no -C - resume
    — GitHub archive ZIPs are generated per-request so a resume offset mismatches;
    instead retry the whole download. --retry-all-errors covers GitHub's transient
    404s while it builds the archive; --speed-time aborts a stalled transfer."""
    for _ in range(tries):
        r = run(["curl", "-L", "--fail", "--retry", "5", "--retry-delay", "6",
                 "--retry-all-errors", "--speed-limit", "1000", "--speed-time", "60",
                 "-o", dest, url])
        if r.returncode == 0 and os.path.isfile(dest) and os.path.getsize(dest) > 100000:
            return True
    return False


def repo_slug(url):
    s = url.replace("https://github.com/", "").strip("/")
    if s.endswith(".git"):     # strip ONLY the trailing .git (not the .git inside .github!)
        s = s[:-4]
    return s.strip("/")


def zip_get(url, dest):
    """Download a repo as its GitHub archive ZIP (no git, no index-pack) and
    extract it into dest. Tries the main then master branch."""
    slug = repo_slug(url)
    for br in ("main", "master"):
        zurl = f"https://github.com/{slug}/archive/refs/heads/{br}.zip"
        ztmp = dest.rstrip("/\\") + f".{br}.zip"
        try:
            if curl_download(zurl, ztmp):
                force_rmtree(dest)
                os.makedirs(dest, exist_ok=True)
                with zipfile.ZipFile(ztmp) as z:
                    z.extractall(dest)
                if count_fonts(dest) > 0:
                    return True
        except Exception as e:
            print(f"  [zip {br} fail] {e}")
        finally:
            try:
                if os.path.exists(ztmp):
                    os.remove(ztmp)
            except Exception:
                pass
    return False


def shallow_clone(url, dest):
    # A ".fmcomplete" marker means a finished download. Without it, an existing
    # clean clone is kept + marked (never re-downloaded); a partial is wiped+redone.
    marker = os.path.join(dest, ".fmcomplete")
    if os.path.exists(marker):
        print(f"  [skip] {dest} complete")
        return True
    if os.path.isdir(dest):
        if looks_complete(dest):
            print(f"  [keep] {dest} already complete ({count_fonts(dest)} fonts) — marking, not re-downloading")
            open(marker, "w").close()
            return True
        print(f"  [partial] re-downloading {dest}")
        force_rmtree(dest)
    # ZIP archive first (curl, robust). git clone hangs (blob:none) or corrupts
    # (invalid index-pack) on big repos here, so it's only a fallback.
    if zip_get(url, dest):
        print(f"  [zip] {dest} ({count_fonts(dest)} fonts)")
        open(marker, "w").close()
        return True
    base = ["git", "-c", "http.lowSpeedLimit=2000", "-c", "http.lowSpeedTime=45",
            "clone", "--depth", "1", "--no-tags", url, dest]
    r = run(base)
    if r.returncode == 0:
        open(marker, "w").close()
        return True
    force_rmtree(dest)
    return False


def fetch(url, dest):
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        print(f"  [skip] {os.path.basename(dest)} present")
        return True
    print(f"  downloading {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=120) as r, open(dest + ".part", "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(dest + ".part", dest)
        return True
    except Exception as e:
        print(f"  [fail] {e}")
        return False


def velvetyne(out):
    dest = os.path.join(out, "velvetyne")
    os.makedirs(dest, exist_ok=True)
    try:
        req = urllib.request.Request("https://api.github.com/orgs/velvetyne/repos?per_page=100",
                                     headers={"User-Agent": "Mozilla/5.0", "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            repos = json.load(r)
    except Exception as e:
        print(f"  [velvetyne] repo list failed: {e}")
        return
    for repo in repos:
        name = repo.get("name")
        url = repo.get("clone_url")
        if not name or not url:
            continue
        sub = os.path.join(dest, name)
        if os.path.exists(os.path.join(sub, ".fmcomplete")):
            continue
        if os.path.isdir(sub):
            force_rmtree(sub)
        ok = zip_get(url, sub)
        if not ok:
            r = run(["git", "-c", "http.lowSpeedLimit=2000", "-c", "http.lowSpeedTime=45",
                     "clone", "--depth", "1", "--no-tags", url, sub])
            ok = (r.returncode == 0)
        if ok:
            open(os.path.join(sub, ".fmcomplete"), "w").close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="E:/glyphset/fonts")
    ap.add_argument("--skip", nargs="*", default=[], help="any of: google-fonts noto cjk velvetyne")
    args = ap.parse_args()
    out = args.out
    os.makedirs(out, exist_ok=True)

    for name, url in REPOS:
        if name in args.skip:
            continue
        print(f"[{name}]")
        shallow_clone(url, os.path.join(out, name))

    if "cjk" not in args.skip:
        print("[noto-cjk]")
        cjkdir = os.path.join(out, "noto-cjk")
        os.makedirs(cjkdir, exist_ok=True)
        marker = os.path.join(cjkdir, ".fmcomplete")
        if os.path.exists(marker):
            print("  [skip] noto-cjk complete")
        else:
            okall = True
            for fname, url in CJK_ZIPS:
                zpath = os.path.join(cjkdir, fname)
                if curl_download(url, zpath):
                    try:
                        with zipfile.ZipFile(zpath) as z:
                            z.extractall(cjkdir)
                        print(f"  extracted {fname}")
                    except Exception as e:
                        print(f"  [unzip fail] {e}"); okall = False
                else:
                    okall = False
            if okall:
                open(marker, "w").close()

    if "velvetyne" not in args.skip:
        print("[velvetyne]")
        velvetyne(out)

    # summary
    exts = ("*.ttf", "*.otf", "*.ttc", "*.otc")
    total = 0
    for ext in exts:
        total += len(glob.glob(os.path.join(out, "**", ext), recursive=True))
    size = sum(os.path.getsize(p) for p in glob.glob(os.path.join(out, "**", "*"), recursive=True) if os.path.isfile(p))
    print(f"\nCorpus: {total} font files, {size/1e9:.2f} GB under {out}")


if __name__ == "__main__":
    main()
