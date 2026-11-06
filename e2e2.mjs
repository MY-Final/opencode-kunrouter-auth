import { KunRouterPlugin } from "./index.mjs"
const hooks = await KunRouterPlugin({})
const sk = process.env.KRK
// 模拟真实登录产物：key 是访问令牌，sk- 放在 metadata 里
const auth = { type: "api", key: "fake_access_token_for_test", metadata: { apiKey: sk } }
const getAuth = async () => auth

const loader = await hooks.auth.loader(getAuth)
const r = await loader.fetch(`${loader.baseURL}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "回一个字" }], max_tokens: 8 }),
})
const body = await r.json()
console.log("chat:", r.status, "| quota:", JSON.stringify(body?.usage?.quota))
await new Promise((x) => setTimeout(x, 400))
console.log("usage():", JSON.stringify(await hooks.auth.usage(getAuth), null, 2))
