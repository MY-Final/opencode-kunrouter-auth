import assert from "node:assert/strict"
import { test, after } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { KunRouterPlugin, _internal } from "./index.mjs"

const realFetch = globalThis.fetch
after(() => { globalThis.fetch = realFetch })
const auth = { type: "api", key: "sk-abcdefghijkl", metadata: { accessToken: "pat-test", group: "old-group" } }
const getAuth = async () => auth
const plugin = (options = {}) => KunRouterPlugin({ magpie: { option: (_, key) => ({ registration_entry: false, ...options })[key] } })
const active = (overrides = {}) => ({ subscription: {
  id: 1, plan_id: 1, status: "active", end_time: Math.floor(Date.now() / 1000) + 86400,
  amount_total: 5000000, amount_used: 0, allow_wallet_overflow: true, ...overrides,
} })

function serveUsage({ wallet = 0, preference = "subscription_first", subscriptions = [active()], failPlans = false, failSubscriptions = false } = {}) {
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname
    if (path === "/api/status") return Response.json({ data: { quota_per_unit: 500000 } })
    if (path === "/api/user/self") return Response.json({ success: true, data: { quota: wallet, used_quota: 99999999, group: "user-group" } })
    if (path === "/api/subscription/self") {
      if (failSubscriptions) throw new Error("unavailable")
      return Response.json({ success: true, data: { billing_preference: preference, subscriptions } })
    }
    if (path === "/api/subscription/plans") {
      if (failPlans) throw new Error("unavailable")
      return Response.json({ data: [{ plan: { id: 1, title: "Plan" } }] })
    }
    if (path === "/api/desktop/keys") return Response.json({ data: { items: [] } })
    throw new Error(`unexpected request ${url}`)
  }
}

// Magpie 的额度契约：aside 不参与路由；零钱包等于已用 100%。
const routing = (usage) => usage.windows.filter((w) => !w.aside)
const exhausted = (usage) => routing(usage).some((w) => w.balance === 0 || w.used >= 100)

test("zero wallet does not block a funded subscription", async () => {
  serveUsage()
  const usage = await (await plugin()).auth.usage(getAuth)
  assert.equal(exhausted(usage), false)
  assert.equal(usage.windows.find((w) => w.name === "钱包").aside, true)
  assert.equal(routing(usage)[0].name, "Plan")
  assert.doesNotMatch(usage.windows.find((w) => w.name === "钱包").display, /已用/)
})

test("billing modes and wallet overflow match the server", async () => {
  for (const [preference, wallet, overflow, used, expected] of [
    ["subscription_only", 0, true, 0, false],
    ["subscription_only", 500000, true, 5000000, true],
    ["wallet_only", 0, true, 0, true],
    ["wallet_only", 500000, false, 5000000, false],
    ["subscription_first", 500000, true, 5000000, false],
    ["subscription_first", 500000, false, 5000000, true],
    ["wallet_first", 500000, false, 5000000, false],
    ["wallet_first", 0, false, 0, false],
  ]) {
    serveUsage({ preference, wallet, subscriptions: [active({ amount_used: used, allow_wallet_overflow: overflow })] })
    assert.equal(exhausted(await (await plugin()).auth.usage(getAuth)), expected, `${preference}/${wallet}/${overflow}/${used}`)
  }
})

test("one exhausted subscription cannot block another usable subscription", async () => {
  serveUsage({ subscriptions: [active({ amount_used: 5000000, allow_wallet_overflow: false }), active({ id: 2, plan_id: 2 })] })
  const usage = await (await plugin()).auth.usage(getAuth)
  assert.equal(exhausted(usage), false)
  assert.equal(routing(usage)[0].name, "订阅 #2")
})

test("all windows of a selected subscription must have allowance", async () => {
  serveUsage({ subscriptions: [active({ allow_wallet_overflow: false, quota_windows: [{ quota_limit: 100, used: 100, window_seconds: 86400 }] })] })
  assert.equal(exhausted(await (await plugin()).auth.usage(getAuth)), true)
})

