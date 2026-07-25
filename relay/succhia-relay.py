#!/usr/bin/env python3
# succhia-relay.py — SOSEXY 啵啵贝 电脑蓝牙中继（Mac/Windows/Linux 通用）
# 用法:
#   pip install bleak
#   python3 succhia-relay.py
# 前提: 电脑蓝牙打开、玩具开机、电脑别休眠(锁屏没关系)。Ctrl+C 退出时自动把玩具归零。
# 架构: 长轮询 <server>/poll → 状态一变 → BLE 写 12 字节帧。
# 协议(兔兔 tutu-kitty 逆向): 帧=01 01 00 02 00 [主ch] 11 [强度] 00 [副ch] 11 01,一帧控一个马达。

import asyncio, json, signal, sys, time, urllib.request, urllib.parse

import os
BASE = os.environ.get("SUCCHIA_SERVER", "http://localhost:8889")  # 也可: SUCCHIA_SERVER=https://你的域名 python3 succhia-relay.py
DEVICE_NAME = "SOSEXY"
SVC   = "0000ee01-0000-1000-8000-00805f9b34fb"
CHR_W = "0000ee03-0000-1000-8000-00805f9b34fb"
CHR_N = "0000ee02-0000-1000-8000-00805f9b34fb"
MOTOR = {"vibe": (0x01, 0x02), "ems": (0x03, 0x04), "suck": (0x07, 0x08)}
KEEPALIVE = 10  # 秒:连接期间定期同值重发,兼作心跳

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit("缺依赖: 先运行  pip install bleak")

def frame(motor, val):
    m1, m2 = MOTOR[motor]
    return bytes([0x01, 0x01, 0x00, 0x02, 0x00, m1, 0x11, val & 0xFF, 0x00, m2, 0x11, 0x01])

def http_json(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())

def report(ev):  # 上报到 /diag,远程可在 /diag 看到中继动静
    try:
        urllib.request.urlopen(BASE + "/event?type=relay_" + urllib.parse.quote(ev[:160]), timeout=5).read()
    except Exception:
        pass

class Relay:
    def __init__(self):
        self.client = None
        self.write_response = False
        self.state = {"suck": -1, "vibe": -1, "ems": -1}

    async def write(self, motor, val):
        await self.client.write_gatt_char(CHR_W, frame(motor, val), response=self.write_response)
        await asyncio.sleep(0.03)  # 帧间喘息

    async def apply(self, d, force=False):
        for motor, key in (("vibe", "vibe_intensity"), ("ems", "ems_intensity"), ("suck", "suck_intensity")):
            val = int(d.get(key, 0))
            if force or val != self.state[motor]:
                await self.write(motor, val)
                if val != self.state[motor]:
                    print(f"  -> {motor} = {val}")
                self.state[motor] = val

    async def zero(self):
        try:
            for motor in MOTOR:
                await self.write(motor, 0)
            print("已归零")
        except Exception:
            pass

    def on_notify(self, _, data: bytearray):
        print("  [notify]", data.hex(" "))  # 设备状态回传,破译/对账用

    async def run_connected(self):
        d = http_json(BASE + "/poll", 10)
        await self.apply(d, force=True)
        since = d["updated_at"]
        last_write = time.time()
        while self.client.is_connected:
            try:
                url = f"{BASE}/poll?wait=20&since={since}"
                d = http_json(url, 25)
                since = d["updated_at"]
                await self.apply(d)
                last_write = time.time()
            except Exception as e:
                if not self.client.is_connected:
                    break
                if isinstance(e, (urllib.error.URLError, TimeoutError)):
                    await asyncio.sleep(2)  # 网络抖动,歇口气
                else:
                    raise
            if time.time() - last_write >= KEEPALIVE:
                await self.apply({k + "_intensity": v for k, v in
                                  (("suck", self.state["suck"]), ("vibe", self.state["vibe"]), ("ems", self.state["ems"]))
                                  if v >= 0}, force=True)
                last_write = time.time()

    async def main(self):
        print("succhia 电脑中继 v1 · Ctrl+C 退出(自动归零)")
        while True:
            try:
                print("扫描 SOSEXY ...")
                dev = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=15)
                if dev is None:
                    print("没找到,3s 后重扫(确认玩具开机、离电脑 10 米内)")
                    await asyncio.sleep(3)
                    continue
                async with BleakClient(dev) as client:
                    self.client = client
                    ch = client.services.get_characteristic(CHR_W)
                    self.write_response = bool(ch and "write" in ch.properties)
                    try:
                        await client.start_notify(CHR_N, self.on_notify)
                    except Exception:
                        print("  (notify 订阅失败,不影响控制)")
                    print(f"已连接 ✓ (write_response={self.write_response}) 监听指令中...")
                    report("connect")
                    self.state = {"suck": -1, "vibe": -1, "ems": -1}
                    await self.run_connected()
                print("连接断开,自动重连...")
                report("disconnect")
            except (asyncio.CancelledError, KeyboardInterrupt):
                raise
            except Exception as e:
                print("出错:", repr(e), "— 3s 后重试")
                report("error_" + type(e).__name__)
                await asyncio.sleep(3)

async def entry():
    r = Relay()
    try:
        await r.main()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        if r.client and r.client.is_connected:
            await r.zero()
            try:
                await r.client.disconnect()
            except Exception:
                pass
        report("exit")

if __name__ == "__main__":
    try:
        asyncio.run(entry())
    except KeyboardInterrupt:
        pass
