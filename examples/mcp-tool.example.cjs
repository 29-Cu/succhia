// tools/succhia.cjs
// succhia(FUNF 啵啵贝)遥控 — AI 侧 MCP 工具示例(zod schema + Anthropic tool schema 双份)。
// 链路:工具 → succhia-server(:8889)状态文件 → 手机 Bluefy/Chrome 页面长轮询 → BLE 发给设备。
// 页面在 web/succhia.html;server 是独立进程 server/succhia-server.py。
// Tools: succhia_set / succhia_stop / succhia_pattern / succhia_status。按需接到你的 MCP server。

const { z } = require("zod");

const BASE = "http://127.0.0.1:8889";

module.exports = function createSucchiaModule(/* ctx */) {
  function guard(callerOwner) {
    // 示例:按你的多租户体系限制谁能调用;单用户场景直接 return null
    return null;
  }

  function clamp(v) { return Math.max(0, Math.min(100, Math.round(Number(v)))); }

  async function getStatus() {
    const r = await fetch(BASE + "/status", { signal: AbortSignal.timeout(4000) });
    return r.json();
  }

  const CH_CN2 = { suck: "吮吸", vibe: "震动", ems: "微电流" };
  const TYPE_CN2 = { wave: "波浪", pulse: "脉冲", climb: "攀升" };
  function fmtState(s) {
    let out = "吮吸 " + s.suck_intensity + "/100 · 震动 " + s.vibe_intensity + "/100 · 微电流 " + s.ems_intensity + "/100";
    const pats = s.patterns || {};
    const act = ["suck", "vibe", "ems"].filter(c => pats[c]);
    if (act.length) out += "\n在跑的波形:" + act.map(c => CH_CN2[c] + "·" + TYPE_CN2[pats[c].type] + (pats[c].duration ? "(" + pats[c].duration + "s限时)" : "")).join(" / ");
    return out;
  }

  function listeningNote(st) {
    if (st.page_listening) return "控制页面在线(刚刚还在轮询),指令会在 1 秒内送达设备。";
    if (st.page_last_poll_sec_ago == null) return "⚠️ 控制页面目前没在轮询——可能还没打开控制页连接设备。指令已存好,页面一连上就会生效。";
    return "⚠️ 页面最后一次轮询是 " + Math.round(st.page_last_poll_sec_ago) + " 秒前,现在可能已断开。指令已存好,页面重连后会生效。";
  }

  const handlers = {
    succhia_set: async (input, callerOwner) => {
      const g = guard(callerOwner); if (g) return g;
      const payload = {};
      if (input.suck != null) payload.suck_intensity = clamp(input.suck);
      if (input.vibe != null) payload.vibe_intensity = clamp(input.vibe);
      if (input.ems != null) payload.ems_intensity = clamp(input.ems);
      if (!Object.keys(payload).length) return "什么都没设——至少给 suck/vibe/ems 里的一个强度值(0-100)。";
      try {
        const r = await fetch(BASE + "/set", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(4000)
        });
        const d = await r.json();
        if (!d.ok) return "设置失败:" + (d.error || "未知错误");
        const st = await getStatus().catch(() => null);
        return "已设置:" + fmtState(d.state) + (st ? "\n" + listeningNote(st) : "");
      } catch (e) {
        return "succhia server(:8889)没响应:" + e.message + "。可能进程没起,检查 server。";
      }
    },

    succhia_stop: async (input, callerOwner) => {
      const g = guard(callerOwner); if (g) return g;
      try {
        const r = await fetch(BASE + "/set", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suck_intensity: 0, vibe_intensity: 0, ems_intensity: 0, patterns: { suck: null, vibe: null, ems: null } }),
          signal: AbortSignal.timeout(4000)
        });
        const d = await r.json();
        if (!d.ok) return "停止指令下发失败:" + (d.error || "未知错误");
        const st = await getStatus().catch(() => null);
        return "已全部归零。" + (st ? listeningNote(st) : "");
      } catch (e) {
        return "succhia server(:8889)没响应:" + e.message + "。设备侧不受影响,页面上的滑块和实体按键都能手动停。";
      }
    },

    succhia_pattern: async (input, callerOwner) => {
      const g = guard(callerOwner); if (g) return g;
      const CH_CN = { suck: "吮吸", vibe: "震动", ems: "微电流" };
      const TYPE_CN = { wave: "波浪", pulse: "脉冲", climb: "攀升" };
      const runningNote = (st) => {
        const pats = st && st.state && st.state.patterns || {};
        const act = ["suck", "vibe", "ems"].filter(c => pats[c]);
        return act.length ? "当前在跑的波形:" + act.map(c => CH_CN[c] + "·" + TYPE_CN[pats[c].type]).join(" / ") : "当前没有波形在跑。";
      };
      try {
        if (input.type === "off") {
          const body = input.channel
            ? { patterns: { [input.channel]: null } }
            : { patterns: { suck: null, vibe: null, ems: null } };
          const r0 = await fetch(BASE + "/set", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(4000)
          });
          const d0 = await r0.json();
          if (!d0.ok) return "关闭波形失败:" + (d0.error || "未知错误");
          return (input.channel ? CH_CN[input.channel] + "的波形已关" : "全部波形已关") +
            "(通道保持当前强度,想归零用 succhia_stop)。";
        }
        const ch = input.channel;
        if (!ch) return "开波形要指定 channel(suck/vibe/ems)。";
        const defaults = { wave: 4, pulse: 1.6, climb: 8 };
        const high = clamp(input.high != null ? input.high : 60);
        const low = input.low != null ? Math.min(clamp(input.low), high)
                  : (input.type === "climb" ? 5 : Math.max(0, high - 45));
        const period = Math.round(1000 * Math.max(0.5, Math.min(60, Number(input.period_sec) || defaults[input.type])));
        const pattern = { type: input.type, high, low, period };
        if (input.duration_sec != null) pattern.duration = Math.max(3, Math.min(3600, Math.round(Number(input.duration_sec))));
        const r = await fetch(BASE + "/set", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patterns: { [ch]: pattern } }), signal: AbortSignal.timeout(4000)
        });
        const d = await r.json();
        if (!d.ok) return "波形设置失败:" + (d.error || "未知错误");
        const st = await getStatus().catch(() => null);
        return "波形已开:" + CH_CN[ch] + " · " + TYPE_CN[pattern.type] +
          " · " + low + "↔" + high + " · 周期 " + (period / 1000) + "s" +
          (pattern.duration ? " · " + pattern.duration + "s 后自动归零" : "(不限时,记得收尾)") +
          "\n(其余通道的波形不受影响;用户手动拖这个通道的滑杆会立刻接管并取消该波形)" +
          (st ? "\n" + runningNote(st) + "\n" + listeningNote(st) : "");
      } catch (e) {
        return "succhia server(:8889)没响应:" + e.message + "。可能进程没起,检查 server。";
      }
    },

    succhia_status: async (input, callerOwner) => {
      const g = guard(callerOwner); if (g) return g;
      try {
        const st = await getStatus();
        return "当前设定:" + fmtState(st.state) + "\n" + listeningNote(st);
      } catch (e) {
        return "succhia server(:8889)没响应:" + e.message + "。可能进程没起,检查 server。";
      }
    }
  };

  const SET_DESC =
    "遥控啵啵贝(succhia,FUNF 吮吸震动玩具)。三个马达强度各 0-100:suck=吮吸,vibe=震动,ems=微电流。" +
    "只传想改的通道,没传的保持不变。前提:用户在手机 Bluefy(或安卓/桌面 Chrome)里打开控制页并连上设备" +
    "(工具回执会告诉你页面在不在线)。指令经页面轮询转发,约 1 秒生效。";

  const PATTERN_DESC =
    "给啵啵贝某个通道开一段自动波形(类似 Lovense pattern):wave 波浪起伏/pulse 脉冲跳变/climb 慢慢攀升,可预设 duration_sec 到点自动归零。" +
    "三个通道各有独立波形槽、可同时并行(如吮吸 climb+震动 pulse),新调用只覆盖同通道的旧波形。" +
    "type=off 带 channel 只停该通道,不带 channel 全停。波形没占用的通道仍可用 succhia_set 定常值当底噪。" +
    "曲线由控制页面本地生成(250ms 步进),丝滑不吃网络。用户手动拖某通道滑杆=立刻接管并取消该通道波形。前提同 succhia_set:控制页面要在线。";

  const anthropicSchemas = [
    {
      name: "succhia_set",
      description: SET_DESC,
      input_schema: {
        type: "object",
        properties: {
          suck: { type: "integer", minimum: 0, maximum: 100, description: "吮吸强度 0-100(0=停)" },
          vibe: { type: "integer", minimum: 0, maximum: 100, description: "震动强度 0-100(0=停)" },
          ems: { type: "integer", minimum: 0, maximum: 100, description: "微电流强度 0-100(0=停)" }
        }
      }
    },
    {
      name: "succhia_stop",
      description: "立即把啵啵贝三个通道(吮吸/震动/微电流)全部归零停止(同时清掉波形)。",
      input_schema: { type: "object", properties: {} }
    },
    {
      name: "succhia_pattern",
      description: PATTERN_DESC,
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["wave", "pulse", "climb", "off"], description: "波形:wave=波浪(正弦起伏) pulse=脉冲(高低跳变) climb=攀升(低爬到高再重来) off=关闭波形" },
          channel: { type: "string", enum: ["suck", "vibe", "ems"], description: "作用通道;三通道波形独立并行。off+channel=只停该通道,off 不带=全停" },
          high: { type: "integer", minimum: 0, maximum: 100, description: "峰值强度,默认 60" },
          low: { type: "integer", minimum: 0, maximum: 100, description: "谷值强度,默认 wave/pulse=high-45,climb=5" },
          period_sec: { type: "number", minimum: 0.5, maximum: 60, description: "一个周期几秒,默认 wave 4/pulse 1.6/climb 8" },
          duration_sec: { type: "integer", minimum: 3, maximum: 3600, description: "持续几秒后自动归零该通道并关波形;不传=一直跑到被手动接管/关闭" }
        },
        required: ["type"]
      }
    },
    {
      name: "succhia_status",
      description: "查看啵啵贝当前设定强度,以及控制页面是否在线(在线=指令能送达设备)。",
      input_schema: { type: "object", properties: {} }
    }
  ];

  const mcpRegistrations = [
    {
      server: "device", name: "succhia_set",
      title: "Succhia · 设置强度",
      description: SET_DESC,
      inputSchema: {
        suck: z.number().int().min(0).max(100).optional().describe("吮吸强度 0-100(0=停)"),
        vibe: z.number().int().min(0).max(100).optional().describe("震动强度 0-100(0=停)"),
        ems: z.number().int().min(0).max(100).optional().describe("微电流强度 0-100(0=停)")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    {
      server: "device", name: "succhia_stop",
      title: "Succhia · 全部停止",
      description: "立即把啵啵贝三个通道全部归零停止(同时清掉波形)。",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    {
      server: "device", name: "succhia_pattern",
      title: "Succhia · 波形",
      description: PATTERN_DESC,
      inputSchema: {
        type: z.enum(["wave", "pulse", "climb", "off"]).describe("wave=波浪 pulse=脉冲 climb=攀升 off=关闭"),
        channel: z.enum(["suck", "vibe", "ems"]).optional().describe("作用通道;三通道波形独立并行。off+channel=只停该通道,off 不带=全停"),
        high: z.number().int().min(0).max(100).optional().describe("峰值强度,默认 60"),
        low: z.number().int().min(0).max(100).optional().describe("谷值强度,默认 wave/pulse=high-45,climb=5"),
        period_sec: z.number().min(0.5).max(60).optional().describe("一个周期几秒,默认 wave 4/pulse 1.6/climb 8"),
        duration_sec: z.number().int().min(3).max(3600).optional().describe("持续几秒后自动归零并关波形;不传=一直跑")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    {
      server: "device", name: "succhia_status",
      title: "Succhia · 状态",
      description: "查看啵啵贝当前设定强度,以及控制页面是否在线。",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }
  ];

  return { handlers, anthropicSchemas, mcpRegistrations };
};