test("one strict active subscription blocks subscription-first wallet overflow", async () => {
  serveUsage({ wallet: 500000, subscriptions: [active({ amount_used: 5000000 }), active({ id: 2, amount_used: 5000000, allow_wallet_overflow: false })] })
  assert.equal(exhausted(await (await plugin()).auth.usage(getAuth)), true)
})

test("subscription details option cannot change routing availability", async () => {
  for (const used of [0, 5000000]) {
    serveUsage({ preference: "subscription_only", subscriptions: [active({ amount_used: used })] })
    const full = await (await plugin()).auth.usage(getAuth)
    const hidden = await (await plugin({ period_window: false })).auth.usage(getAuth)
    assert.equal(exhausted(hidden), exhausted(full))
  }
})

test("missing or expired subscriptions cannot fund subscription-only requests", async () => {
  for (const subscriptions of [[], [active({ end_time: 1 })], [active({ end_time: "Infinity" })], [active({ end_time: 1e100 })]]) {
    serveUsage({ wallet: 500000, preference: "subscription_only", subscriptions })
    const usage = await (await plugin()).auth.usage(getAuth)
    assert.equal(exhausted(usage), true)
    assert.equal(usage.until, undefined)
  }
})

test("plan names can fail without losing subscription allowance", async () => {
  serveUsage({ failPlans: true })
  const usage = await (await plugin()).auth.usage(getAuth)
  assert.equal(routing(usage)[0].name, "订阅 #1")
  assert.equal(exhausted(usage), false)
  assert.equal(usage.windows.some((w) => /暂不可用/.test(w.display)), false)
})

test("successful allowance body is consumed before optional plan lookup finishes", async () => {
  let consumed = false
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/subscription/self")) return {
      status: 200, ok: true, async json() { consumed = true; return { success: true, data: { subscriptions: [active()] } } },
    }
    await delay(0)
    assert.equal(consumed, true)
    throw new Error("optional plan lookup timed out")
  }
  assert.equal((await _internal.fetchSubscriptions("pat")).subscriptions.length, 1)
})

test("wallet permission failure preserves successful subscription data", async () => {
  serveUsage()
  const serve = globalThis.fetch
  globalThis.fetch = async (url) => String(url).endsWith("/api/user/self")
    ? Response.json({ message: "permission denied" }, { status: 403 }) : serve(url)
  const usage = await (await plugin()).auth.usage(getAuth)
  assert.equal(exhausted(usage), false)
  assert.equal(routing(usage)[0].name, "Plan")
  assert.equal(usage.balance, undefined)
  assert.match(usage.windows.find((w) => w.name === "钱包").display, /暂不可用/)
})

test("unknown subscription state cannot turn zero wallet into exhausted account", async () => {
  serveUsage({ failSubscriptions: true })
  const usage = await (await plugin()).auth.usage(getAuth)
  assert.equal(exhausted(usage), false)
  assert.match(usage.windows.find((w) => w.name === "订阅").display, /暂不可用/)
  assert.match(usage.plan, /old-group（授权时）/)
})

test("non-finite counters and dates do not crash the usage card", async () => {
  serveUsage({ wallet: "Infinity", subscriptions: [active({ start_time: "bad", quota_windows: [{ quota_limit: 100, used: "Infinity", window_seconds: "bad", next_release_at: "bad" }] })] })
  const usage = await (await plugin()).auth.usage(getAuth)
  for (const window of usage.windows) for (const value of Object.values(window)) {
    if (typeof value === "number") assert.equal(Number.isFinite(value), true)
  }
})

test("all usage reads begin together and obey host cancellation", async () => {
  const fresh = await import(`./index.mjs?parallel-usage`)
  const hooks = await fresh.KunRouterPlugin({ magpie: { option: () => false } })
  const controller = new AbortController()
  const paths = []
  globalThis.fetch = async (url, { signal }) => {
    paths.push(new URL(url).pathname)
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  }
  const pending = hooks.auth.usage(getAuth, {}, { signal: controller.signal })
  await delay(0)
  assert.deepEqual(paths.sort(), ["/api/status", "/api/user/self", "/api/subscription/self", "/api/subscription/plans", "/api/desktop/keys"].sort())
  controller.abort()
  assert.match((await pending).error, /连不上/)
})

