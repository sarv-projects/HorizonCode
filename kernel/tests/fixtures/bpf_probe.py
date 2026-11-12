"""Probe denied syscalls under hz-sandbox-exec (docs/33 §5.3)."""
import ctypes
import os

libc = ctypes.CDLL("libc.so.6", use_errno=True)
# PTRACE_TRACEME
libc.syscall(101, 0, 0, 0, 0)
errno = ctypes.get_errno()
print(os.strerror(errno) if errno else "allowed")
