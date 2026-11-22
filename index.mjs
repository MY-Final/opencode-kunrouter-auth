// KunRouter (wcnmb.si) provider plugin for OpenCode / magpie.
//
// KunRouter 跑的是 new-api（one-api 的分支）。账号密码登录走浏览器授权，
// 访问令牌留在 metadata，模型请求使用站点为该插件单独签发的 sk- 密钥。
// 余额和签到走站点侧的 /api，模型请求走直连域名，绕开 Cloudflare 的 100 秒上限。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { homedir, hostname } from "node:os"
import { applyProtocols, createProtocolDetector, protocolRequest, protocolSDK, readProtocols } from "./protocols.mjs"
import { apiRoot, publishLoginDefaults, publishProtocolReport } from "./controls.mjs"

const PROVIDER = "kunrouter"
const SITE =
  process.env.KUNROUTER_SITE?.replace(/\/+$/, "") || "https://wcnmb.si" // 控制台 + /api
const API =
  process.env.KUNROUTER_API?.replace(/\/+$/, "") ||
  "https://direct.wcnmb.fun" // 直连 /v1，不受 CF 超时限制
const SITE_OVERRIDE = !!process.env.KUNROUTER_SITE
const API_OVERRIDE = !!process.env.KUNROUTER_API
const DIRECT_BY_ORIGIN = {
  "https://wcnmb.si": "https://direct.wcnmb.si",
  "https://wcnmb.fun": "https://direct.wcnmb.fun",
}
const VERSION = "0.10.0"
const MAGPIE_CLIENT_ID = "magpie"
const ICON_URL = "https://raw.githubusercontent.com/MY-Final/opencode-kunrouter-auth/main/assets/kunrouter-icon.png"
// 活动邀请码。改活动时优先用环境变量覆盖，不用改代码发版。
const INVITE_CODE = (
  process.env.KUNROUTER_INVITE_CODE ?? "shjglbwadfbhblqvwcpqoqbo"
).trim()
const AUTHORIZATION_ORIGIN_SETTING =
  process.env.KUNROUTER_AUTH_ORIGIN?.trim() || ""
const PUBLIC_AUTHORIZATION_ORIGINS = [
  "https://wcnmb.fun",
  "https://wcnmb.si",
  "https://kuncode.120403.xyz",
]
const CONFIGURED_AUTHORIZATION_ORIGIN = normalizeAuthorizationOrigin(
  AUTHORIZATION_ORIGIN_SETTING,
)
const AUTHORIZATION_ORIGIN = PUBLIC_AUTHORIZATION_ORIGINS.includes(
  CONFIGURED_AUTHORIZATION_ORIGIN,
)
  ? CONFIGURED_AUTHORIZATION_ORIGIN
  : PUBLIC_AUTHORIZATION_ORIGINS[0]
const AUTHORIZATION_ORIGIN_INVALID =
  Boolean(AUTHORIZATION_ORIGIN_SETTING) &&
  !PUBLIC_AUTHORIZATION_ORIGINS.includes(CONFIGURED_AUTHORIZATION_ORIGIN)
const AUTHORIZATION_ORIGINS = [
  AUTHORIZATION_ORIGIN,
  ...PUBLIC_AUTHORIZATION_ORIGINS.filter((origin) => origin !== AUTHORIZATION_ORIGIN),
]
const TRUSTED_AUTHORIZATION_DOMAINS = new Set([
  ...PUBLIC_AUTHORIZATION_ORIGINS.map((origin) => new URL(origin).hostname),
  new URL(SITE).hostname,
])

// new-api 的默认换算：500000 quota = 1 美元，站点 /api/status 会覆盖。
const DEFAULT_QUOTA_PER_UNIT = 500000
const STATUS_TTL_MS = 10 * 60 * 1000
// 站点 /api 请求统一超时，免得网络卡住时额度卡和签到一起挂死。
const REQUEST_TIMEOUT_MS = 10000
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000
const INVITE_STATUS_TTL_MS = 5 * 60 * 1000
// 插件加载时要等这次邀请码检查，超时放短一点，别因为站点慢拖住整个插件。
const INVITE_CHECK_TIMEOUT_MS = 2500

// 拉不到模型列表时的兜底，名字稳定，不至于让供应商空着。
const DEFAULT_MODELS = {
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "glm-5.3-flash": "GLM-5.3 Flash",
  "minimax-m3.1-flash": "MiniMax M3.1 Flash",
}

const baseModel = {
  // 0 表示未知，交给宿主目录或用户设置；猜出的 128K 会被当成真实上限。
  limit: { context: 0, output: 8192 },
  tool_call: true,
}

// 站点级配置（币种符号、quota 换算）不属于任何账号，缓存这里是安全的。
const statusCache = new Map()
// 邀请码是否还能用，也做短缓存，避免每次加载插件都打一次站点的脸。
let inviteCache = { code: "", at: 0, value: null }

function requestSignal(signal, timeout = REQUEST_TIMEOUT_MS) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
}

