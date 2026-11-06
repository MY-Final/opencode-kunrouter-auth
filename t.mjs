import { KunRouterPlugin, _internal } from "./index.mjs"
const hooks = await KunRouterPlugin({})
const cfg = {}
await hooks.config(cfg)
const p = cfg.provider.kunrouter
console.log("provider:", p.name, "| api:", p.api, "| models:", Object.keys(p.models).join(","))
const st = await _internal.siteStatus()
console.log("site:", JSON.stringify(st))
const bad = await hooks.auth.usage(async () => ({ type: "api", key: "definitely_not_a_valid_token" }))
console.log("usage(坏令牌):", JSON.stringify(bad))
const none = await hooks.auth.usage(async () => ({ type: "api", key: "" }))
console.log("usage(空令牌):", JSON.stringify(none))
const ci = await hooks.auth.checkin(async () => ({ type: "api", key: "" }))
console.log("checkin(空令牌):", JSON.stringify(ci))