test("403 is permission denied, while 401 and explicit expired codes require sign-in", async () => {
  globalThis.fetch = async () => Response.json({ message: "permission denied" }, { status: 403 })
  assert.equal((await _internal.fetchSelf("pat")).expired, undefined)
  globalThis.fetch = async () => Response.json({}, { status: 401 })
  assert.equal((await _internal.fetchSelf("pat")).expired, true)
  globalThis.fetch = async () => Response.json({ success: false, code: "ACCESS_TOKEN_EXPIRED" })
  assert.equal((await _internal.fetchSelf("pat")).expired, true)
})

test("check-in is skipped when disabled and a forbidden check-in does not expire login", async () => {
  for (const enabled of [false, true]) {
    const fresh = await import(`./index.mjs?checkin-${enabled}`)
    const hooks = await fresh.KunRouterPlugin({ magpie: { option: () => false } })
    let hits = 0
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/api/status")) return Response.json({ data: { checkin_enabled: enabled } })
      hits++
      return Response.json({ success: false, message: "permission denied" }, { status: 403 })
    }
    const outcome = await hooks.auth.checkin(getAuth)
    assert.equal(outcome.outcome, enabled ? "failed" : "inactive")
    assert.equal(hits, enabled ? 1 : 0)
  }
})

test("browser authorization times out and releases its loopback port", async () => {
  let callbackURL
  globalThis.fetch = async (_url, init) => {
    callbackURL = JSON.parse(init.body).redirect_uri
    return Response.json({ success: true, data: { authorization_url: "https://wcnmb.si/desktop/authorize" } })
  }
  const authFlow = await _internal.startBrowserAuthorization(undefined, { timeoutMs: 30 })
  const result = await authFlow.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /超时/)
  await assert.rejects(realFetch(callbackURL))
})

test("key lookup requires a match, follows pagination and prefers key id", async () => {
  globalThis.fetch = async () => Response.json({ data: { items: [{ masked_key: "someone-else", group: "wrong" }] } })
  assert.equal(await _internal.currentGroup("pat", auth.key), "")
  const paths = []
  globalThis.fetch = async (url) => {
    paths.push(String(url))
    if (String(url).endsWith("/42")) return Response.json({ data: { masked_key: _internal.maskKey(auth.key), group: "by-id" } })
    return Response.json({ data: { total: 101, items: new URL(url).searchParams.get("p") === "1"
      ? Array.from({ length: 100 }, () => ({ masked_key: "someone-else" }))
      : [{ masked_key: _internal.maskKey(auth.key), group: "page-two" }] } })
  }
  assert.equal(await _internal.currentGroup("pat", auth.key), "page-two")
  assert.equal(paths.length, 2)
  paths.length = 0
  assert.equal(await _internal.currentGroup("pat", auth.key, 42), "by-id")
  assert.equal(paths.length, 1)
})

test("model discovery consumes advertised limits, modalities and explicit reasoning", async () => {
  const hooks = await plugin()
  globalThis.fetch = async () => Response.json({ data: [
    { id: "gpt-6-custom", reasoning_levels: [], reasoning: true },
    { id: "vision", context_window: 1000000, max_output_tokens: 32000, tool_call: false,
      modalities: { input: ["text", "image"], output: ["text"] }, supported_reasoning_levels: [{ effort: "high" }] },
    { id: "known" },
  ] })
  const previous = { capabilities: { reasoning: true }, variants: { high: { custom: true } }, limit: { context: 200000, output: 10000 } }
  const models = await hooks.provider.models({ models: { known: previous } }, { auth })
  assert.equal(models["gpt-6-custom"].capabilities.reasoning, false)
  assert.deepEqual(models["gpt-6-custom"].variants, {})
  assert.equal(models.vision.limit.context, 1000000)
  assert.equal(models.vision.limit.output, 32000)
  assert.equal(models.vision.capabilities.input.image, true)
  assert.equal(models.vision.capabilities.toolcall, false)
  assert.deepEqual(Object.keys(models.vision.variants), ["high"])
  assert.deepEqual(models.known.variants.high, { custom: true })
})