function finite(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function timestamp(value) {
  const seconds = finite(value)
  if (seconds <= 0) return undefined
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function authExpired(status, body) {
  return status === 401 || /^(AUTH_UNAUTHORIZED|ACCESS_TOKEN_LEGACY_RETIRED|ACCESS_TOKEN_EXPIRED)$/.test(String(body?.code || body?.message_key || ""))
}

async function siteStatus(signal, site = SITE) {
  const now = Date.now()
  const cached = statusCache.get(site)
  if (cached?.value && now - cached.at < STATUS_TTL_MS) return cached.value
  try {
    const res = await fetch(`${site}/api/status`, {
      headers: clientHeaders(),
      signal: requestSignal(signal),
    })
    if (!res.ok) return cached?.value ?? {}
    const data = (await res.json())?.data ?? {}
    const value = {
      quotaPerUnit: finite(data.quota_per_unit) > 0 ? Number(data.quota_per_unit) : DEFAULT_QUOTA_PER_UNIT,
      symbol: typeof data.custom_currency_symbol === "string" && data.custom_currency_symbol
        ? data.custom_currency_symbol
        : "$",
      name: data.system_name || "KunRouter",
      checkinEnabled: typeof data.checkin_enabled === "boolean" ? data.checkin_enabled : undefined,
    }
    statusCache.set(site, { at: now, value })
    return value
  } catch {
    return cached?.value ?? {}
  }
}

function clientHeaders() {
  return { "x-kunrouter-client": `opencode-kunrouter-auth/${VERSION}` }
}

// 站点公开接口 GET /api/invite_codes/public/:code 会告诉我们这个码还能不能用。
// 用不了（禁用 / 过期 / 名额满）就别再把注册入口摆出来，省得用户点进去才看到报错。
// 网络抖动时按「未知」处理、仍然展示入口，宁可多给一次机会也别把能用的码藏了。
async function inviteCodeState(code) {
  if (!code) return { available: false, unknown: false }
  const now = Date.now()
  if (inviteCache.code === code && now - inviteCache.at < INVITE_STATUS_TTL_MS) {
    return inviteCache.value
  }
  let value
  try {
    const res = await fetch(
      `${SITE}/api/invite_codes/public/${encodeURIComponent(code)}`,
      { headers: clientHeaders(), signal: AbortSignal.timeout(INVITE_CHECK_TIMEOUT_MS) },
    )
    if (res.status === 404) {
      value = { available: false, unknown: false, reason: "invalid" }
    } else if (!res.ok) {
      value = { available: true, unknown: true }
    } else {
      const body = await res.json().catch(() => null)
      const data = body?.data
      if (!data) {
        value = { available: true, unknown: true }
      } else {
        value = {
          available: data.available === true,
          unknown: false,
          reason: typeof data.reason === "string" ? data.reason : "",
          remaining: Number(data.remaining_registrations) || 0,
        }
      }
    }
  } catch {
    value = { available: true, unknown: true }
  }
  inviteCache = { code, at: now, value }
  return value
}

// 站点存的是不带 sk- 前缀的 Key，遮罩也按去前缀之后算，用来和列表里的 masked_key 对上。
function maskKey(key) {
  if (!key) return ""
  const raw = key.startsWith("sk-") ? key.slice(3) : key
  if (raw.length <= 4) return "*".repeat(raw.length)
  if (raw.length <= 8) return `${raw.slice(0, 2)}****${raw.slice(-2)}`
  return `${raw.slice(0, 4)}**********${raw.slice(-4)}`
}

// 额度卡上的分组别用授权时的快照：用户可能在控制台改过 Key 的分组。
// 拿访问令牌列表里按遮罩匹配出真实分组，读不到就交给调用方退回快照。
async function currentGroup(accessToken, apiKey, keyId, signal, site = SITE) {
  if (!accessToken || !apiKey) return ""
  const bounded = requestSignal(signal)
  try {
    if (Number.isSafeInteger(Number(keyId)) && Number(keyId) > 0) {
      const res = await fetch(`${site}/api/desktop/keys/${Number(keyId)}`, {
        headers: authHeaders(accessToken), signal: bounded,
      })
      if (res.ok) {
        const item = (await res.json())?.data
        if (item?.masked_key === maskKey(apiKey) && typeof item.group === "string") return item.group
      }
    }
    for (let page = 1; ; page++) {
      bounded.throwIfAborted()
      const res = await fetch(`${site}/api/desktop/keys?p=${page}&page_size=100`, {
        headers: authHeaders(accessToken), signal: bounded,
      })
      if (!res.ok) return ""
      const data = (await res.json())?.data
      const items = data?.items
      if (!Array.isArray(items) || items.length === 0) return ""
      const matches = items.filter((item) => item?.masked_key === maskKey(apiKey))
      if (matches.length > 1) return ""
      if (matches.length === 1) return typeof matches[0].group === "string" ? matches[0].group : ""
      if (items.length < 100 || page * 100 >= finite(data.total, Infinity)) return ""
    }
  } catch {
    return ""
  }
}

function authHeaders(key) {
  return { authorization: `Bearer ${key}`, ...clientHeaders() }
}

function tokenOf(auth) {
  const fromMeta =
    typeof auth?.metadata?.accessToken === "string"
      ? auth.metadata.accessToken.trim()
      : ""
  if (fromMeta) return fromMeta
  const key = typeof auth?.key === "string" ? auth.key.trim() : ""
  return key && !key.startsWith("sk-") ? key : ""
}

// new-api 有两套凭据：访问令牌只能读 /api（余额、签到），sk- 密钥只能调 /v1。
// 浏览器授权会把访问令牌放 metadata，把 sk- 密钥放主 key；手工登录也兼容。
function apiKeyOf(auth) {
  const meta = auth?.metadata
  const fromMeta = typeof meta?.apiKey === "string" ? meta.apiKey.trim() : ""
  if (fromMeta) return fromMeta
  const key = typeof auth?.key === "string" ? auth.key.trim() : ""
  return key.startsWith("sk-") ? key : ""
}

function authorizationError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    type: "failed",
    error: (message || "KunRouter 浏览器授权失败").slice(0, 480),
  }
}

function randomURIToken() {
  return randomBytes(32).toString("base64url")
}

function stableInstallationId() {
  const digest = createHash("sha256")
    .update(`kunrouter-magpie-v1\0${hostname()}\0${homedir()}`)
    .digest()
    .subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function deviceName() {
  return (hostname() || "Magpie").slice(0, 32)
}

function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function normalizeAuthorizationOrigin(value) {
  if (!value) return ""
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) return ""
    return url.origin
  } catch {
    return ""
  }
}

function authorizationPageURL(value, origin = AUTHORIZATION_ORIGIN) {
  if (!isAllowedAuthorizationURL(value)) {
    throw new Error("KunRouter 返回了无效的授权地址")
  }
  const source = new URL(value)
  const preferredOrigin = normalizeAuthorizationOrigin(origin)
  if (!preferredOrigin) {
    throw new Error("KUNROUTER_AUTH_ORIGIN 不是有效的 HTTPS 域名")
  }
  const preferred = new URL("/desktop/authorize", preferredOrigin)
  preferred.search = source.search
  if (!isAllowedAuthorizationURL(preferred)) {
    throw new Error("KUNROUTER_AUTH_ORIGIN 不是受信任的 KunRouter 地址")
  }
  return preferred
}

function isAllowedAuthorizationURL(value) {
  try {
    const url = new URL(String(value || ""))
    const localHTTP =
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    const trustedHost = TRUSTED_AUTHORIZATION_DOMAINS.has(url.hostname)
    // 授权只应落在授权页，不能是信任域上的任意路径。
    // 注册和登录走同一个 /desktop/authorize，用 query 区分，所以一条路径就够。
    const allowedPath = url.pathname === "/desktop/authorize"
    return (
      (url.protocol === "https:" || localHTTP) &&
      trustedHost &&
      allowedPath
    )
  } catch {
    return false
  }
}

async function responseJSON(res) {
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.success !== true) {
    const message =
      typeof body?.message === "string" && body.message
        ? body.message
        : `KunRouter 返回 ${res.status}`
    throw new Error(message)
  }
  return body.data
}

function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("无法分配本地回调端口"))
        return
      }
      resolve(address.port)
    })
  })
}

