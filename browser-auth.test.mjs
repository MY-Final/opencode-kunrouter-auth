import assert from "node:assert/strict"

import { KunRouterPlugin, _internal } from "./index.mjs"

const realFetch = globalThis.fetch
let startBody
let exchangeBody

globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  if (url.endsWith("/api/desktop/auth/start")) {
    startBody = JSON.parse(String(init.body))
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          authorization_url: "https://wcnmb.si/desktop/authorize?flow=test-flow",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (url.endsWith("/api/desktop/auth/exchange")) {
    exchangeBody = JSON.parse(String(init.body))
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          access_token: "nap_browser_access",
          api_key: "sk-browser_api_key",
          group: "vip",
          expires_at: 2000000000,
          user: { id: 42, username: "owner", email: "owner@example.com" },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  throw new Error(`unexpected fetch: ${url}`)
}

const authorization = await _internal.startBrowserAuthorization()
assert.equal(
  authorization.url,
  "https://wcnmb.si/desktop/authorize?flow=test-flow",
)
assert.equal(authorization.method, "auto")
assert.match(
  startBody.installation_id,
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
)
for (const url of [
  "https://wcnmb.si/desktop/authorize?flow=test",
  "https://wcnmb.fun/desktop/authorize?flow=test",
  "https://direct.wcnmb.fun/desktop/authorize?flow=test",
  "https://kuncode.120403.xyz/desktop/authorize?flow=test",
]) {
  assert.equal(_internal.isAllowedAuthorizationURL(url), true)
}
assert.equal(
  _internal.isAllowedAuthorizationURL(
    "https://attacker.example/desktop/authorize?flow=test",
  ),
  false,
)
assert.equal(
  _internal.isAllowedAuthorizationURL(
    "https://wcnmb.fun.attacker.example/desktop/authorize?flow=test",
  ),
  false,
)

const callbackBase = new URL(startBody.redirect_uri)
const badState = new URL(callbackBase)
badState.searchParams.set("state", "wrong-state")
badState.searchParams.set("code", "bad-code")
assert.equal((await realFetch(badState)).status, 400)

const callback = new URL(callbackBase)
callback.searchParams.set("state", startBody.state)
callback.searchParams.set("code", "one-time-code")
const resultPromise = authorization.callback()
assert.equal((await realFetch(callback)).status, 200)
const result = await resultPromise
assert.equal(result.type, "success")
assert.equal(result.key, "sk-browser_api_key")
assert.equal(result.accountId, "42")
assert.equal(result.metadata.accessToken, "nap_browser_access")
assert.equal(result.metadata.group, "vip")
assert.equal(exchangeBody.code, "one-time-code")
assert.equal(exchangeBody.redirect_uri, startBody.redirect_uri)

const registrationController = new AbortController()
const registration = await _internal.startBrowserAuthorization(
  registrationController.signal,
  { registration: true },
)
const registrationURL = new URL(registration.url)
assert.equal(registrationURL.searchParams.get("mode"), "register")
assert.equal(
  registrationURL.searchParams.get("invite_code"),
  _internal.INVITE_CODE,
)
registrationController.abort()
assert.equal((await registration.callback()).type, "failed")

const controller = new AbortController()
const cancelled = await _internal.startBrowserAuthorization(controller.signal)
assert.equal(cancelled.type, undefined)
controller.abort()
assert.equal((await cancelled.callback()).type, "failed")

assert.equal(
  _internal.tokenOf({
    key: "sk-browser_api_key",
    metadata: { accessToken: "nap_browser_access" },
  }),
  "nap_browser_access",
)
assert.equal(
  _internal.apiKeyOf({
    key: "sk-browser_api_key",
    metadata: { accessToken: "nap_browser_access" },
  }),
  "sk-browser_api_key",
)

// 控制台删掉 Key 后，用访问令牌重签一把，并把分组带上。
let keyCreateBody
globalThis.fetch = async (url, init = {}) => {
  if (String(url).endsWith("/api/desktop/keys")) {
    keyCreateBody = JSON.parse(String(init.body))
    return new Response(
      JSON.stringify({
        success: true,
        data: { id: 88, name: "Magpie", key: "sk-recovered_key", group: "vip", models: [] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  throw new Error(`unexpected fetch: ${url}`)
}
const recovered = await _internal.recoverApiKey("nap_browser_access", "vip")
assert.deepEqual(recovered, { key: "sk-recovered_key", group: "vip", id: 88 })
assert.deepEqual(keyCreateBody, { name: "Magpie", group: "vip" })
assert.equal(await _internal.recoverApiKey("", "vip"), null)

// #11 收紧授权路径：信任域上的非授权路径不再放行。
assert.equal(_internal.isAllowedAuthorizationURL("https://wcnmb.si/anything"), false)
assert.equal(
  _internal.isAllowedAuthorizationURL("https://wcnmb.si/desktop/authorize?mode=register"),
  true,
)

// #10 maskKey 与站点的 MaskTokenKey 对齐（站点存的是不带 sk- 的 Key）。
assert.equal(_internal.maskKey("sk-abcdefghijkl"), "abcd**********ijkl")
assert.equal(_internal.maskKey("abcde"), "ab****de")
assert.equal(_internal.maskKey("abc"), "***")

// #6 邀请码不可用时注册入口应隐藏；网络异常按未知、仍然放行。
globalThis.fetch = async (url) => {
  if (String(url).includes("/api/invite_codes/public/")) {
    return new Response(
      JSON.stringify({
        success: true,
        data: { available: false, reason: "registration_full", remaining_registrations: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  throw new Error(`unexpected fetch: ${url}`)
}
let inviteState = await _internal.inviteCodeState("full-code")
assert.equal(inviteState.available, false)
assert.equal(inviteState.reason, "registration_full")
// 第二次命中缓存，不再打网络（这里的 fetch 会抛错）。
inviteState = await _internal.inviteCodeState("full-code")
assert.equal(inviteState.available, false)

globalThis.fetch = async () => new Response("{}", { status: 404 })
inviteState = await _internal.inviteCodeState("missing-code")
assert.equal(inviteState.available, false)

globalThis.fetch = async () => {
  throw new Error("boom")
}
inviteState = await _internal.inviteCodeState("offline-code")
assert.equal(inviteState.available, true)
assert.equal(inviteState.unknown, true)

// #10 用访问令牌读真实分组，按遮罩匹配。
globalThis.fetch = async (url) => {
  if (String(url).includes("/api/desktop/keys")) {
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          items: [
            { masked_key: "abcd**********ijkl", group: "付费组" },
            { masked_key: "zzzz**********yyyy", group: "其他" },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  throw new Error(`unexpected fetch: ${url}`)
}
assert.equal(await _internal.currentGroup("nap_x", "sk-abcdefghijkl"), "付费组")
assert.equal(await _internal.currentGroup("", "sk-abcdefghijkl"), "")

// #4 流式响应里的 usage.quota 也要记下来；#7 单位跟随站点币种。
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.endsWith("/api/status")) {
    return new Response(
      JSON.stringify({
        success: true,
        data: { quota_per_unit: 500000, custom_currency_symbol: "🥚", system_name: "KunRouter" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (u.includes("/api/desktop/keys")) {
    return new Response(JSON.stringify({ success: true, data: { items: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  if (u.endsWith("/api/user/self")) {
    return new Response(
      JSON.stringify({
        success: true,
        data: { id: 1, username: "u", group: "免费鸡蛋", quota: 500000, used_quota: 250000 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  throw new Error(`unexpected fetch: ${url}`)
}
const sse = new Response(
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"usage":{"quota":{"percent":42,"reset_at":2000000000}}}\n\n' +
    "data: [DONE]\n",
  { status: 200, headers: { "content-type": "text/event-stream" } },
)
await _internal.captureQuota(sse, "sk-ssekey")
const usageHooks = await KunRouterPlugin({})
const usage = await usageHooks.auth.usage(async () => ({
  type: "api",
  key: "sk-ssekey",
  metadata: { apiKey: "sk-ssekey", accessToken: "nap_x" },
}))
assert.equal(usage.windows.find((w) => w.name === "本期配额")?.used, 42)
assert.equal(usage.windows.find((w) => w.name === "钱包")?.unit, "🥚")
assert.equal(usage.plan, "免费鸡蛋")

// #5 只有访问令牌、没有 sk- 时，loader 直接返回一个清楚的 401，而不是打出去被拒。
const viewOnlyLoader = await usageHooks.auth.loader(async () => ({
  type: "api",
  key: "nap_only_token",
  metadata: { accessToken: "nap_only_token" },
}))
const blocked = await viewOnlyLoader.fetch("https://direct.wcnmb.fun/v1/chat/completions", {
  method: "POST",
})
assert.equal(blocked.status, 401)
assert.match((await blocked.json()).error.message, /访问令牌/)

// #9 直连域名网络层挂了，回退一次主站。
let directHits = 0
let siteHits = 0
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.startsWith("https://direct.wcnmb.fun")) {
    directHits++
    throw new Error("ECONNREFUSED")
  }
  if (u.startsWith("https://wcnmb.si/v1")) {
    siteHits++
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  throw new Error(`unexpected fetch: ${url}`)
}
const fallbackLoader = await usageHooks.auth.loader(async () => ({
  type: "api",
  key: "sk-directkey",
  metadata: { apiKey: "sk-directkey" },
}))
const fallbackRes = await fallbackLoader.fetch(
  "https://direct.wcnmb.fun/v1/chat/completions",
  { method: "POST", body: "{}" },
)
assert.equal(fallbackRes.status, 200)
assert.equal(directHits, 1)
assert.equal(siteHits, 1)

// #12 registration_entry 开关能直接关掉注册入口，不用改代码。
const noRegister = await KunRouterPlugin({
  magpie: { option: (_provider, key) => ({ registration_entry: false })[key] },
})
assert.equal(noRegister.auth.methods.some((m) => /注册/.test(m.label || "")), false)
// 默认（邀请码可用 / 未知）时注册入口存在。
assert.equal(usageHooks.auth.methods.some((m) => /注册/.test(m.label || "")), true)

globalThis.fetch = realFetch
console.log("browser authorization tests passed")
