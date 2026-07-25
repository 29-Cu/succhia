import json, os, time, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import pathlib
STATE_FILE = str(pathlib.Path(__file__).parent / "succhia-state.json")

CHANNELS = ("suck","vibe","ems")
NO_PATTERNS = {"suck":None,"vibe":None,"ems":None}
DEFAULT = {"suck_intensity":0,"suck_mode":1,"vibe_intensity":0,"vibe_mode":1,"ems_intensity":0,"ems_mode":1,"patterns":dict(NO_PATTERNS),"updated_at":0}

def clean_pattern(p):
    # 波形规格:页面引擎消费;None=关。通道由 patterns 的 key 承载,规格里不含 ch。非法输入一律当 None
    try:
        if not isinstance(p, dict): return None
        if p.get("type") not in ("wave","pulse","climb"): return None
        high = max(0, min(100, int(p.get("high", 60))))
        low  = max(0, min(high, int(p.get("low", 0))))
        period = max(500, min(60000, int(p.get("period", 4000))))
        out = {"type": p["type"], "high": high, "low": low, "period": period}
        if p.get("duration") is not None:
            out["duration"] = max(3, min(3600, int(p["duration"])))
        return out
    except Exception:
        return None

COND = threading.Condition()   # /set 唤醒挂起的长轮询
FLOCK = threading.Lock()       # 状态文件读写锁(多线程 server)

def rs():
    with FLOCK:
        try:
            with open(STATE_FILE) as f: return json.load(f)
        except: return DEFAULT.copy()

def ws(d):
    d["updated_at"] = time.time()
    tmp = STATE_FILE + ".tmp"
    with FLOCK:
        with open(tmp,"w") as f: json.dump(d,f)
        os.replace(tmp, STATE_FILE)
    with COND:
        COND.notify_all()

if not os.path.exists(STATE_FILE): ws(DEFAULT.copy())

LAST_POLL = [0.0]      # 页面最近一次 /poll 到达时间(内存态)
ACTIVE = [0]           # 正在挂起等待的长轮询数
ALOCK = threading.Lock()
DIAG = []              # 最近事件环形缓冲(诊断 iOS 后台行为用)
DLOCK = threading.Lock()

def diag_add(ev):
    ev["t"] = round(time.time(), 2)
    with DLOCK:
        DIAG.append(ev)
        if len(DIAG) > 120: del DIAG[:len(DIAG)-120]

class PH(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type","application/json")
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try: self.wfile.write(body)
        except: pass

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/poll":
            arrived = time.time()
            LAST_POLL[0] = arrived
            # 长轮询: /poll?wait=20&since=<上次的 updated_at> — 状态没变就挂住,变了立即返回
            try: wait = min(25.0, max(0.0, float(q.get("wait",["0"])[0])))
            except: wait = 0.0
            since_raw = q.get("since",[None])[0]
            s = rs()
            if wait > 0 and since_raw is not None:
                try: since = float(since_raw)
                except: since = -1.0
                with ALOCK: ACTIVE[0] += 1
                try:
                    deadline = arrived + wait
                    with COND:
                        while abs(s.get("updated_at",0) - since) < 1e-6:
                            remain = deadline - time.time()
                            if remain <= 0: break
                            COND.wait(remain)
                            s = rs()
                finally:
                    with ALOCK: ACTIVE[0] -= 1
                    LAST_POLL[0] = time.time()
            diag_add({"e":"poll","wait":wait,"held_ms":int((time.time()-arrived)*1000)})
            self._json(s)
        elif u.path == "/event":
            # 页面上报生命周期事件(hidden/visible/connect/disconnect),纯诊断
            diag_add({"e":"page","type":(q.get("type",["?"])[0])[:180]})
            self._json({"ok":True})
        elif u.path == "/status":
            s = rs()
            age = (time.time() - LAST_POLL[0]) if LAST_POLL[0] else None
            with ALOCK: active = ACTIVE[0]
            listening = (active > 0 and age is not None and age < 30) or (age is not None and age < 5)
            self._json({"state": s,
                        "page_last_poll_sec_ago": round(age,1) if age is not None else None,
                        "page_listening": listening,
                        "active_longpolls": active})
        elif u.path == "/diag":
            with DLOCK: ev = list(DIAG)
            self._json({"now": round(time.time(),2), "events": ev})
        elif u.path == "/set":
            body=b"use POST"
            self.send_response(200)
            self.send_header("Content-Type","text/plain")
            self.send_header("Access-Control-Allow-Origin","*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._json({"error":"not found"}, 404)

    def do_POST(self):
        if urlparse(self.path).path == "/set":
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                s = rs()
                for k in ["suck_intensity","suck_mode","vibe_intensity","vibe_mode","ems_intensity","ems_mode"]:
                    if k in data:
                        s[k] = max(0, min(100, int(data[k]))) if "intensity" in k else max(1, min(4, int(data[k])))
                if not isinstance(s.get("patterns"), dict):
                    s["patterns"] = dict(NO_PATTERNS)
                s.pop("pattern", None)  # v1 单槽字段,清掉
                if isinstance(data.get("patterns"), dict):  # v2:每通道独立波形槽,只动带到的通道
                    for ch in CHANNELS:
                        if ch in data["patterns"]:
                            s["patterns"][ch] = clean_pattern(data["patterns"][ch])
                if "pattern" in data:  # 旧页面/旧调用兼容:null=全停,带ch的规格=落到对应通道
                    p = data["pattern"]
                    if p is None:
                        s["patterns"] = dict(NO_PATTERNS)
                    elif isinstance(p, dict) and p.get("ch") in CHANNELS:
                        s["patterns"][p["ch"]] = clean_pattern(p)
                ws(s)
                diag_add({"e":"set"})
                self._json({"ok": True, "state": s})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
        else:
            self._json({"error":"not found"}, 404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type")
        self.send_header("Content-Length","0")
        self.end_headers()
    def log_message(self,f,*a): pass

print("Succhia poll server (threading+longpoll) starting on :8889...")
srv = ThreadingHTTPServer(("0.0.0.0",8889), PH)
srv.daemon_threads = True
srv.serve_forever()
