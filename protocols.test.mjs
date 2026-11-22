import assert from "node:assert/strict"
import { after, test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { applyProtocols, createProtocolDetector, protocolRequest, readProtocols } from "./protocols.mjs"

const realFetch = globalThis.fetch
after(() => { globalThis.fetch = realFetch })
const base = "https://relay.example"
const key = "sk-protocol-test"
const all = ["chat", "responses", "anthropic", "gemini"]
const sdk = {
  chat: "@ai-sdk/openai-compatible", responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic", gemini: "@ai-sdk/google",
}

function protocolOf(url) {
  const path = new URL(url).pathname
  if (path.endsWith("/chat/completions")) return "chat"
  if (path.endsWith("/responses")) return "responses"
  if (path.endsWith("/messages")) return "anthropic"
  if (path.includes(":generateContent")) return "gemini"
  assert.fail(`unexpected probe URL: ${url}`)
}

function success(protocol) {
  return Response.json({
    chat: { id: "chat-1", object: "chat.completion", choices: [{ message: { role: "assistant", content: "hi" } }] },
    responses: { id: "resp-1", object: "response", output: [] },
    anthropic: { id: "msg-1", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }] },
    gemini: { candidates: [{ content: { parts: [{ text: "hi" }], role: "model" } }] },
  }[protocol])
}

test("protocol metadata recognizes New API declarations, native paths and SDK names", () => {
  assert.deepEqual(readProtocols({ supported_endpoint_types: ["openai", "openai-response", "anthropic", "gemini", "openai"] }), all)
  assert.deepEqual(readProtocols({ native_endpoints: [
    "/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1beta/models/{model}:generateContent",
  ] }), all)
  assert.deepEqual(readProtocols({ api: { npm: sdk.anthropic }, also: [sdk.responses, sdk.gemini] }), ["anthropic", "responses", "gemini"])
  assert.equal(readProtocols({ id: "gemini-looking-name" }), undefined)
  assert.equal(readProtocols({ supported_endpoint_types: ["embedding", "unknown"] }), undefined)
})

test("applying protocols retains a supported primary and declares the remaining APIs", () => {
  const info = { id: "multi", name: "Multi", api: { id: "wire-id", npm: sdk.anthropic, url: "https://old.example/v1" }, limit: { context: 1000000 } }
  const updated = applyProtocols(info, ["chat", "responses", "anthropic", "gemini"], base)
  assert.equal(updated.api.npm, sdk.anthropic)
  assert.equal(updated.api.id, "wire-id")
  assert.equal(updated.api.url, `${base}/v1`)
  assert.deepEqual(updated.also, [sdk.chat, sdk.responses, sdk.gemini])
  assert.equal(updated.limit.context, 1000000)
  assert.equal(info.api.url, "https://old.example/v1")
  assert.equal(info.also, undefined)
})

test("single-protocol models select Responses, Messages or Gemini without a false Chat declaration", () => {
  for (const protocol of ["responses", "anthropic", "gemini"]) {
    const updated = applyProtocols({ id: protocol, api: { npm: sdk.chat } }, [protocol], base)
    assert.equal(updated.api.npm, sdk[protocol])
    assert.equal(updated.api.url, `${base}/${protocol === "gemini" ? "v1beta" : "v1"}`)
    assert.deepEqual(updated.also, [])
  }
})

test("protocol requests replace stale credentials according to the requested endpoint", () => {
  const original = new Headers({ authorization: "Bearer old", "x-api-key": "old-anthropic", "x-goog-api-key": "old-google", "x-custom": "keep" })
  for (const path of ["/v1/chat/completions", "/v1/responses"]) {
    const request = protocolRequest(base + path, original, key)
    assert.equal(request.url, base + path)
    assert.equal(request.headers.get("authorization"), `Bearer ${key}`)
    assert.equal(request.headers.has("x-api-key"), false)
    assert.equal(request.headers.has("x-goog-api-key"), false)
    assert.equal(request.headers.get("x-custom"), "keep")
  }
  const message = protocolRequest(`${base}/v1/messages`, original, key)
  assert.equal(message.headers.get("x-api-key"), key)
  assert.equal(message.headers.get("anthropic-version"), "2023-06-01")
  assert.equal(message.headers.has("x-goog-api-key"), false)
  assert.equal(original.get("authorization"), "Bearer old")
  assert.equal(original.get("x-api-key"), "old-anthropic")
})

