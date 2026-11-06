import { KunRouterPlugin } from "./index.mjs"
const sk = process.env.KRK

// 选项：默认（直连开、本期窗口开）
const mk = (opts) => ({ magpie: { option: (p, k) => opts?.[k] } })
const a = await KunRouterPlugin(mk({}))
console.log("默认 baseURL:", (await a.auth.loader(async () => ({ type: "api", key: sk }))).baseURL)
console.log("默认 options:", a.auth.options.map((o) => `${o.key}=${o.default}`).join(", "))

// 关掉直连
const b = await KunRouterPlugin(mk({ direct_api: false }))
console.log("关直连 baseURL:", (await b.auth.loader(async () => ({ type: "api", key: sk }))).baseURL)
const cfg = {}; await b.config(cfg)
console.log("关直连 provider.api:", cfg.provider.kunrouter.api)

// 关掉本期窗口
const c = await KunRouterPlugin(mk({ period_window: false }))
const loader = await c.auth.loader(async () => ({ type: "api", key: sk }))
await loader.fetch(`${loader.baseURL}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 4 }) })
await new Promise((r) => setTimeout(r, 300))
console.log("关掉本期窗口后 usage:", JSON.stringify(await c.auth.usage(async () => ({ type: "api", key: sk }))))
