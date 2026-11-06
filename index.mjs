// KunRouter (wcnmb.si) provider plugin for OpenCode / magpie.
//
// KunRouter 跑的是 new-api（one-api 的分支）。账号密码登录走浏览器授权，
// 访问令牌留在 metadata，模型请求使用站点为该插件单独签发的 sk- 密钥。
// 余额和签到走站点侧的 /api，模型请求走直连域名，绕开 Cloudflare 的 100 秒上限。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { homedir, hostname } from "node:os"

const PROVIDER = "kunrouter"
const SITE =
  process.env.KUNROUTER_SITE?.replace(/\/+$/, "") || "https://wcnmb.si" // 控制台 + /api
const API =
  process.env.KUNROUTER_API?.replace(/\/+$/, "") ||
  "https://direct.wcnmb.fun" // 直连 /v1，不受 CF 超时限制
const VERSION = "0.7.0"
const MAGPIE_CLIENT_ID = "magpie"
// 活动邀请码。改活动时优先用环境变量覆盖，不用改代码发版。
const INVITE_CODE = (
  process.env.KUNROUTER_INVITE_CODE ?? "shjglbwadfbhblqvwcpqoqbo"
).trim()
const AUTHORIZATION_ORIGIN =
  process.env.KUNROUTER_AUTH_ORIGIN?.replace(/\/+$/, "") ||
  "https://kuncode.120403.xyz"
const TRUSTED_AUTHORIZATION_DOMAINS = [
  "wcnmb.si",
  "wcnmb.fun",
  "kuncode.120403.xyz",
  new URL(SITE).hostname,
  new URL(API).hostname,
  new URL(AUTHORIZATION_ORIGIN).hostname,
]

// new-api 的默认换算：500000 quota = 1 美元，站点 /api/status 会覆盖。
const DEFAULT_QUOTA_PER_UNIT = 500000
const STATUS_TTL_MS = 10 * 60 * 1000
// 站点 /api 请求统一超时，免得网络卡住时额度卡和签到一起挂死。
const REQUEST_TIMEOUT_MS = 10000
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
  limit: { context: 128000, output: 8192 },
  tool_call: true,
}

// 站点级配置（币种符号、quota 换算）不属于任何账号，缓存这里是安全的。
let statusCache = { at: 0, value: null }
// 邀请码是否还能用，也做短缓存，避免每次加载插件都打一次站点的脸。
let inviteCache = { code: "", at: 0, value: null }

// new-api 在每次 chat 响应的 usage.quota 里塞了本期百分比和重置时间。
// 没有访问令牌时，这条就是唯一能看到的额度信息，按令牌分开存，只留最近一条。
const lastQuota = new Map()

function rememberQuota(token, quota) {
  const percent = Number(quota?.percent)
  if (!token || !Number.isFinite(percent)) return
  lastQuota.set(token, {
    percent,
    resetAt: Number(quota?.reset_at) || 0,
    at: Date.now(),
  })
}

// 站点把本期用量百分比塞在响应体的 usage.quota 里。非流式好办，
// 流式（SSE）要扫最后一个 data: 事件，否则额度卡片永远看不到这一栏。
function captureQuota(res, key) {
  try {
    const ct = res.headers.get("content-type") || ""
    if (ct.includes("application/json")) {
      return res
        .clone()
        .json()
        .then((body) => rememberQuota(key, body?.usage?.quota))
        .catch(() => {})
    }
    if (ct.includes("text/event-stream")) {
      return res
        .clone()
        .text()
        .then((text) => {
          let quota
          for (const line of text.split("\n")) {
            const trimmed = line.trim()
            if (!trimmed.startsWith("data:")) continue
            const payload = trimmed.slice(5).trim()
            if (!payload || payload === "[DONE]") continue
            try {
              const event = JSON.parse(payload)
              if (event?.usage?.quota) quota = event.usage.quota
            } catch {
              /* 非法 JSON 的中间事件跳过 */
            }
          }
          if (quota) rememberQuota(key, quota)
        })
        .catch(() => {})
    }
  } catch {
    /* 记不上不影响请求本身 */
  }
  return Promise.resolve()
}

