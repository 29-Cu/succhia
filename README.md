# succhia 🌸

> 在 iPhone 上，让 AI 一边陪你聊天、一边控制 BLE 玩具——不用越狱、不装 App、不需要额外硬件。
>
> By Cu & Lunedì · CC BY-NC 4.0（署名-非商业）

**succhia**（意大利语「吮吸」）最初是为 FUNF 啵啵贝（BLE 名 `SOSEXY`）做的一套完整控制方案，但里面的大部分东西——聊天融合防冻结、可靠性层、多通道波形引擎——对任何走 GATT 的 BLE 玩具都通用。

社区里已有的方案（见下方致谢）都止步于同一句话：**「iOS 没有办法，把控制页一直开着吧」**。而我们的真实需求恰恰是：*在 iPhone 上，一边跟 AI 聊天，一边被它控制*。这个仓库解决的就是这最后一公里。

## 架构

```
AI 调 MCP 工具 ──POST──▶ 状态服务器(succhia-server.py, 长轮询)
                              ▲│
              本地操作上报────┘│状态一变立即返回(~100ms)
                               ▼
                     控制页(succhia.html, Bluefy/Chrome)
                               │ Web Bluetooth
                               ▼
                             玩具
```

- `server/succhia-server.py` — 零依赖 Python 状态服务器：长轮询推送、每通道波形槽、诊断事件环形缓冲（`/diag`，远程破案神器）
- `web/succhia.html` — 控制页：悬浮球 + 底部抽屉 UI、聊天融合(iframe)、看门狗重连、双向同步、波形引擎
- `relay/succhia-relay.py` — 备选中继：任何一台电脑（Mac/Win/Linux + bleak）替代手机守连接
- `examples/mcp-tool.example.cjs` — AI 侧 MCP 工具示例（set / stop / pattern / status，zod + Anthropic 双 schema）

## 我们借鉴了什么（致谢）