test("Gemini requests use v1beta, preserve the encoded model and SSE query, and replace key query auth", () => {
  const request = protocolRequest(`${base}/v1/models/vendor%2Fgemini:streamGenerateContent?alt=sse&key=old-query`, new Headers({ "x-api-key": "old" }), key)
  const url = new URL(request.url)
  assert.equal(url.pathname, "/v1beta/models/vendor%2Fgemini:streamGenerateContent")
  assert.equal(url.searchParams.get("alt"), "sse")
  assert.equal(url.searchParams.has("key"), false)
  assert.equal(request.headers.get("x-goog-api-key"), key)
  assert.equal(request.headers.has("x-api-key"), false)
  assert.equal(protocolRequest(`${base}/v1beta/models/gemini:generateContent`, new Headers(), key).url, `${base}/v1beta/models/gemini:generateContent`)
})

test("detection sends four bounded non-streaming requests and verifies all native response shapes", async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    const protocol = protocolOf(url)
    const headers = new Headers(init.headers)
    const body = JSON.parse(init.body)
    seen.push({ url: String(url), protocol, body })
    assert.equal(init.method, "POST")
    assert.equal(body.stream === true, false)
    assert.equal(headers.get("authorization"), `Bearer ${key}`)
    if (protocol === "anthropic") assert.equal(headers.get("x-api-key"), key)
    if (protocol === "gemini") {
      assert.equal(headers.get("x-goog-api-key"), key)
      assert.equal(body.generationConfig.maxOutputTokens, 16)
      assert.deepEqual(body.contents[0].parts, [{ text: "hi" }])
    } else {
      assert.equal(body.model, "model-a")
      assert.equal(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens, 16)
    }
    if (protocol === "responses") assert.equal(Array.isArray(body.input), true)
    return success(protocol)
  }
  const result = await createProtocolDetector()([{ id: "model-a" }], key, base)
  assert.deepEqual(result.get("model-a"), all)
  assert.equal(seen.length, 4)
  assert.ok(seen.some((r) => r.url === `${base}/v1beta/models/model-a:generateContent`))
})

test("HTTP 200 HTML and error envelopes never count as supported protocols", async () => {
  globalThis.fetch = async (url) => {
    switch (protocolOf(url)) {
      case "chat": return Response.json({ error: { message: "upstream failed" } })
      case "responses": return new Response("<html>login page</html>", { headers: { "content-type": "text/html" } })
      case "anthropic": return Response.json({ type: "error", error: { message: "not supported" } })
      case "gemini": return Response.json({ candidates: [], error: { code: 500, message: "error" } })
    }
  }
  const result = await createProtocolDetector()([{ id: "fake-success" }], key, base)
  assert.deepEqual(result.get("fake-success") ?? [], [])
})

test("transient failures retain declared native protocols without adding unverified ones", async () => {
  globalThis.fetch = async (url) => {
    const protocol = protocolOf(url)
    if (protocol === "chat") return success(protocol)
    return Response.json({ error: { message: "try later" } }, { status: protocol === "responses" ? 401 : 429 })
  }
  const result = await createProtocolDetector()([{ id: "transient", api: { npm: sdk.responses }, also: [sdk.anthropic] }], key, base)
  assert.deepEqual(new Set(result.get("transient")), new Set(["chat", "responses", "anthropic"]))
})

test("clear unsupported endpoints are excluded while a working native protocol is kept", async () => {
  globalThis.fetch = async (url) => protocolOf(url) === "responses"
    ? success("responses") : Response.json({ error: { message: "not found" } }, { status: 404 })
  const result = await createProtocolDetector()([{ id: "responses-only", api: { npm: sdk.chat }, also: [sdk.responses, sdk.anthropic] }], key, base)
  assert.deepEqual(result.get("responses-only"), ["responses"])
})

test("probe caches are isolated by API key and base URL, including unsupported endpoint results", async () => {
  let hits = 0
  globalThis.fetch = async (url) => {
    hits++
    return protocolOf(url) === "chat" ? success("chat") : new Response(null, { status: 404 })
  }
  const detect = createProtocolDetector()
  const models = [{ id: "cached" }]
  assert.deepEqual((await detect(models, key, base)).get("cached"), ["chat"])
  assert.equal(hits, 4)
  await detect(models, key, base)
  assert.equal(hits, 4)
  await detect(models, "sk-another-account", base)
  assert.equal(hits, 8)
  await detect(models, key, "https://other.example")
  assert.equal(hits, 12)
})