async function siteStatus() {
  const now = Date.now()
  if (statusCache.value && now - statusCache.at < STATUS_TTL_MS) return statusCache.value
  try {
    const res = await fetch(`${SITE}/api/status`, {
      headers: clientHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return statusCache.value ?? {}
    const data = (await res.json())?.data ?? {}
    const value = {
      quotaPerUnit: Number(data.quota_per_unit) || DEFAULT_QUOTA_PER_UNIT,
      symbol: typeof data.custom_currency_symbol === "string" && data.custom_currency_symbol
        ? data.custom_currency_symbol
        : "$",
      name: data.system_name || "KunRouter",
    }
    statusCache = { at: now, value }
    return value
  } catch {
    return statusCache.value ?? {}
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
async function currentGroup(accessToken, apiKey) {
  if (!accessToken) return ""
  try {
    const res = await fetch(`${SITE}/api/desktop/keys?p=1&page_size=100`, {
      headers: authHeaders(accessToken),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return ""
    const body = await res.json().catch(() => null)
    const items = body?.data?.items
    if (!Array.isArray(items) || items.length === 0) return ""
    const masked = maskKey(apiKey)
    const match =
      (masked && items.find((item) => item?.masked_key === masked)) ||
      (items.length === 1 ? items[0] : null)
    return typeof match?.group === "string" ? match.group : ""
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

function isAllowedAuthorizationURL(value) {
  try {
    const url = new URL(String(value || ""))
    const localHTTP =
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    const trustedHost = TRUSTED_AUTHORIZATION_DOMAINS.some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
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
    const onAbort = () => finish(reject, new Error("浏览器授权已取消"))
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
  try {
    const port = await listenLoopback(server)
    const redirectURI = `http://127.0.0.1:${port}/callback`
    const state = randomURIToken()
    const verifier = randomURIToken()
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const res = await fetch(`${SITE}/api/desktop/auth/start`, {
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
      signal,
    })
    const started = await responseJSON(res)
    if (!isAllowedAuthorizationURL(started?.authorization_url)) {
      throw new Error("KunRouter 返回了无效的授权地址")
    }
    const authorizationURL = new URL(started.authorization_url)
    if (options.registration) {
      authorizationURL.searchParams.set("mode", "register")
      authorizationURL.searchParams.set("invite_code", INVITE_CODE)
    }
    const callbackPromise = waitForLoopbackCallback(server, state, signal)
    const closeOnAbort = () => server.close()
    signal?.addEventListener("abort", closeOnAbort, { once: true })
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
          const exchange = await fetch(`${SITE}/api/desktop/auth/exchange`, {
            method: "POST",
            headers: { "content-type": "application/json", ...clientHeaders() },
            body: JSON.stringify({
              code,
              code_verifier: verifier,
              redirect_uri: redirectURI,
            }),
            signal,
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
          return {
            type: "success",
            key: apiKey,
            accountId:
              data?.user?.id != null ? String(data.user.id) : undefined,
            metadata: {
              accessToken,
              apiKey,
              mode: "browser",
              username,
              group: group || undefined,
              expiresAt: Number(data?.expires_at) || undefined,
            },
          }
        } catch (error) {
          return authorizationError(error)
        } finally {
          signal?.removeEventListener("abort", closeOnAbort)
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
async function listModels(apiKey) {
  const res = await fetch(`${API}/v1/models`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { ok: res.ok, status: res.status, res }
}

// /api/user/self：余额查这里，也是校验令牌是否还有效的唯一办法。
async function fetchSelf(key) {
  let res
  try {
    res = await fetch(`${SITE}/api/user/self`, {
      headers: authHeaders(key),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    return { error: `KunRouter 连不上：${e}` }
  }
  if (res.status === 401 || res.status === 403) {
    return { error: "KunRouter 说这个令牌无效或已过期", expired: true }
  }
  if (!res.ok) return { error: `KunRouter 返回 ${res.status}` }
  const body = await res.json().catch(() => null)
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

// 用户在控制台删掉 Key 后，插件手里的 sk- 立刻失效，但访问令牌还在。
// 用访问令牌重签一把同名 Key，再把新凭据写回 Magpie，下一次请求就能接着用。
const RECOVERY_COOLDOWN_MS = 60 * 1000
const recoveryAttempts = new Map() // 访问令牌 -> { at, promise }

async function recoverApiKey(accessToken, group) {
  if (!accessToken) return null
  const cached = recoveryAttempts.get(accessToken)
  if (cached && Date.now() - cached.at < RECOVERY_COOLDOWN_MS) {
    return cached.promise.catch(() => null)
  }
  const promise = (async () => {
    const res = await fetch(`${SITE}/api/desktop/keys`, {
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
  recoveryAttempts.set(accessToken, { at: Date.now(), promise })
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

export const KunRouterPlugin = async (input) => {
  // magpie 的选项框：plugins.json 里这一项的 options，按供应商 id 读。
  const opt = (key, fallback) => {
    const v = input?.magpie?.option?.(PROVIDER, key)
    return typeof v === "boolean" ? v : fallback
  }
  // 直连域名绕开 Cloudflare 的 100 秒上限；关掉就走主站 /v1。
  const apiBase = () => (opt("direct_api", true) ? API : SITE)

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
        Object.entries(DEFAULT_MODELS).map(([id, name]) => [id, { ...baseModel, name }]),
      ),
    }
  },

  auth: {
    provider: PROVIDER,
    // 一台机器只留一个账号：重新登录（包括手动填 Key）覆盖原来那条，
    // 而不是另开一个 kunrouter#xxxxxx。验证码/密钥填错想重来，
    // 直接再走一遍登录即可，不用先登出。
    single: true,
    maxConcurrency: 8,
    options: [
      {
        key: "direct_api",
        label: "走直连域名",
        description:
          "开（默认）：模型请求打到 direct.wcnmb.fun，绕开 Cloudflare 的 100 秒上限，长任务不容易被掐。关掉就走 wcnmb.si/v1，连通性更保险但流式长请求可能断。",
        default: true,
      },
      {
        key: "period_window",
        label: "显示本期配额",
        description:
          "开（默认）：把最近一次对话里站点回报的用量百分比单独显示一栏。关掉就只看钱包余额。",
        default: true,
      },
      {
        key: "registration_entry",
        label: "显示注册入口",
        description:
          "开（默认）：登录页显示「没有账号？注册并领取鸡蛋」，邀请码不可用（禁用 / 过期 / 名额满）时自动隐藏。关掉就完全不提注册。",
        default: true,
      },
    ],
    methods: [
      {
        type: "oauth",
        label: "浏览器授权（推荐）",
        async authorize(_inputs, { signal } = {}) {
          return startBrowserAuthorization(signal)
        },
      },
      ...(showInvite
        ? [
            {
              type: "oauth",
              label: inviteLabel,
              async authorize(_inputs, { signal } = {}) {
                return startBrowserAuthorization(signal, { registration: true })
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

          const self = await fetchSelf(token)
          if (self.error) {
            return {
              type: "failed",
              error: `${self.error}（这一栏要的是后台安全设置生成的访问令牌，不是 sk- 开头的 API 密钥）`,
            }
          }

          // 顺手验一下 sk- 能不能列模型，省得进了列表才发现拉不到。
          if (apiKey) {
            const probe = await listModels(apiKey).catch(() => null)
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
          baseURL: `${apiBase()}/v1`,
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
      return {
        baseURL: `${apiBase()}/v1`,
        async fetch(input, init) {
          const send = (secret, base) => {
            const headers = new Headers(init?.headers)
            headers.set("authorization", `Bearer ${secret}`)
            for (const [k, v] of Object.entries(clientHeaders())) headers.set(k, v)
            // loader 已经用 apiBase 拼好完整 URL，回退时把直连域名换回主站。
            const target =
              base === SITE && typeof input === "string" && input.startsWith(API)
                ? `${SITE}${input.slice(API.length)}`
                : input
            return fetch(target, { ...init, headers })
          }
          let res
          try {
            res = await send(key, apiBase())
          } catch (error) {
            // 直连域名网络层挂了（DNS / 连不上）时回退一次主站，别让明明还能用的站白等。
            const replayable =
              init?.body == null ||
              typeof init.body === "string" ||
              init.body instanceof Uint8Array ||
              init.body instanceof ArrayBuffer
            if (apiBase() === API && replayable) {
              res = await send(key, SITE)
            } else {
              throw error
            }
          }
          // Key 被控制台删掉后 /v1 会直接 401。访问令牌还能用就重签一把再试。
          if (res.status === 401) {
            const recovered = await recoverApiKey(tokenOf(auth), auth?.metadata?.group)
            if (recovered?.key) {
              key = recovered.key
              await saveRecoveredAuth(client, auth, recovered)
              // 请求体已经被读掉（流式上传）时没法重放，留给下一次请求。
              const replayable =
                init?.body == null ||
                typeof init.body === "string" ||
                init.body instanceof Uint8Array ||
                init.body instanceof ArrayBuffer
              if (replayable) res = await send(key, apiBase())
            }
          }
          // 顺手记一下额度：new-api 把本期百分比放在 usage.quota 里，JSON 和 SSE 都解析。
          captureQuota(res, key)
          return res
        },
      }
    },

    // 两个窗口：钱包余额（访问令牌读得到）+ 本期配额（对话响应里带的百分比）。
    // 只有一把钥匙时只显示能读到的那一个，不假装知道另一边的数。
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return { windows: [] }
      const token = tokenOf(auth)
      const apiKey = apiKeyOf(auth)
      if (!token && !apiKey) return { windows: [] }

      const status = await siteStatus()
      const unit = status.quotaPerUnit || DEFAULT_QUOTA_PER_UNIT
      const sym = status.symbol || "$"
      // 窗口单位跟着站点币种走（本站是 🥚），别写死成美元。
      const currencyUnit = sym && sym !== "$" ? sym : "USD"
      const money = (n) => `${sym} ${n.toFixed(2)}`
      const windows = []

      // 本期配额：new-api 把 percent 和 reset_at 塞在每次对话响应里，
      // 记在 sk- 密钥名下，所以拿 apiKeyOf 去查（不是访问令牌）。
      const seen = opt("period_window", true) ? lastQuota.get(apiKey || token) : undefined
      if (seen) {
        const resetHint = seen.resetAt
          ? new Date(seen.resetAt * 1000).toLocaleString("zh-CN", { hour12: false })
          : ""
        windows.push({
          name: "本期配额",
          used: seen.percent,
          ...(seen.resetAt ? { resetsAt: new Date(seen.resetAt * 1000).toISOString() } : {}),
          // 这个百分比的准确定义还没核实（可能随时重置），先按只读处理：
          // 显示出来，但不让路由拿它判断账号能不能用。
          aside: true,
          display: `已用 ${seen.percent}%${resetHint ? ` · ${resetHint} 重置` : ""}`,
        })
      }

      // 只填了 sk- 的账号到这儿为止。
      if (!token) return { plan: "API 密钥", windows }

      const self = await fetchSelf(token)
      if (self.error) {
        const out = { windows }
        if (self.expired) out.signIn = "expired"
        if (!windows.length) out.error = self.error
        return out
      }

      const left = Number(self.user?.quota) || 0
      const spent = Number(self.user?.used_quota) || 0
      const available = left / unit
      windows.unshift({
        name: "钱包",
        balance: available,
        unit: currencyUnit,
        display: `${sym} ${available.toFixed(2)} 可用 · 已用 ${money(spent / unit)}`,
      })

      // 一行说明，省得对着两个窗口猜哪个是钱、哪个是百分比。
      windows.push({
        name: "说明",
        aside: true,
        display: `余额取自 /api/user/self，按 ${unit} quota 兑 1 个 ${sym}；本期配额是最近一次对话时站点回报的百分比`,
      })

      // 分组别用授权时的快照：用户可能在控制台改过 Key 的分组。读一次真实分组，读不到再退回。
      const liveGroup = apiKey ? await currentGroup(token, apiKey) : ""
      const plan = liveGroup
        ? liveGroup
        : self.user?.group
          ? self.user.group
          : auth.metadata?.group
            ? `${auth.metadata.group}（授权时）`
            : "默认分组"

      return {
        plan,
        user: self.user?.email || self.user?.username || undefined,
        balance: money(available),
        windows,
      }
    },

    // 站点开着每日签到（/api/status 的 checkin_enabled），顺手替账号签了。
    async checkin(getAuth) {
      const auth = await getAuth()
      const key = tokenOf(auth)
      if (!key) return { outcome: "ineligible" }

      let res
      try {
        res = await fetch(`${SITE}/api/user/checkin`, {
          method: "POST",
          headers: { ...authHeaders(key), "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (e) {
        return { outcome: "failed", message: `KunRouter 连不上：${e}` }
      }

      if (res.status === 401 || res.status === 403) {
        throw Object.assign(new Error("KunRouter 说这个令牌无效或已过期"), { signIn: "expired" })
      }

      const body = await res.json().catch(() => ({}))
      const message = typeof body?.message === "string" ? body.message : ""
      if (!res.ok || body?.success === false) {
        // 「今天已签到」是正常的 done，不是失败。
        if (/已签到|已经签到|already/i.test(message)) return { outcome: "done", message }
        return { outcome: "failed", message: message || `KunRouter 返回 ${res.status}` }
      }

      const credit = Number(body?.data?.quota_awarded ?? body?.data?.quota ?? 0) || 0
      return {
        outcome: "claimed",
        credit: credit || undefined,
        message: message || (body?.data?.checkin_date ? `已签到 ${body.data.checkin_date}` : "签到完成"),
      }
    },
  },

  // 站点的模型列表是公开的（要 key），拉一次就够了，拉不到就保留上一份。
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (auth?.type !== "api") return provider.models
      const key = apiKeyOf(auth)
      if (!key) return provider.models

      let list
      try {
        const res = await fetch(`${API}/v1/models`, {
          headers: authHeaders(key),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!res.ok) return provider.models
        const body = await res.json()
        list = Array.isArray(body?.data) ? body.data : []
      } catch {
        return provider.models
      }

      const out = {}
      for (const m of list) {
        const id = typeof m?.id === "string" ? m.id : ""
        if (!id) continue
        out[id] = { ...baseModel, name: id }
      }
      return Object.keys(out).length ? out : provider.models
    },
  },
  }
}

// 给测试用，别从入口导出别的函数：magpie 会把每个导出函数都当插件调用。
export const _internal = {
  INVITE_CODE,
  apiKeyOf,
  captureQuota,
  currentGroup,
  fetchSelf,
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