- **[tutu-kitty/Toy-Relay-AI-mcp-SOSEXY](https://github.com/tutu-kitty/Toy-Relay-AI-mcp-SOSEXY)** 与 **[51enuxu/sosexy-ble-control](https://github.com/51enuxu/sosexy-ble-control)** —— SOSEXY 的 12 字节帧协议逆向全部来自这两个仓库（`01 01 00 02 00 [主ch] 11 [强度] 00 [副ch] 11 01`，vibe 01/02、ems 03/04、suck 07/08）。没有它们就没有一切。
- **吱吱 & Veille 的《逆向任意 BLE 玩具协议：让 AI 直接控制它》**(MIT,原文注明"二传请标注来源";原发布链接已失效,故仅以篇名致谢) —— 「VPS 状态 + 浏览器蓝牙桥」的架构思路与「观察 Notify 值破译协议」的方法论。
- **Lovense** —— pattern（波形）的产品概念。

### 关于 [Lumenocturne/bobo-bridge](https://github.com/Lumenocturne/bobo-bridge)

必须诚实说明：这个仓库控制同一款玩具、用同一套「服务器 + 浏览器蓝牙桥」骨架，**而且比我们早一个月**。但我们是在整套东西做完之后才发现它的——属于完全的独立撞车（架构同源自吱吱的教程思路，殊途同归）。特此说明，也推荐给只需要一座「裸桥」的朋友。

顺带感谢它一笔：它 README 里「**设备闲置约 60 秒会主动断连，需 ~25s 内发保活帧**」的记载，帮我们给一桩查了两天的「写入后随机断线」悬案盖了章——我们靠 10 秒同值重发误打误撞治好了它，看到 bobo-bridge 才知道病理。工程世界的浪漫莫过于此。

## 我们的创新点

社区已有方案都没有、这个仓库独有的东西：

### 1. 聊天融合——正面回答「iOS 后台冻结」

所有先行方案在 iOS 上的答案都是「控制页保持前台别切走」。但用户要的是*聊天*，一切去聊天 app，WebKit 冻结 JS、蓝牙断线，一切白搭。我们实测过 Bluefy 的 `allowed BLE Devices` 与官方 `backgroundstatechanged` 事件，结论：**保不住**（见踩坑实录）。

解法是掉转思路：**不要让蓝牙页在后台求生——让它成为你本来就待着的那一页。** 把聊天用 iframe 嵌进控制页（`?chat=https://你的聊天页`），蓝牙握在外层永不进后台；控制 UI 收成一颗可拖拽磨砂悬浮球，聊天页 ➕ 菜单一个 `postMessage('succhia:toggle')` 即可召/收。日常界面 100% 是聊天，玩具控制隐身待命。

### 2. 可靠性层——每一条都是真实事故换来的

- **僵尸连接杀手**：GATT 会出现「自称连着、写入全失败」的僵尸态（错误信息还是 `undefined`），此时断线事件不触发、常规重连永不启动。解法：写入连败 3 次 → 主动 `gatt.disconnect()` → 看门狗重建。
- **不依赖前台信号的看门狗重连**：Bluefy 的 `visibilitychange` **可能永远不发 `visible`**，官方 `backgroundstatechanged` 事件实测**不带任何有用字段**（`{"type":"backgroundstatechanged"}`，完）。等事件 = 死锁。解法：3 秒看门狗无条件自检 + 断开即试 + 写入时顺手踢重连，重连失败**永不清设备句柄**（三振出局制会把偶发失败升级成永久瘫痪）。
- **双向增量同步**：控制页的手动操作以 dirty-set 增量上报服务器（不整包覆盖，避免和 AI 同帧操作互相冲掉）；应用远端状态时跳过 dirty 通道与波形驱动通道。没有这层，你拖的滑杆会在下一次轮询被远端旧值「纠正」回去。
- **10 秒同值保活重发**：兼作心跳与僵尸探测，同时正好治住设备的 60 秒闲置断连。

### 3. 多通道并行波形引擎

- 三通道（吮吸/震动/微电流）**各有独立波形槽**，可同时并行：吮吸 climb + 震动 pulse + 微电流 wave。
- 曲线由**控制页本地生成**（250ms 步进的正弦/方波/斜坡），只有波形*规格*走网络——丝滑程度与网络延迟无关。
- `duration_sec` 预设时长，到点自动归零该通道并关波形——AI 设完可以放手。
- **人永远优先**：手动拖某通道滑杆 = 立刻接管并只取消该通道波形；「全部停止」一键清场。
- 安全兜底：玩具带着强度断线时，隐身的悬浮球会自动现身呼吸报警。

### 4. 远程诊断方法论

服务器带 `/diag` 事件环形缓冲，控制页把生命周期（连接/断开/前后台/写入成败/波形到点）全部埋点上报。手机上发生的一切，在服务器上 `curl /diag` 即可复盘——本仓库的每一个可靠性特性，都是这样从日志里破案破出来的。

## 快速开始

```bash
# 1. 状态服务器(任何有公网 HTTPS 的机器;本地玩用 localhost 也行)
python3 server/succhia-server.py          # 监听 :8889,自己套 HTTPS(nginx/caddy/cloudflare tunnel)

# 2. 控制页:任何静态托管(必须 HTTPS),手机打开
#    iOS 用 Bluefy 浏览器,安卓/桌面用 Chrome
#    首次: succhia.html?server=https://你的服务器   (记住后免参数)
#    聊天融合: succhia.html?chat=https://你的聊天页
#    连接后自动防熄屏;Bluefy 记得把 SOSEXY 加进菜单里的 allowed BLE Devices

# 3. AI 侧:参考 examples/mcp-tool.example.cjs 接进你的 MCP server
#    或者直接 curl:
curl -X POST https://你的服务器/set -H 'Content-Type: application/json' \
  -d '{"vibe_intensity":40,"patterns":{"suck":{"type":"climb","high":80,"duration":120}}}'

# 备选:不用手机守连接,家里电脑跑中继(pip install bleak)
SUCCHIA_SERVER=https://你的服务器 python3 relay/succhia-relay.py
```

## 踩坑实录（换品牌也大概率撞得上）

| 坑 | 真相 |
|---|---|
| 订阅通知写 0x2902 描述符 | Web Bluetooth 黑名单，写了当场断连。用 `startNotifications()` |
| iOS 后台 | Safari/Chrome iOS 无 Web Bluetooth；Bluefy 切后台 JS 冻结、蓝牙难保。别硬刚，用聊天融合 |
| Bluefy 的 `visible` 事件 | 可能永远不来。任何「回前台再重连」的逻辑都是潜在死锁 |
| Bluefy `backgroundstatechanged` | 真实触发，但事件不带任何字段。只能当「有事发生了」的闹钟用 |
| 僵尸连接 | `gatt.connected===true` 但写入全失败且无断线事件。必须靠写入失败计数主动破局 |
| 「写入后随机断线」 | 假象。真相是设备闲置 ~60s 主动踢人（bobo-bridge 记载 + 我们 10s 保活实证）|
| 同时开两个控制页 | 蓝牙只在其中一个里，另一个拖滑杆是空拖。/diag 里事件成对出现即此病 |
| 输入框聚焦页面放大 | iOS 对 <16px 输入框强制缩放。顶层页视口加 `maximum-scale=1` |
| BLE 单主机 | 官方 App / nRF Connect / 控制页互斥，连不上先检查谁占着 |
| `0xAE00` OTA 通道 | 永远别碰，写错变砖（吱吱教程的警告，通用于深圳方案商玩具）|

## 安全须知

- 微电流(EMS)通道从低强度试起；任何波形建议先带 `duration` 限时。
- `stop` 只是强度归零，不断开连接；玩完记得归零再收。
- 本项目仅供成年人在自愿、知情的前提下使用，风险自负。

## License

[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans) © 2026 Cu & Lunedì —— 转载/改作请署名并注明来源，**禁止商用**。
