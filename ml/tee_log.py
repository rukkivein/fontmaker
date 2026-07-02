#!/usr/bin/env python3
"""Tiny tee: copy stdin to BOTH the console and an appended log file, line-buffered, so a piped
training run shows live progress on screen AND keeps a persistent log. Usage: ... | python tee_log.py LOGPATH"""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "run.log"
f = open(path, "a", encoding="utf-8", errors="replace")
try:
    for line in iter(sys.stdin.readline, ""):
        sys.stdout.write(line); sys.stdout.flush()
        f.write(line); f.flush()
except (KeyboardInterrupt, BrokenPipeError):
    pass
finally:
    f.close()