function waitForLoopbackCallback(server, expectedState, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      fn(value)
    }
    const onAbort = () => finish(reject, new Error(signal?.reason?.name === "TimeoutError" ? "浏览器授权已超时，请重试" : "浏览器授权已取消"))
    if (signal?.aborted) {
      reject(new Error("浏览器授权已取消"))
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    server.on("request", (req, res) => {
      if (settled) {
        res.writeHead(409, { "content-type": "text/plain; charset=utf-8" })
        res.end("授权请求已处理")
        return
      }
      let callback
      let code
      try {
        callback = new URL(req.url || "/", "http://127.0.0.1")
        if (
          callback.protocol !== "http:" ||
          callback.hostname !== "127.0.0.1" ||
          callback.pathname !== "/callback"
        ) {
          throw new Error("本地回调路径无效")
        }
        if (!sameSecret(callback.searchParams.get("state"), expectedState)) {
          throw new Error("授权状态校验失败")
        }
        code = callback.searchParams.get("code")
        const denied = callback.searchParams.get("error")
        if (!denied && !code) throw new Error("KunRouter 没有返回授权码")
        settled = true
        signal?.removeEventListener("abort", onAbort)
        if (denied) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          res.end("KunRouter 授权未完成，请返回 Magpie。")
          reject(new Error(denied === "access_denied" ? "已取消 KunRouter 授权" : "KunRouter 拒绝了授权"))
          return
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end(
          "<!doctype html><meta charset=\"utf-8\"><title>KunRouter</title>" +
            "<body style=\"font-family:system-ui,sans-serif;padding:2rem\">" +
            "<h1>授权完成</h1><p>可以关闭此页面并返回 Magpie。</p></body>",
        )
        resolve(code)
      } catch (error) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        res.end("KunRouter 授权回调无效。")
        if (settled) reject(error)
      }
    })
  })
}