test("unknown model windows stay unknown in config, discovery and failed discovery", async () => {
  const hooks = await plugin()
  const config = {}
  await hooks.config(config)
  const placeholders = config.provider.kunrouter.models
  for (const model of Object.values(placeholders)) assert.equal(model.limit.context, 0)

  const ids = [...Object.keys(placeholders), "unlisted-alias"]
  globalThis.fetch = async () => Response.json({ data: ids.map((id) => ({ id })) })
  const models = await hooks.provider.models({ models: placeholders }, { auth })
  for (const id of ids) {
    assert.equal(models[id].limit.context, 0, id)
    assert.equal(models[id].limit.output, 8192, id)
  }

  const refreshed = await hooks.provider.models({ models }, { auth })
  for (const id of ids) assert.equal(refreshed[id].limit.context, 0, id)

  globalThis.fetch = async () => new Response(null, { status: 503 })
  const fallback = await hooks.provider.models({ models: placeholders }, { auth })
  assert.equal(fallback[Symbol.for("magpie.fellBack")], true)
  for (const model of Object.values(fallback)) assert.equal(model.limit.context, 0)
})

test("model discovery resolves context aliases without inventing or shrinking windows", async () => {
  const hooks = await plugin()
  const cases = [
    { id: "nested", limit: { context: 1000000 }, expected: 1000000 },
    { id: "window", context_window: 1000000, expected: 1000000 },
    { id: "length", context_length: "1000000", expected: 1000000 },
    { id: "precedence", limit: { context: 200000 }, context_window: 400000, context_length: 1000000, expected: 200000 },
    { id: "zero-nested", limit: { context: 0 }, context_window: 1000000, expected: 1000000 },
    { id: "bad-window", context_window: "invalid", context_length: 1000000, expected: 1000000 },
    { id: "negative-nested", limit: { context: -1 }, context_length: 1000000, expected: 1000000 },
    { id: "known", expected: 400000 },
    { id: "bad-previous", expected: 0 },
    { id: "explicit-128k", context_window: 128000, expected: 128000 },
    { id: "replace-old-default", context_length: 1000000, expected: 1000000 },
    ...[null, 0, -1, "", "invalid", "Infinity", true, [], {}].map((value, i) => ({
      id: `invalid-${i}`, limit: { context: value }, context_window: value, context_length: value, expected: 0,
    })),
  ]
  const previous = {
    known: { limit: { context: 400000, input: 350000, output: 32000 } },
    "bad-previous": { limit: { context: -1 } },
    "explicit-128k": { limit: { context: 1000000 } },
    "replace-old-default": { limit: { context: 128000 } },
  }
  globalThis.fetch = async () => Response.json({ data: cases.map(({ expected, ...model }) => model) })
  const models = await hooks.provider.models({ models: previous }, { auth })
  for (const { id, expected } of cases) assert.equal(models[id].limit.context, expected, id)
  assert.deepEqual(models.known.limit, previous.known.limit)
  assert.equal(previous["replace-old-default"].limit.context, 128000)

  // A later response containing only ids must retain previously advertised limits.
  globalThis.fetch = async () => Response.json({ data: [{ id: "length" }] })
  const refreshed = await hooks.provider.models({ models }, { auth })
  assert.equal(refreshed.length.limit.context, 1000000)
})

test("standalone OpenCode keeps its compaction-compatible default and honors configured windows", async () => {
  globalThis.fetch = async () => Response.json({ data: [{ id: "unknown" }, { id: "configured" }, { id: "advertised", context_length: 1000000 }] })
  const hooks = await KunRouterPlugin({})
  const config = {}
  await hooks.config(config)
  for (const model of Object.values(config.provider.kunrouter.models)) assert.equal(model.limit.context, 128000)
  const models = await hooks.provider.models({ models: { configured: { limit: { context: 1000000 } } } }, { auth })
  assert.equal(models.unknown.limit.context, 128000)
  assert.equal(models.configured.limit.context, 1000000)
  assert.equal(models.advertised.limit.context, 1000000)
})

