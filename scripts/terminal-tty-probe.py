"""Exercise actual painting and mouse input inside a disposable Brclio test PTY."""
import os
import queue
import re
import sys
import threading
import time


def terminal_input():
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        api = ctypes.windll.kernel32
        api.GetStdHandle.argtypes = [wintypes.DWORD]
        api.GetStdHandle.restype = wintypes.HANDLE
        api.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        api.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        stdin = api.GetStdHandle(-10)
        stdout = api.GetStdHandle(-11)
        input_mode, output_mode = wintypes.DWORD(), wintypes.DWORD()
        if not api.GetConsoleMode(stdin, ctypes.byref(input_mode)) or not api.GetConsoleMode(stdout, ctypes.byref(output_mode)):
            raise OSError("console mode not available")
        # The calling PowerShell may leave VT output processing off.
        if not api.SetConsoleMode(stdout, output_mode.value | 0x0001 | 0x0004):
            raise OSError("cannot enter VT output mode")
        # Enable VT input and mouse reporting, with Quick Edit and line/echo off.
        flags = (input_mode.value | 0x0200 | 0x0080 | 0x0010) & ~(0x0040 | 0x0002 | 0x0004)
        if not api.SetConsoleMode(stdin, flags):
            api.SetConsoleMode(stdout, output_mode.value)
            raise OSError("cannot enter VT input mode")

        def restore():
            api.SetConsoleMode(stdin, input_mode.value)
            api.SetConsoleMode(stdout, output_mode.value)

        return restore
    import termios
    import tty
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    return lambda: termios.tcsetattr(fd, termios.TCSANOW, saved)


def emit(text):
    sys.stdout.write(text)
    sys.stdout.flush()


def read_packets(packets):
    while True:
        chunk = os.read(sys.stdin.fileno(), 512)
        if not chunk:
            return
        packets.put(chunk)


def main():
    restore = terminal_input()
    received = b""
    try:
        emit("\x1b[38;2;51;182;147;48;2;19;21;38mBRCLIORGBPROBE\x1b[0m\r\n")
        emit("\x1b[?1002h\x1b[?1006hBRCLIOMOUSEREADY\r\n")
        packets = queue.Queue()
        threading.Thread(target=read_packets, args=(packets,), daemon=True).start()
        deadline = time.monotonic() + 12
        while len(received) < 4096:
            try:
                received += packets.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                break
            if re.search(rb"\x1b\[<0;[1-9][0-9]*;[1-9][0-9]*M", received):
                break
    finally:
        emit("\x1b[?1006l\x1b[?1002l")
        restore()
    matched = re.search(rb"\x1b\[<0;([1-9][0-9]*);([1-9][0-9]*)M", received)
    if matched:
        print("BRCLIOMOUSEOK", *(part.decode("ascii") for part in matched.groups()))
    else:
        print("BRCLIOMOUSEMISS", received[:80].hex())
    print("BRCLIOSELECTPROBE", flush=True)


if __name__ == "__main__":
    main()
