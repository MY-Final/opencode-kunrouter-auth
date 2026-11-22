import { createHash } from "node:crypto"

const SDK = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
}
const ORDER = Object.keys(SDK)

function protocolOf(value) {
  if (typeof value !== "string") return undefined
  const s = value.toLowerCase().replace(/\/+$/, "")
  return ORDER.find((p) => SDK[p] === s)
    ?? ({ openai: "chat", "openai-response": "responses", messages: "anthropic" })[s]
    ?? (ORDER.includes(s) ? s : undefined)
    ?? (s.endsWith("/chat/completions") ? "chat"
      : s.endsWith("/responses") ? "responses"
      : s.endsWith("/messages") ? "anthropic"
      : /:(?:streamgeneratecontent|generatecontent)$/.test(s) ? "gemini" : undefined)
}

// Only consume explicit endpoint declarations. A model name is not evidence of an API.
export function readProtocols(model) {
  const values = [
    ...(Array.isArray(model.supported_endpoint_types) ? model.supported_endpoint_types : []),
    ...(Array.isArray(model.native_endpoints) ? model.native_endpoints : []),
    model.api?.npm,
    ...(Array.isArray(model.also) ? model.also : []),
  ]
  const protocols = [...new Set(values.map(protocolOf).filter(Boolean))]
  return protocols.length ? protocols : undefined
}

export function applyProtocols(info, protocols, base) {
  const supported = [...new Set(protocols.filter((p) => SDK[p]))]
  if (!supported.length) return info
  const primary = supported.includes(protocolOf(info.api?.npm)) ? protocolOf(info.api.npm) : supported[0]
  return {
    ...info,
    api: { ...info.api, npm: SDK[primary], url: `${base}/${primary === "gemini" ? "v1beta" : "v1"}` },
    also: supported.filter((p) => p !== primary).map((p) => SDK[p]),
  }
}

// The host's global loader base is /v1, even when a model's alternate API is Gemini.
// SDK headers may also belong to the primary API rather than the API being requested.
export function protocolRequest(url, headers, key) {
  const target = new URL(url)
  const h = new Headers(headers)
  h.set("authorization", `Bearer ${key}`)
  h.delete("x-api-key")
  h.delete("x-goog-api-key")
  if (/\/models\/.+:(?:streamGenerateContent|generateContent)$/.test(target.pathname)) {
    target.pathname = target.pathname.replace(/\/v1\/models\//, "/v1beta/models/")
    target.searchParams.delete("key")
    h.set("x-goog-api-key", key)
  } else if (target.pathname.endsWith("/messages")) {
    h.set("x-api-key", key)
    if (!h.has("anthropic-version")) h.set("anthropic-version", "2023-06-01")
  }
  return { url: target.toString(), headers: h }
}

function probeRequest(protocol, id, base) {
  const message = { role: "user", content: "hi" }
  switch (protocol) {
    case "chat": return { url: `${base}/v1/chat/completions`, body: { model: id, messages: [message], max_tokens: 16 } }
    case "responses": return { url: `${base}/v1/responses`, body: {
      model: id, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], max_output_tokens: 16,
    } }
    case "anthropic": return { url: `${base}/v1/messages`, body: { model: id, messages: [message], max_tokens: 16 } }
    case "gemini": return { url: `${base}/v1beta/models/${encodeURIComponent(id)}:generateContent`, body: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 16 },
    } }
  }
}

function validReply(protocol, body) {
  if (!body || body.error || body.success === false) return false
  switch (protocol) {
    case "chat": return Array.isArray(body.choices)
    case "responses": return body.object === "response" && Array.isArray(body.output)
    case "anthropic": return body.type === "message" && Array.isArray(body.content)
    case "gemini": return Array.isArray(body.candidates)
  }
  return false
}

// Opt-in generation probes: small requests, bounded work, per-credential cache, no credentials on disk.
export function createProtocolDetector({ timeoutMs = 8000, budgetMs = 10000, ttlMs = 300000, concurrency = 4, maxModels = 20 } = {}) {
  const cache = new Map()
  return async (models, key, base, signal) => {
    const out = new Map()
    if (signal?.aborted || !key) return out
    const credential = createHash("sha256").update(key).digest("hex")
    const now = Date.now()
    // Keep stale verified evidence while refreshing: a 429 must not turn a Responses-only model into Chat.
    for (const [k, v] of cache) if (v.until + 86400000 <= now) cache.delete(k)
    const pending = []
    const seen = new Set()
    for (const model of models) {
      if (!model?.id || seen.has(model.id)) continue
      seen.add(model.id)
      const cacheKey = JSON.stringify([base, credential, model.id])
      const remembered = cache.get(cacheKey)
      if (remembered?.until > now) {
        out.set(model.id, mergeProtocols(model, remembered.results))
      } else if (pending.length < maxModels) pending.push({ model, cacheKey, results: {}, previous: remembered?.results })
      else if (remembered) out.set(model.id, mergeProtocols(model, remembered.results))
    }
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(budgetMs)])
    const queue = pending.flatMap((item) => ORDER.map((protocol) => ({ item, protocol })))
    let cursor = 0
    const worker = async () => {
      while (!bounded.aborted && cursor < queue.length) {
        const { item, protocol } = queue[cursor++]
        const request = probeRequest(protocol, item.model.id, base)
        const wire = protocolRequest(request.url, { "content-type": "application/json" }, key)
        const probeSignal = AbortSignal.any([bounded, AbortSignal.timeout(timeoutMs)])
        let result = "unknown"
        try {
          const res = await fetch(wire.url, {
            method: "POST", headers: wire.headers, body: JSON.stringify(request.body), signal: probeSignal,
          })
          if ([404, 405, 501].includes(res.status)) {
            result = "unsupported"
            await res.body?.cancel()
          } else if (res.ok) {
            const body = await res.json().catch(() => null)
            if (validReply(protocol, body)) result = "supported"
          } else {
            await res.body?.cancel()
          }
        } catch { /* timeout, refusal and rate limits say nothing certain about an API */ }
        item.results[protocol] = result
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    for (const item of pending) {
      const results = { ...item.previous }
      for (const [protocol, result] of Object.entries(item.results)) {
        if (result !== "unknown" || !results[protocol]) results[protocol] = result
      }
      out.set(item.model.id, mergeProtocols(item.model, results))
      if (!signal?.aborted && Object.keys(item.results).length === ORDER.length) {
        // Transient failures are retried sooner; an aborted detection never becomes cached truth.
        const unknown = Object.values(item.results).includes("unknown")
        cache.set(item.cacheKey, { results, until: Date.now() + (unknown ? Math.min(ttlMs, 15000) : ttlMs) })
      }
    }
    // Keep memory bounded across key rotations and changing model lists.
    while (cache.size > 512) cache.delete(cache.keys().next().value)
    return out
  }
}

function mergeProtocols(model, results) {
  const known = new Set(readProtocols(model) ?? [])
  for (const [protocol, result] of Object.entries(results)) {
    if (result === "supported") known.add(protocol)
    else if (result === "unsupported") known.delete(protocol)
  }
  return ORDER.filter((p) => known.has(p))
}