test("model verification and discovery use selected domain, with one network fallback", async () => {
  const paths = []
  const hooks = await plugin({ direct_api: false })
  globalThis.fetch = async (url) => {
    paths.push(String(url))
    return String(url).endsWith("/api/user/self")
      ? Response.json({ success: true, data: { id: 1 } }) : Response.json({ data: [{ id: "current" }] })
  }
  assert.equal((await hooks.auth.methods.find((m) => m.type === "api").authorize({ accessToken: "pat-test", apiKey: auth.key })).type, "success")
  await hooks.provider.models({ models: {} }, { auth })
  assert.equal(paths.filter((url) => url.endsWith("/v1/models")).every((url) => url.startsWith("https://wcnmb.si/")), true)
  paths.length = 0
  globalThis.fetch = async (url) => {
    paths.push(String(url))
    if (String(url).startsWith("https://direct.wcnmb.fun")) throw new Error("DNS unavailable")
    return Response.json({ data: [{ id: "current" }] })
  }
  assert.ok((await (await plugin()).provider.models({ models: {} }, { auth })).current)
  assert.equal(paths.length, 2)
})

test("cancelled discovery and model requests never retry another domain", async () => {
  const hooks = await plugin()
  const controller = new AbortController()
  let hits = 0
  globalThis.fetch = async () => {
    hits++
    controller.abort()
    throw controller.signal.reason
  }
  const models = await hooks.provider.models({ models: { old: {} } }, { auth, signal: controller.signal })
  assert.equal(models[Symbol.for("magpie.fellBack")], true)
  assert.equal(hits, 1)
  const loader = await hooks.auth.loader(getAuth)
  await assert.rejects(loader.fetch("https://direct.wcnmb.fun/v1/responses", { method: "POST", body: "{}", signal: controller.signal }))
  assert.equal(hits, 2)
})

test("Request headers and signal survive the loader and streaming uploads are not replayed", async () => {
  const hooks = await plugin()
  const loader = await hooks.auth.loader(getAuth)
  const controller = new AbortController()
  let hits = 0
  globalThis.fetch = async (request, init) => {
    hits++
    assert.equal(request.method, "POST")
    assert.equal(init.headers.get("content-type"), "application/json")
    assert.equal(init.headers.get("authorization"), `Bearer ${auth.key}`)
    assert.equal(await request.text(), "{}")
    controller.abort()
    throw new Error("network interrupted")
  }
  const request = new Request("https://direct.wcnmb.fun/v1/responses", {
    method: "POST", body: "{}", headers: { "content-type": "application/json" }, signal: controller.signal,
  })
  await assert.rejects(loader.fetch(request))
  assert.equal(hits, 1)
})

test("key recovery after direct-domain failure retries the working main site", async () => {
  const hooks = await plugin()
  const loader = await hooks.auth.loader(async () => ({ ...auth, metadata: { ...auth.metadata, accessToken: "pat-fallback-recovery" } }))
  const paths = []
  globalThis.fetch = async (url, init) => {
    paths.push(String(url))
    if (String(url).startsWith("https://direct.wcnmb.fun")) throw new Error("direct unavailable")
    if (String(url).endsWith("/api/desktop/keys")) return Response.json({ success: true, data: { key: "sk-new" } })
    return new Response("", { status: init.headers.get("authorization") === "Bearer sk-new" ? 200 : 401 })
  }
  const result = await loader.fetch("https://direct.wcnmb.fun/v1/responses", { method: "POST", body: "{}" })
  assert.equal(result.status, 200)
  assert.equal(paths.filter((url) => url.startsWith("https://direct.wcnmb.fun")).length, 1)
})

test("streaming usage, cached tokens, tool calls and charge fields pass through unchanged", async () => {
  const hooks = await plugin()
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"shell"}}]}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80},"quota":42,"cost":0.1}}\n\n',
    'data: [DONE]\n\n',
  ]
  const response = new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
    controller.close()
  } }), { headers: { "content-type": "text/event-stream" } })
  globalThis.fetch = async () => response
  const loader = await hooks.auth.loader(getAuth)
  const result = await loader.fetch("https://direct.wcnmb.fun/v1/chat/completions", { method: "POST", body: "{}" })
  assert.equal(result, response)
  assert.equal(await result.text(), chunks.join(""))
})
