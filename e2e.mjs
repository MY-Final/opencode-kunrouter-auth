import { KunRouterPlugin } from "./index.mjs"
const hooks = await KunRouterPlugin({})
const key = process.env.KRK
const getAuth = async () => ({ type: "api", key })

const loader = await hooks.auth.loader(getAuth)
console.log("loader baseURL:", loader.baseURL)
const t = Date.now()
const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "说三个字" }], max_tokens: 16 }),
})
const body = await res.json()
console.log("chat:", res.status, `${Date.now() - t}ms`, "| reply:", body?.choices?.[0]?.message?.content?.trim())
console.log("响应里的 quota:", JSON.stringify(body?.usage?.quota))
await new Promise((r) => setTimeout(r, 300))
const u = await hooks.auth.usage(getAuth)
console.log("usage():", JSON.stringify(u, null, 0))
