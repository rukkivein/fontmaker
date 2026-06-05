"""Tiny hybrid desktop-automation helper for the FontMaker UXP testing.
computer-use screenshots fail on this 4K display, so we drive via Python:
mss for screenshots, win32 for clicks/keys. Physical-pixel coordinates.

Usage:
  python scripts/_auto.py shot out.png
  python scripts/_auto.py click X Y
  python scripts/_auto.py dclick X Y
  python scripts/_auto.py move X Y
  python scripts/_auto.py type "text"
  python scripts/_auto.py key enter
  python scripts/_auto.py foreground "Window Title Substring"
"""
import sys, time, ctypes
ctypes.windll.user32.SetProcessDPIAware()
import win32api, win32con, win32gui

def shot(path):
    import mss
    from PIL import Image
    with mss.mss() as sct:
        m = sct.monitors[1]
        img = sct.grab(m)
        Image.frombytes('RGB', img.size, img.bgra, 'raw', 'BGRX').save(path)
    print('saved', path, img.size)

def move(x, y):
    win32api.SetCursorPos((int(x), int(y)))

def click(x, y, double=False):
    move(x, y); time.sleep(0.08)
    for _ in range(2 if double else 1):
        win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        time.sleep(0.05)
    print('clicked', x, y, 'double' if double else '')

def type_text(text):
    for ch in text:
        vk = win32api.VkKeyScan(ch)
        if vk == -1:
            continue
        code = vk & 0xff
        shift = (vk >> 8) & 1
        if shift: win32api.keybd_event(win32con.VK_SHIFT, 0, 0, 0)
        win32api.keybd_event(code, 0, 0, 0)
        win32api.keybd_event(code, 0, win32con.KEYEVENTF_KEYUP, 0)
        if shift: win32api.keybd_event(win32con.VK_SHIFT, 0, win32con.KEYEVENTF_KEYUP, 0)
        time.sleep(0.01)
    print('typed', repr(text))

KEYS = {'enter': 0x0D, 'return': 0x0D, 'tab': 0x09, 'esc': 0x1B, 'escape': 0x1B,
        'space': 0x20, 'backspace': 0x08, 'delete': 0x2E}

def key(name):
    code = KEYS.get(name.lower())
    if code is None: print('unknown key', name); return
    win32api.keybd_event(code, 0, 0, 0)
    win32api.keybd_event(code, 0, win32con.KEYEVENTF_KEYUP, 0)
    print('key', name)

def foreground(substr):
    found = []
    def cb(h, _):
        if win32gui.IsWindowVisible(h):
            t = win32gui.GetWindowText(h)
            if substr.lower() in t.lower(): found.append((h, t))
    win32gui.EnumWindows(cb, None)
    if not found:
        print('no window matching', substr); return
    h, t = found[0]
    try:
        win32gui.ShowWindow(h, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(h)
    except Exception as e:
        print('foreground warn', e)
    r = win32gui.GetWindowRect(h)
    print('foreground', repr(t), 'rect', r)

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'shot': shot(sys.argv[2])
    elif cmd == 'click': click(float(sys.argv[2]), float(sys.argv[3]))
    elif cmd == 'dclick': click(float(sys.argv[2]), float(sys.argv[3]), double=True)
    elif cmd == 'move': move(float(sys.argv[2]), float(sys.argv[3]))
    elif cmd == 'type': type_text(sys.argv[2])
    elif cmd == 'key': key(sys.argv[2])
    elif cmd == 'foreground': foreground(sys.argv[2])
    else: print('unknown cmd', cmd)