test("expired probe cache entries are tested again", async () => {
  let hits = 0
  globalThis.fetch = async (url) => { hits++; return success(protocolOf(url)) }
  const detect = createProtocolDetector({ ttlMs: 1 })
  await detect([{ id: "expires" }], key, base)
  await delay(5)
  await detect([{ id: "expires" }], key, base)
  assert.equal(hits, 8)
})

test("expired positive detection survives a transient recheck without restoring guessed Chat", async () => {
  let transient = false
  globalThis.fetch = async (url) => {
    if (transient) return Response.json({ error: { message: "rate limited" } }, { status: 429 })
    return protocolOf(url) === "responses" ? success("responses") : new Response(null, { status: 404 })
  }
  const detect = createProtocolDetector({ ttlMs: 1 })
  const guessed = [{ id: "native-response", api: { npm: sdk.chat } }]
  assert.deepEqual((await detect(guessed, key, base)).get("native-response"), ["responses"])
  await delay(5)
  transient = true
  assert.deepEqual((await detect(guessed, key, base)).get("native-response"), ["responses"])
})

test("completed model results are cached even when a later model exhausts the detection budget", async () => {
  const hits = new Map()
  let releaseSlow = false
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const model = body.model ?? decodeURIComponent(new URL(url).pathname.match(/\/models\/([^:]+):/)[1])
    hits.set(model, (hits.get(model) ?? 0) + 1)
    if (model === "later" && !releaseSlow) return new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason)
      else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
    })
    return success(protocolOf(url))
  }
  const detect = createProtocolDetector({ concurrency: 1, timeoutMs: 1000, budgetMs: 60 })
  const models = [{ id: "completed" }, { id: "later" }]
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const first = await detect(models, key, base)
    assert.deepEqual(first.get("completed"), all)
    assert.equal(hits.get("completed"), 4)
    assert.equal(hits.get("later"), 1)
    releaseSlow = true
    const second = await detect(models, key, base)
    assert.deepEqual(second.get("completed"), all)
    assert.deepEqual(second.get("later"), all)
    assert.equal(hits.get("completed"), 4, "the completed model was unnecessarily probed again")
    assert.equal(hits.get("later"), 5)
  } finally { clearInterval(keepAlive) }
})

test("detection bounds total concurrency and the number of newly probed models", async () => {
  let active = 0
  let peak = 0
  let hits = 0
  globalThis.fetch = async (url) => {
    hits++
    peak = Math.max(peak, ++active)
    await delay(3)
    active--
    return success(protocolOf(url))
  }
  await createProtocolDetector({ concurrency: 2, maxModels: 2 })([{ id: "a" }, { id: "b" }, { id: "c" }], key, base)
  assert.equal(hits, 8)
  assert.ok(peak <= 2, `peak probe concurrency: ${peak}`)
})

test("caller cancellation aborts active requests and stops queued probes", async () => {
  const controller = new AbortController()
  let hits = 0
  globalThis.fetch = async (_url, init) => {
    hits++
    controller.abort(new Error("cancelled by caller"))
    assert.equal(init.signal.aborted, true)
    throw init.signal.reason
  }
  const detect = createProtocolDetector({ concurrency: 1 })
  try { await detect([{ id: "a" }, { id: "b" }], key, base, controller.signal) } catch (error) {
    assert.match(error.message, /cancelled/)
  }
  assert.equal(hits, 1)
})

test("an already cancelled detection sends no requests", async () => {
  let hits = 0
  globalThis.fetch = async () => { hits++; assert.fail("cancelled detection sent a request") }
  const controller = new AbortController()
  controller.abort()
  try { await createProtocolDetector()([{ id: "cancelled" }], key, base, controller.signal) } catch {}
  assert.equal(hits, 0)
})

test("probe timeouts finish without claiming an unverified protocol", async () => {
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(init.signal.reason)
    else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  })
  // Keep the event loop alive: AbortSignal.timeout uses an unref'ed timer in Node.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const result = await createProtocolDetector({ timeoutMs: 5, budgetMs: 20 })([{ id: "slow" }], key, base)
    assert.deepEqual(result.get("slow") ?? [], [])
  } finally { clearInterval(keepAlive) }
})
