import { KunRouterPlugin } from "./index.mjs"
const hooks = await KunRouterPlugin({})
const sk = process.env.KRK
const auth = { type: "api", key: "this_is_an_access_token_not_sk", metadata: { apiKey: sk } }

const cfg = {}
await hooks.config(cfg)
const provider = cfg.provider.kunrouter

const models = await hooks.provider.models(provider, { auth })
console.log("provider.models 拉到:", Object.keys(models).join(", ") || "(空，退回占位)")

const loader = await hooks.auth.loader(async () => auth)
const r = await loader.fetch(`${loader.baseURL}/models`, { headers: { "content-type": "application/json" } })
console.log("loader 用 sk- 请求 /v1/models:", r.status)

// 只填访问令牌、没有 sk- 的情况应该退回占位模型而不是崩
const onlyToken = { type: "api", key: "access_only_token" }
const models2 = await hooks.provider.models(provider, { auth: onlyToken })
console.log("只有访问令牌时:", Object.keys(models2).join(", "))
