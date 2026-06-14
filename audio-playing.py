#!/usr/bin/env python3
# 打印 "1" 当默认输出设备正在出声（任意 App 在放音频），否则 "0"。
# 用公开的 CoreAudio API kAudioDevicePropertyDeviceIsRunningSomewhere，
# 不依赖 MediaRemote（新系统已锁）也不需安装任何东西。
import ctypes, struct, sys

def fourcc(s):
    return struct.unpack(">I", s.encode())[0]

class AOPA(ctypes.Structure):
    _fields_ = [("mSelector", ctypes.c_uint32),
                ("mScope", ctypes.c_uint32),
                ("mElement", ctypes.c_uint32)]

try:
    ca = ctypes.CDLL("/System/Library/Frameworks/CoreAudio.framework/CoreAudio")
    get = ca.AudioObjectGetPropertyData
    get.restype = ctypes.c_int32
    get.argtypes = [ctypes.c_uint32, ctypes.POINTER(AOPA), ctypes.c_uint32,
                    ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]

    kSystem = 1
    # 默认输出设备
    addr = AOPA(fourcc("dOut"), fourcc("glob"), 0)
    dev = ctypes.c_uint32(0)
    size = ctypes.c_uint32(4)
    if get(kSystem, ctypes.byref(addr), 0, None, ctypes.byref(size), ctypes.byref(dev)) != 0 or dev.value == 0:
        print("0"); sys.exit(0)

    # 该设备是否“正在被某进程使用出声”
    addr2 = AOPA(fourcc("gone"), fourcc("glob"), 0)  # kAudioDevicePropertyDeviceIsRunningSomewhere
    running = ctypes.c_uint32(0)
    size2 = ctypes.c_uint32(4)
    st = get(dev.value, ctypes.byref(addr2), 0, None, ctypes.byref(size2), ctypes.byref(running))
    print("1" if (st == 0 and running.value) else "0")
except Exception:
    print("0")