async function startBrowserAuthorization(signal, options = {}) {
  const server = createServer()
  const authorizationOrigin = options.authorizationOrigin ?? AUTHORIZATION_ORIGIN
  const authorizationSite = SITE_OVERRIDE ? SITE : authorizationOrigin
  const lifetime = requestSignal(signal, options.timeoutMs ?? AUTHORIZATION_TIMEOUT_MS)
  try {
    if (AUTHORIZATION_ORIGIN_INVALID) {
      throw new Error(
        "KUNROUTER_AUTH_ORIGIN 必须是 https://wcnmb.fun、https://wcnmb.si 或 https://kuncode.120403.xyz",
      )
    }
    if (!PUBLIC_AUTHORIZATION_ORIGINS.includes(authorizationOrigin)) throw new Error("KunRouter 授权入口无效")
    const port = await listenLoopback(server)
    const redirectURI = `http://127.0.0.1:${port}/callback`
    const state = randomURIToken()
    const verifier = randomURIToken()
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const res = await fetch(`${authorizationSite}/api/desktop/auth/start`, {
      method: "POST",
      headers: { "content-type": "application/json", ...clientHeaders() },
      body: JSON.stringify({
        client_id: MAGPIE_CLIENT_ID,
        installation_id: stableInstallationId(),
        device_name: deviceName(),
        redirect_uri: redirectURI,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      signal: requestSignal(lifetime),
    })
    const started = await responseJSON(res)
    const authorizationURL = authorizationPageURL(
      started?.authorization_url,
      authorizationOrigin,
    )
    if (options.registration) {
      authorizationURL.searchParams.set("mode", "register")
      authorizationURL.searchParams.set("invite_code", INVITE_CODE)
    }
    const callbackPromise = waitForLoopbackCallback(server, state, lifetime)
    const closeOnAbort = () => server.close()
    lifetime.addEventListener("abort", closeOnAbort, { once: true })
    if (lifetime.aborted) closeOnAbort()
    callbackPromise.catch(() => {})
    return {
      url: authorizationURL.toString(),
      instructions: options.registration
        ? "没有账号时，浏览器会打开注册页并自动填入 Magpie 邀请码；注册并登录后会自动继续授权。"
        : "请在浏览器中登录 KunRouter 并确认授权；完成后 Magpie 会自动继续。",
      method: "auto",
      async callback() {
        try {
          const code = await callbackPromise
          const exchange = await fetch(`${authorizationSite}/api/desktop/auth/exchange`, {
            method: "POST",
            headers: { "content-type": "application/json", ...clientHeaders() },
            body: JSON.stringify({
              code,
              code_verifier: verifier,
              redirect_uri: redirectURI,
            }),
            signal: requestSignal(lifetime),
          })
          const data = await responseJSON(exchange)
          const accessToken = String(data?.access_token || "").trim()
          const apiKey = String(data?.api_key || "").trim()
          const group = String(data?.group || "").trim()
          if (!accessToken || !apiKey.startsWith("sk-")) {
            throw new Error("KunRouter 返回的凭据不完整")
          }
          const username =
            data?.user?.email ||
            data?.user?.username ||
            data?.user?.display_name ||
            undefined
          const result = {
            type: "success",
            key: apiKey,
            accountId:
              data?.user?.id != null ? String(data.user.id) : undefined,
            metadata: {
              accessToken,
              apiKey,
              mode: "browser",
              authorizationOrigin,
              username,
              group: group || undefined,
              expiresAt: Number(data?.expires_at) || undefined,
            },
          }
          await options.onAuthorized?.(result)
          return result
        } catch (error) {
          return authorizationError(error)
        } finally {
          lifetime.removeEventListener("abort", closeOnAbort)
          server.close()
        }
      },
    }
  } catch (error) {
    server.close()
    return authorizationError(error)
  }
}

// /v1/models：只有 sk- 密钥能调，访问令牌到这里是 401。
async function listModels(apiKey, base = API, signal, fallback = base === API ? SITE : null) {
  const bounded = requestSignal(signal)
  let usedBase = base
  let res
  try {
    res = await fetch(`${base}/v1/models`, { headers: authHeaders(apiKey), signal: bounded })
  } catch (error) {
    if (!fallback || bounded.aborted || base === fallback) throw error
    usedBase = fallback
    res = await fetch(`${fallback}/v1/models`, { headers: authHeaders(apiKey), signal: bounded })
  }
  return { ok: res.ok, status: res.status, res, base: usedBase }
}

// /api/user/self：余额查这里，也是校验令牌是否还有效的唯一办法。
async function fetchSelf(key, signal, site = SITE) {
  let res
  try {
    res = await fetch(`${site}/api/user/self`, {
      headers: authHeaders(key),
      signal: requestSignal(signal),
    })
  } catch (e) {
    return { error: `KunRouter 连不上：${e}` }
  }
  const body = await res.json().catch(() => null)
  if (authExpired(res.status, body)) {
    return { error: "KunRouter 说这个令牌无效或已过期", expired: true }
  }
  if (!res.ok) return { error: `KunRouter 返回 ${res.status}` }
  if (!body?.success || !body?.data) {
    const code = String(body?.code || body?.message_key || "")
    if (code.includes("ACCESS_TOKEN_LEGACY_RETIRED")) {
      return { error: "这个令牌是旧的访问令牌，站点已经退役了；模拟账号管理页 → 安全设置里重新生成一个", expired: true }
    }
    if (code.includes("AUTH_UNAUTHORIZED")) {
      return { error: "这个令牌不是访问令牌；余额要后台安全设置里生成的那种，不是 sk- 开头的 API 密钥", expired: true }
    }
    return { error: body?.message || "KunRouter 返回了读不懂的内容" }
  }
  return { user: body.data }
}

// /api/subscription/self：当前订阅、钱包/订阅计费优先级。
// /api/subscription/plans：把 plan_id 换成套餐名；即使这里失败，订阅本身仍然能显示。
async function fetchSubscriptions(accessToken, signal, site = SITE) {
  try {
    const [selfResult, plansRes] = await Promise.all([
      fetch(`${site}/api/subscription/self`, {
        headers: authHeaders(accessToken),
        signal: requestSignal(signal),
      }).then(async (res) => ({ res, body: await res.json().catch(() => null) })),
      fetch(`${site}/api/subscription/plans`, {
        headers: authHeaders(accessToken),
        signal: requestSignal(signal),
      }).then(async (res) => res.ok ? await res.json().catch(() => null) : null).catch(() => null),
    ])
    const { res: selfRes, body: selfBody } = selfResult
    if (authExpired(selfRes.status, selfBody)) {
      return { error: "KunRouter 说这个令牌无效或已过期", expired: true }
    }
    if (selfRes.status === 403) {
      return { error: "站点还没有开放 Magpie 读取订阅额度" }
    }
    if (!selfRes.ok) return { error: `订阅接口返回 ${selfRes.status}` }
    if (!selfBody?.success || !selfBody?.data) {
      return { error: selfBody?.message || "订阅接口返回了读不懂的内容" }
    }

    let plans = []
    if (Array.isArray(plansRes?.data)) plans = plansRes.data
    const data = selfBody.data
    return {
      billingPreference:
        typeof data.billing_preference === "string"
          ? data.billing_preference
          : "subscription_first",
      subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [],
      plans,
    }
  } catch (e) {
    return { error: `KunRouter 订阅接口连不上：${e}` }
  }
}

function durationLabel(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  if (value > 0 && value % 86400 === 0) return `${value / 86400} 天`
  if (value > 0 && value % 3600 === 0) return `${value / 3600} 小时`
  if (value > 0 && value % 60 === 0) return `${value / 60} 分钟`
  return `${Math.round(value)} 秒`
}

function quotaWindowLabel(seconds) {
  const value = Number(seconds)
  if (value === 86400) return "日额度"
  if (value === 604800) return "周额度"
  if (value >= 28 * 86400 && value <= 31 * 86400) return "月额度"
  return `${durationLabel(seconds)}额度`
}

function modelInfo(model, previous, base, contextFallback) {
  const id = model.id
  const levels = model.supported_reasoning_levels ?? model.reasoning_levels
  const explicit = Array.isArray(levels)
    ? [...new Set(levels.map((level) => typeof level === "string" ? level : level?.effort)
        .filter((level) => typeof level === "string" && level.length > 0))]
    : undefined
  const efforts = explicit ?? (Object.keys(previous?.variants ?? {}).length ? Object.keys(previous.variants)
    : /^gpt-(?:5|6)(?:[.-]|$)/i.test(id) ? ["low", "medium", "high", "xhigh"] : undefined)
  const reasoning = model.reasoning ?? model.capabilities?.reasoning
    ?? (efforts ? efforts.length > 0 : previous?.capabilities?.reasoning ?? false)
  const capabilities = {
    input: { text: true, ...previous?.capabilities?.input },
    output: { text: true, ...previous?.capabilities?.output },
    ...previous?.capabilities,
    ...model.capabilities,
    reasoning: !!reasoning && explicit?.length !== 0,
  }
  capabilities.toolcall = model.tool_call ?? model.capabilities?.toolcall ?? previous?.capabilities?.toolcall ?? true
  for (const kind of ["input", "output"]) {
    const kinds = model.modalities?.[kind]
    if (Array.isArray(kinds)) capabilities[kind] = Object.fromEntries(
      ["text", "image", "audio", "video", "pdf"].map((name) => [name, kinds.includes(name)]))
  }
  const positive = (...values) => {
    for (const value of values) {
      if (typeof value !== "number" && typeof value !== "string") continue
      const n = finite(value)
      if (n > 0) return n
    }
    return 0
  }
  return {
    ...previous,
    id, providerID: PROVIDER,
    name: model.display_name || model.name || previous?.name || id,
    api: { ...previous?.api, id, url: `${base}/v1`, npm: previous?.api?.npm ?? "@ai-sdk/openai-compatible" },
    limit: {
      ...previous?.limit,
      context: positive(model.limit?.context, model.context_window, model.context_length, previous?.limit?.context, contextFallback),
      output: positive(model.limit?.output, model.max_output_tokens, previous?.limit?.output, baseModel.limit.output),
    },
    headers: previous?.headers ?? {}, options: previous?.options ?? {},
    cost: previous?.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    release_date: model.release_date ?? previous?.release_date ?? "",
    status: previous?.status ?? "active",
    capabilities,
    variants: !capabilities.reasoning ? {} : efforts
      ? Object.fromEntries(efforts.map((effort) => [effort, previous?.variants?.[effort] ?? { reasoningEffort: effort }]))
      : previous?.variants ?? {},
  }
}

// 服务端尝试任意一个可用订阅，每个订阅内部的窗口才是同时约束。
// 只让当前可用的资金来源参与 Magpie 的 AND 额度判断，其余明细照常展示。
function routeWindows(wallet, subscriptions, preference, known) {
  wallet.aside = true
  for (const { windows } of subscriptions) for (const window of windows) window.aside = true
  const best = subscriptions.reduce((was, item) => {
    const used = Math.max(0, ...item.windows.map((w) => w.used))
    return !was || used < was.used ? { ...item, used } : was
  }, null)
  const useSubscription = () => {
    if (!best) return false
    for (const window of best.windows) window.aside = false
    return true
  }
  if (preference === "wallet_only") wallet.aside = false
  else if (!known) {
    // 未知订阅状态不能把钱包为零误当作整个账号耗尽。
    if (wallet.balance > 0) wallet.aside = false
  } else if (preference === "subscription_only") {
    if (!useSubscription()) return { name: "订阅", used: 100, display: "没有可用订阅" }
  } else if (preference === "wallet_first") {
    if (wallet.balance > 0 || !useSubscription()) wallet.aside = false
  } else if (best && best.used < 100) useSubscription()
  else if (!subscriptions.length || subscriptions.every((s) => s.sub.allow_wallet_overflow !== false)) wallet.aside = false
  else useSubscription()
  return null
}

// 用户在控制台删掉 Key 后，插件手里的 sk- 立刻失效，但访问令牌还在。
// 用访问令牌重签一把同名 Key，再把新凭据写回 Magpie，下一次请求就能接着用。
const RECOVERY_COOLDOWN_MS = 60 * 1000
const recoveryAttempts = new Map() // 访问令牌 -> { at, promise }

async function recoverApiKey(accessToken, group, site = SITE) {
  if (!accessToken) return null
  const cacheKey = JSON.stringify([site, accessToken])
  const cached = recoveryAttempts.get(cacheKey)
  if (cached && Date.now() - cached.at < RECOVERY_COOLDOWN_MS) {
    return cached.promise.catch(() => null)
  }
  const promise = (async () => {
    const res = await fetch(`${site}/api/desktop/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(accessToken) },
      // group 为空时站点按账号默认分组签发，和首次授权一致。
      body: JSON.stringify({ name: "Magpie", group: group || undefined }),
      signal: AbortSignal.timeout(10000),
    })
    const data = await responseJSON(res)
    const key = typeof data?.key === "string" ? data.key.trim() : ""
    if (!key.startsWith("sk-")) return null
    return { key, group: String(data?.group || ""), id: data?.id }
  })()
  recoveryAttempts.set(cacheKey, { at: Date.now(), promise })
  return promise.catch(() => null)
}

// 把新 Key 写回 Magpie 的账号；写不进去也只是一次性生效，不影响这次请求。
async function saveRecoveredAuth(client, auth, recovered) {
  if (!client?.auth?.set) return
  const metadata = { ...(auth?.metadata ?? {}) }
  metadata.apiKey = recovered.key
  if (recovered.group) metadata.group = recovered.group
  if (recovered.id != null) metadata.apiKeyId = recovered.id
  try {
    await client.auth.set({
      path: { id: PROVIDER },
      body: {
        type: "api",
        key: recovered.key,
        accountId: auth?.accountId,
        metadata,
      },
    })
  } catch {
    /* 写回失败就等下一次 401 再试 */
  }
}

export const KunRouterPlugin = async (input, settings = {}) => {
  // magpie 的选项框：plugins.json 里这一项的 options，按供应商 id 读。
  const opt = (key, fallback) => {
    const v = input?.magpie?.option?.(PROVIDER, key)
    return typeof v === "boolean" ? v : fallback
  }
  // 直连域名绕开 Cloudflare 的 100 秒上限；关掉就走主站 /v1。
  const endpoints = (auth, manual = true) => {
    const savedOrigin = normalizeAuthorizationOrigin(auth?.metadata?.authorizationOrigin ?? settings.authorization_origin ?? "")
    const origin = PUBLIC_AUTHORIZATION_ORIGINS.includes(savedOrigin) ? savedOrigin : ""
    const site = SITE_OVERRIDE || !origin ? SITE : origin
    const direct = API_OVERRIDE || !origin ? API : DIRECT_BY_ORIGIN[origin] ?? origin
    const base = manual && settings.api_base ? apiRoot(settings.api_base) : opt("direct_api", true) ? direct : site
    return { base, site, fallback: !settings.api_base && opt("direct_api", true) && base !== site ? site : null }
  }
  const apiBase = (auth) => endpoints(auth).base
  const onAuthorized = async (auth) => {
    if (!input?.magpie) return
    try {
      await publishLoginDefaults(auth.metadata.authorizationOrigin, `${endpoints(auth, false).base}/${settings.protocol === "gemini" ? "v1beta" : "v1"}`)
    } catch { /* Auth metadata still retains the selected domain if the UI sync fails. */ }
  }
  // Magpie 用 0 让目录和用户设置决定窗口；OpenCode 旧版的 0 会关闭自动压缩，保留其兼容默认值。
  const contextFallback = input?.magpie ? baseModel.limit.context : 128000
  const detectProtocols = createProtocolDetector()
  let probeRun
  const request = settings.protocol_probe
  const needsProbe = process.env.KUNROUTER_REPORT_WRITER !== "1" && request && typeof request.id === "string" && request.id.length <= 100
    && request.id !== settings.protocol_report?.id
  const runPanelProbe = (models, auth, base, error) => {
    if (!needsProbe) return Promise.resolve()
    return probeRun ??= (async () => {
      const key = apiKeyOf(auth)
      const credential = key ? createHash("sha256").update(key).digest("hex") : ""
      let report = { id: request.id, status: "error", error: "请先登录，再检测协议" }
      const support = { ...settings.protocol_support }
      try {
        if (error) throw new Error(error)
        if (!key) throw new Error(report.error)
        const id = typeof request.model === "string" ? request.model.trim() : ""
        if (id.length > 200) throw new Error("模型 ID 过长")
        const model = id ? models[id] ?? { id } : Object.values(models)[0]
        if (!model) throw new Error("请填写一个模型 ID")
        let details
        const detect = createProtocolDetector({ maxModels: 1, onResult: (result) => { details = result.results } })
        const result = await detect([model], key, base)
        const protocols = result.get(model.id) ?? []
        report = { id: request.id, status: "done", model: model.id, results: ["chat", "responses", "anthropic", "gemini"].map((protocol) => ({
          protocol, status: details?.[protocol] ?? "unknown",
        })) }
        if (protocols.length) support[model.id] = { base: apiBase(auth), credential, protocols }
        for (const old of Object.keys(support).slice(0, Math.max(0, Object.keys(support).length - 64))) delete support[old]
      } catch (e) { report.error = e.message }
      try {
        await publishProtocolReport(settings, report, support)
      } catch {
        await input?.client?.tui?.showToast?.({ body: { variant: "error", message: "检测结果未能保存，请检查 Magpie 命令是否可用" } })
      }
    })()
  }

  // 注册入口要先确认邀请码还能用，用不了就别把入口摆出来（#6）。
  // 关掉 registration_entry 开关也能隐藏它（#12）。
  const inviteState =
    Boolean(INVITE_CODE) && opt("registration_entry", true)
      ? await inviteCodeState(INVITE_CODE)
      : null
  const showInvite = Boolean(inviteState?.available)
  const inviteLabel =
    Number(inviteState?.remaining) > 0
      ? `没有账号？注册并领取鸡蛋（剩 ${inviteState.remaining} 个名额）`
      : "没有账号？注册并领取鸡蛋（仅新用户）"

  return {
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "KunRouter",
      npm: "@ai-sdk/openai-compatible",
      api: `${apiBase()}/v1`,
      endpoint: `${apiBase()}/v1`,
      website: SITE,
      keys: `${SITE}/console/token`,
      models: Object.fromEntries(
        Object.entries(DEFAULT_MODELS).map(([id, name]) => [id, {
          ...baseModel, name, limit: { ...baseModel.limit, context: contextFallback },
        }]),
      ),
    }
  },

  auth: {
    provider: PROVIDER,
    icon: ICON_URL,
    // 一台机器只留一个账号：重新登录（包括手动填 Key）覆盖原来那条，
    // 而不是另开一个 kunrouter#xxxxxx。验证码/密钥填错想重来，
    // 直接再走一遍登录即可，不用先登出。
    single: true,
    maxConcurrency: 8,
    options: [
      {
        key: "direct_api",
        label: "走直连域名",
        default: true,
      },
      {
        key: "period_window",
        label: "显示订阅额度",
        default: true,
      },
      {
        key: "registration_entry",
        label: "显示注册入口",
        default: true,
      },
    ],
    methods: [
      ...AUTHORIZATION_ORIGINS.map((origin, index) => ({
        type: "oauth",
        label: `浏览器登录${index === 0 ? "（推荐）" : ""} · ${new URL(origin).hostname}`,
        async authorize(_inputs, { signal } = {}) {
          return startBrowserAuthorization(signal, { authorizationOrigin: origin, onAuthorized })
        },
      })),
      ...(showInvite
        ? [
            {
              type: "oauth",
              label: inviteLabel,
              async authorize(_inputs, { signal } = {}) {
                return startBrowserAuthorization(signal, {
                  authorizationOrigin: AUTHORIZATION_ORIGIN,
                  onAuthorized,
                  registration: true,
                })
              },
            },
          ]
        : []),
      {
        // 手工兜底：授权服务不可用时，仍可分别填写 PAT 和 sk- 密钥。
        type: "api",
        // 插件自己收两把钥匙；关掉 magpie 额外的 API key 输入框，免得重复粘贴。
        keyless: true,
        label: "手动填写 / 更换访问令牌 + API 密钥",
        placeholder: "两把钥匙分别粘贴",
        prompts: [
          {
            type: "password",
            key: "accessToken",
            message: "访问令牌（后台「个人设置 → 安全设置」生成，用来读余额和签到）",
            placeholder: "不是 sk- 开头的那串",
            validate: (v) => (v && v.trim().length >= 8 ? undefined : "令牌太短，先确认复制全了"),
          },
          {
            type: "password",
            key: "apiKey",
            message: "API 密钥（后台「令牌」页生成，sk- 开头，用来请求模型；留空就只能看余额）",
            placeholder: "sk-…",
            validate: (v) => (!v || v.trim().startsWith("sk-") ? undefined : "API 密钥是 sk- 开头的，别把访问令牌填这儿"),
          },
        ],
        authorize: async (inputs) => {
          const token = String(inputs?.accessToken ?? "").trim()
          const apiKey = String(inputs?.apiKey ?? "").trim()
          if (!token) return { type: "failed", error: "访问令牌不能为空" }

          const self = await fetchSelf(token, undefined, endpoints().site)
          if (self.error) {
            return {
              type: "failed",
              error: `${self.error}（这一栏要的是后台安全设置生成的访问令牌，不是 sk- 开头的 API 密钥）`,
            }
          }

          // 顺手验一下 sk- 能不能列模型，省得进了列表才发现拉不到。
          if (apiKey) {
            const { base, fallback } = endpoints()
            const probe = await listModels(apiKey, base, undefined, fallback).catch(() => null)
            if (!probe) return { type: "failed", error: "API 密钥连不上 /v1/models，确认一下是不是复制全了" }
            if (!probe.ok) return { type: "failed", error: `API 密钥被拒绝（HTTP ${probe.status}）` }
          }

          const name = self.user?.email || self.user?.username || self.user?.display_name
          return {
            type: "success",
            key: token,
            accountId: self.user?.id != null ? String(self.user.id) : undefined,
            metadata: { mode: "token", username: name, apiKey: apiKey || undefined },
          }
        },
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      const client = input?.client
      const apiKey = apiKeyOf(auth)
      // 只有访问令牌、没有 sk- 密钥时，/v1 必然 401（访问令牌只能读 /api）。
      // 与其让请求打出去 401，不如当场给一句能看懂的话：这把账号只能看余额和签到。
      if (!apiKey) {
        return {
          baseURL: `${apiBase(auth)}/v1`,
          async fetch() {
            return new Response(
              JSON.stringify({
                error: {
                  type: "invalid_request_error",
                  message:
                    "这个账号只填了访问令牌，没有 sk- API 密钥，不能调用模型。请在 KunRouter 后台「令牌」新建一把 sk- 密钥，或改用浏览器授权。",
                },
              }),
              { status: 401, headers: { "content-type": "application/json" } },
            )
          },
        }
      }
      let key = apiKey
      const selected = endpoints(auth)
      return {
        baseURL: `${selected.base}/v1`,
        async fetch(input, init) {
          const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
          const replayable = !(input instanceof Request && input.body) && (
            init?.body == null || typeof init.body === "string" ||
            init.body instanceof Uint8Array || init.body instanceof ArrayBuffer)
          const send = (secret, base) => {
            // loader 已经用 apiBase 拼好完整 URL，回退时把直连域名换回主站。
            const url = input instanceof Request ? input.url : String(input)
            const target = base !== selected.base && url.startsWith(`${selected.base}/`)
              ? `${base}${url.slice(selected.base.length)}` : url
            const wire = protocolRequest(target, init?.headers ?? (input instanceof Request ? input.headers : undefined), secret)
            for (const [k, v] of Object.entries(clientHeaders())) wire.headers.set(k, v)
            return fetch(input instanceof Request ? new Request(wire.url, input) : wire.url, { ...init, headers: wire.headers })
          }
          let res
          let base = selected.base
          try {
            res = await send(key, base)
          } catch (error) {
            // 直连域名网络层挂了（DNS / 连不上）时回退一次主站，别让明明还能用的站白等。
            if (selected.fallback && replayable && !signal?.aborted && error?.name !== "AbortError") {
              base = selected.fallback
              res = await send(key, base)
            } else {
              throw error
            }
          }
          // Key 被控制台删掉后 /v1 会直接 401。访问令牌还能用就重签一把再试。
          if (res.status === 401 && !signal?.aborted) {
            const recovered = await recoverApiKey(tokenOf(auth), auth?.metadata?.group, selected.site)
            if (recovered?.key) {
              key = recovered.key
              await saveRecoveredAuth(client, auth, recovered)
              // 请求体已经被读掉（流式上传）时没法重放，留给下一次请求。
              if (replayable && !signal?.aborted) res = await send(key, base)
            }
          }
          return res
        },
      }
    },

    // 钱包余额和订阅额度分开显示，避免把订阅消耗误当成钱包扣费。
    // 只有一把钥匙时只显示能读到的那一个，不假装知道另一边的数。
    async usage(getAuth, _provider, { signal } = {}) {
      const auth = await getAuth()
      if (auth?.type !== "api") return { windows: [] }
      const token = tokenOf(auth)
      const apiKey = apiKeyOf(auth)
      if (!token && !apiKey) return { windows: [] }

      // 全部读取共享一个预算，并行开始，辅助信息不会再串行增加 10 秒。
      const bounded = requestSignal(signal)
      const site = endpoints(auth).site
      const [status, self, subscriptionData, liveGroup] = await Promise.all([
        siteStatus(bounded, site),
        token ? fetchSelf(token, bounded, site) : Promise.resolve(null),
        token ? fetchSubscriptions(token, bounded, site) : Promise.resolve(null),
        token && apiKey ? currentGroup(token, apiKey, auth.metadata?.apiKeyId, bounded, site) : Promise.resolve(""),
      ])
      const unit = status.quotaPerUnit || DEFAULT_QUOTA_PER_UNIT
      const sym = status.symbol || "$"
      // 窗口单位跟着站点币种走（本站是 🥚），别写死成美元。
      const currencyUnit = sym && sym !== "$" ? sym : "USD"
      const money = (n) => `${sym} ${n.toFixed(2)}`
      const windows = []
      const showSubscriptions = opt("period_window", true)

      // 只填了 sk- 的账号到这儿为止。
      if (!token) return { plan: "API 密钥", windows }

      if (self.error && (self.expired || subscriptionData?.error)) {
        const out = { windows }
        if (self.expired) out.signIn = "expired"
        if (!windows.length) out.error = self.error
        return out
      }

      const left = Math.max(0, finite(self.user?.quota))
      const available = left / unit
      const walletWindow = {
        name: "钱包",
        ...(!self.error ? { balance: available } : {}),
        unit: currencyUnit,
        display: self.error ? "钱包余额暂不可用" : `${sym} ${available.toFixed(2)} 可用`,
      }

      const planTitles = new Map()
      for (const item of subscriptionData?.plans || []) {
        const plan = item?.plan
        if (plan?.id != null && typeof plan.title === "string") {
          planTitles.set(Number(plan.id), plan.title)
        }
      }

      // 分组别用授权时的快照：用户可能在控制台改过 Key 的分组。读一次真实分组，读不到再退回。
      const group = liveGroup
        ? liveGroup
        : auth.metadata?.group
            ? `${auth.metadata.group}（授权时）`
            : self.user?.group ? `${self.user.group}（账号默认）` : "默认分组"

      const activeSubscriptions = (subscriptionData?.subscriptions || [])
        .map((item) => item?.subscription)
        .filter((sub) => sub?.status === "active" &&
          (sub.end_time == null || sub.end_time === 0 || (timestamp(sub.end_time) && Number(sub.end_time) * 1000 > Date.now())))
      const subscriptionWindows = []
      const subscriptionRoutes = []
      for (const sub of activeSubscriptions) {
        const ownWindows = []
        const title =
          planTitles.get(Number(sub.plan_id)) || `订阅 #${sub.plan_id || "?"}`
        const total = Math.max(0, finite(sub.amount_total))
        const used = Math.max(0, finite(sub.amount_used))
        const remaining = Math.max(0, total - used)
        const totalAmount = total / unit
        const remainingAmount = remaining / unit
        const percent = total > 0 ? (used / total) * 100 : 0
        const endsAt = timestamp(sub.end_time)
        const endHint = endsAt
          ? new Date(Number(sub.end_time) * 1000).toLocaleDateString("zh-CN")
          : ""

        // 滚动窗口套餐把额度全放在 quota_windows 里，amount_total 是 0；
        // 这时不画一条 0 / 0 的空进度条。
        if (total > 0) {
          ownWindows.push({
            name: title,
            used: percent,
            amount: used / unit,
            limit: totalAmount,
            unit: currencyUnit,
            ...(timestamp(sub.start_time) && endsAt
              ? {
                  span: Math.max(
                    0,
                    Number(sub.end_time) - Number(sub.start_time),
                  ),
                }
              : {}),
            ...(endsAt
              ? {
                  runsOutAt: endsAt,
                  runsOut: remainingAmount,
                }
              : {}),
            aside: true,
            display: `剩余 ${money(remainingAmount)} / ${money(totalAmount)}${endHint ? ` · ${endHint} 到期` : ""}`,
          })
        }

        for (const window of Array.isArray(sub.quota_windows)
          ? sub.quota_windows
          : []) {
          const windowLimit = finite(window?.quota_limit)
          const windowUsed = Math.max(0, finite(window?.used))
          if (windowLimit <= 0) continue
          const windowRemaining = Math.max(0, windowLimit - windowUsed)
          const windowPercent = (windowUsed / windowLimit) * 100
          const nextRelease = timestamp(window?.next_release_at)
          ownWindows.push({
            name:
              activeSubscriptions.length > 1
                ? `${title} · ${quotaWindowLabel(window?.window_seconds)}`
                : quotaWindowLabel(window?.window_seconds),
            used: windowPercent,
            amount: windowUsed / unit,
            limit: windowLimit / unit,
            unit: currencyUnit,
            span: Math.max(0, finite(window?.window_seconds)),
            ...(nextRelease
              ? { resetsAt: nextRelease }
              : {}),
            aside: true,
            display: `剩余 ${money(windowRemaining / unit)} / ${money(windowLimit / unit)}`,
          })
        }
        subscriptionWindows.push(...ownWindows)
        subscriptionRoutes.push({ sub, windows: ownWindows })
      }

      const unavailable = routeWindows(walletWindow, subscriptionRoutes,
        subscriptionData?.billingPreference, !subscriptionData?.error)

      const subscriptionFirst =
        subscriptionData?.billingPreference !== "wallet_first" &&
        subscriptionData?.billingPreference !== "wallet_only"
      const orderedWindows = subscriptionFirst
        ? [...subscriptionWindows, walletWindow]
        : [walletWindow, ...subscriptionWindows]

      if (showSubscriptions) windows.push(...orderedWindows)
      else {
        windows.push(walletWindow)
        const routing = subscriptionWindows.filter((window) => !window.aside)
        if (routing.length) windows.push(...routing)
      }
      if (unavailable) windows.push(unavailable)
      if (subscriptionData?.error) {
        windows.push({
          name: "订阅",
          aside: true,
          display: "订阅额度暂不可用",
        })
      }

      const subscriptionTitles = activeSubscriptions
        .map(
          (sub) =>
            planTitles.get(Number(sub.plan_id)) || `订阅 #${sub.plan_id || "?"}`,
        )
        .filter((title, index, titles) => titles.indexOf(title) === index)
      const preferenceSuffix =
        subscriptionData?.billingPreference === "wallet_first"
          ? " · 钱包优先"
          : subscriptionData?.billingPreference === "subscription_only"
            ? " · 仅订阅"
            : subscriptionData?.billingPreference === "wallet_only"
              ? " · 仅钱包"
              : ""
      const planTitle = subscriptionTitles.length
        ? subscriptionTitles.join(" / ")
        : ""
      const plan = `${planTitle ? `${planTitle} · ` : ""}${group}${preferenceSuffix}`
      const until = activeSubscriptions.reduce(
        (latest, sub) => Math.max(latest, timestamp(sub.end_time) ? Number(sub.end_time) : 0),
        0,
      )

      return {
        plan,
        user: self.user?.email || self.user?.username || undefined,
        ...(!self.error ? { balance: money(available) } : {}),
        signIn: "kept",
        ...(until ? { until: new Date(until * 1000).toISOString() } : {}),
        windows,
      }
    },

    // 站点开着每日签到（/api/status 的 checkin_enabled），顺手替账号签了。
    async checkin(getAuth, _provider, { signal } = {}) {
      const auth = await getAuth()
      const key = tokenOf(auth)
      if (!key) return { outcome: "ineligible" }

      // 先确认站点开启签到；状态读取和签到共享一次请求预算。
      const bounded = requestSignal(signal)
      const site = endpoints(auth).site
      const status = await siteStatus(bounded, site)
      if (status.checkinEnabled === false) return { outcome: "inactive", message: "站点未开启每日签到" }
      let res
      try {
        res = await fetch(`${site}/api/user/checkin`, {
          method: "POST",
          headers: { ...authHeaders(key), "content-type": "application/json" },
          body: "{}",
          signal: bounded,
        })
      } catch (e) {
        return { outcome: "failed", message: `KunRouter 连不上：${e}` }
      }

      const body = await res.json().catch(() => ({}))
      if (authExpired(res.status, body)) {
        throw Object.assign(new Error("KunRouter 说这个令牌无效或已过期"), { signIn: "expired" })
      }

      const message = typeof body?.message === "string" ? body.message : ""
      if (!res.ok || body?.success === false) {
        // 「今天已签到」是正常的 done，不是失败。
        if (/已签到|已经签到|already/i.test(message)) return { outcome: "done", message }
        return { outcome: "failed", message: message || `KunRouter 返回 ${res.status}` }
      }

      // 签到接口返回原始 quota，和钱包一样换算成站点显示的额度。
      const quota = finite(body?.data?.quota_awarded ?? body?.data?.quota)
      const credit = quota ? quota / (status.quotaPerUnit || DEFAULT_QUOTA_PER_UNIT) : 0
      return {
        outcome: "claimed",
        credit: credit || undefined,
        message: message || (body?.data?.checkin_date ? `已签到 ${body.data.checkin_date}` : "签到完成"),
      }
    },
  },

  // 每次宿主发现模型时读取当前账号的列表；失败保留宿主已有列表。
  provider: {
    id: PROVIDER,
    async models(provider, { auth, signal } = {}) {
      const selected = endpoints(auth)
      if (auth?.type !== "api") {
        await runPanelProbe({}, auth, selected.base)
        return provider.models
      }
      const key = apiKeyOf(auth)
      if (!key) {
        await runPanelProbe({}, auth, selected.base)
        return provider.models
      }
      const fallback = () => Object.defineProperty({ ...provider.models }, Symbol.for("magpie.fellBack"), { value: true })

      let list, detectionBase
      try {
        const { res, base } = await listModels(key, selected.base, signal, selected.fallback)
        detectionBase = base
        if (!res.ok) {
          await runPanelProbe({}, auth, base, `获取模型失败（${res.status}）`)
          return fallback()
        }
        const body = await res.json()
        if (!Array.isArray(body?.data)) {
          await runPanelProbe({}, auth, base, "模型列表格式无效")
          return fallback()
        }
        list = body.data
      } catch {
        if (!signal?.aborted) await runPanelProbe({}, auth, selected.base, "无法连接模型接口")
        return fallback()
      }

      const out = {}
      const credential = createHash("sha256").update(key).digest("hex")
      for (const m of list) {
        const id = typeof m?.id === "string" ? m.id : ""
        if (!id) continue
        const info = modelInfo(m, provider.models?.[id], selected.base, contextFallback)
        const saved = settings.protocol_support?.[id]
        const cached = saved?.base === selected.base && saved.credential === credential && Array.isArray(saved.protocols) ? saved.protocols : undefined
        const preferred = protocolSDK(settings.protocol)
        const protocols = cached ?? readProtocols(m) ?? (preferred ? [settings.protocol] : undefined)
        if (preferred && protocols?.includes(settings.protocol)) info.api.npm = preferred
        out[id] = protocols ? applyProtocols(info, protocols, selected.base) : info
      }
      if (!signal?.aborted) await runPanelProbe(out, auth, detectionBase)
      if (opt("detect_protocols", false)) {
        const detected = await detectProtocols(Object.values(out), key, detectionBase, signal)
        if (signal?.aborted) return fallback()
        for (const [id, protocols] of detected) out[id] = applyProtocols(out[id], protocols, selected.base)
      }
      return out
    },
  },
  }
}

// 给测试用，别从入口导出别的函数：magpie 会把每个导出函数都当插件调用。
export const _internal = {
  INVITE_CODE,
  AUTHORIZATION_ORIGINS,
  apiKeyOf,
  currentGroup,
  fetchSelf,
  fetchSubscriptions,
  authorizationPageURL,
  inviteCodeState,
  isAllowedAuthorizationURL,
  maskKey,
  recoverApiKey,
  siteStatus,
  stableInstallationId,
  startBrowserAuthorization,
  tokenOf,
  DEFAULT_MODELS,
  DEFAULT_QUOTA_PER_UNIT,
}
