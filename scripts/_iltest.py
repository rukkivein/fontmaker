"""Consolidated, FOCUS-SAFE Illustrator drive for FontMaker live testing.
Every keystroke/drag is gated on the foreground window belonging to the
Illustrator process — if focus was stolen, the step aborts instead of injecting
input into another app. Run as one process to minimize focus-steal windows.
"""
import ctypes, time, sys
ctypes.windll.user32.SetProcessDPIAware()
import win32api, win32con, win32gui, win32process, win32com.client

def ai_window():
    res = []
    def cb(h, _):
        if win32gui.GetWindowText(h) == 'Adobe Illustrator 2026': res.append(h)
    win32gui.EnumWindows(cb, None)
    return res[0] if res else None

H = ai_window()
if not H:
    print('NO_AI_WINDOW'); sys.exit(2)
_, AI_PID = win32process.GetWindowThreadProcessId(H)
shell = win32com.client.Dispatch('WScript.Shell')

def fg_pid():
    f = win32gui.GetForegroundWindow()
    try: _, p = win32process.GetWindowThreadProcessId(f); return p, win32gui.GetWindowText(f)
    except Exception: return 0, ''

def focus_ai():
    shell.SendKeys('%')
    try:
        win32gui.ShowWindow(H, win32con.SW_MAXIMIZE)
        win32gui.SetForegroundWindow(H)
    except Exception as e:
        print('fg_warn', e)
    time.sleep(0.7)

def ensure(label):
    p, t = fg_pid()
    ok = (p == AI_PID)
    print(('OK ' if ok else 'ABORT ') + label + ' | fg=' + repr(t) + ' pid=' + str(p) + ('' if ok else ' (expected ' + str(AI_PID) + ')'))
    return ok

def combo(*names):
    KEYS = {'ctrl': 0x11, 'shift': 0x10, 'alt': 0x12, 'enter': 0x0D}
    def vk(n): return KEYS.get(n.lower(), win32api.VkKeyScan(n) & 0xff if len(n) == 1 else KEYS.get(n.lower()))
    cs = [vk(n) for n in names]
    for c in cs[:-1]: win32api.keybd_event(c, 0, 0, 0)
    win32api.keybd_event(cs[-1], 0, 0, 0); time.sleep(0.04)
    win32api.keybd_event(cs[-1], 0, win32con.KEYEVENTF_KEYUP, 0)
    for c in reversed(cs[:-1]): win32api.keybd_event(c, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(0.05)

def press(ch):
    v = win32api.VkKeyScan(ch) & 0xff
    win32api.keybd_event(v, 0, 0, 0); win32api.keybd_event(v, 0, win32con.KEYEVENTF_KEYUP, 0); time.sleep(0.05)

def enter():
    win32api.keybd_event(0x0D, 0, 0, 0); win32api.keybd_event(0x0D, 0, win32con.KEYEVENTF_KEYUP, 0); time.sleep(0.05)

def move(x, y): win32api.SetCursorPos((int(x), int(y)))
def drag(x1, y1, x2, y2):
    move(x1, y1); time.sleep(0.1)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0); time.sleep(0.1)
    for i in range(1, 19): move(x1 + (x2 - x1) * i / 18, y1 + (y2 - y1) * i / 18); time.sleep(0.02)
    time.sleep(0.1); win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0); time.sleep(0.1)

def shot(path='_shot.png'):
    import mss
    from PIL import Image
    with mss.mss() as sct:
        m = sct.monitors[1]; img = sct.grab(m)
        Image.frombytes('RGB', img.size, img.bgra, 'raw', 'BGRX').save(path)

# --- flow ---
print('AI_PID', AI_PID)
focus_ai()
if ensure('new-doc Ctrl+N'):
    combo('ctrl', 'n'); time.sleep(2.0)
    if ensure('confirm New Document (Enter)'):
        enter(); time.sleep(2.0)
focus_ai()
if ensure('rectangle tool M'):
    press('m'); time.sleep(0.3)
    if ensure('draw rectangle (drag)'):
        drag(1500, 800, 2300, 1500); time.sleep(0.4)
    if ensure('select all Ctrl+A'):
        combo('ctrl', 'a'); time.sleep(0.3)
shot('_shot.png')
print('DONE; foreground now', fg_pid())
