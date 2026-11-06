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
const VERSION = "0.3.0"
const MAGPIE_CLIENT_ID = "magpie"

// new-api 的默认换算：500000 quota = 1 美元，站点 /api/status 会覆盖。
const DEFAULT_QUOTA_PER_UNIT = 500000
const STATUS_TTL_MS = 10 * 60 * 1000

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

async function siteStatus() {
  const now = Date.now()
  if (statusCache.value && now - statusCache.at < STATUS_TTL_MS) return statusCache.value
  try {
    const res = await fetch(`${SITE}/api/status`, { headers: clientHeaders() })
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

async function startBrowserAuthorization(signal) {
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
    const authorizationURL = new URL(String(started?.authorization_url || ""))
    if (
      !["https:", "http:"].includes(authorizationURL.protocol) ||
      authorizationURL.origin !== new URL(SITE).origin
    ) {
      throw new Error("KunRouter 返回了无效的授权地址")
    }
    const callbackPromise = waitForLoopbackCallback(server, state, signal)
    const closeOnAbort = () => server.close()
    signal?.addEventListener("abort", closeOnAbort, { once: true })
    callbackPromise.catch(() => {})
    return {
      url: authorizationURL.toString(),
      instructions: "请在浏览器中登录 KunRouter 并确认授权；完成后 Magpie 会自动继续。",
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
  const res = await fetch(`${API}/v1/models`, { headers: authHeaders(apiKey) })
  return { ok: res.ok, status: res.status, res }
}

// /api/user/self：余额查这里，也是校验令牌是否还有效的唯一办法。
async function fetchSelf(key) {
  let res
  try {
    res = await fetch(`${SITE}/api/user/self`, { headers: authHeaders(key) })
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

export const KunRouterPlugin = async (input) => {
  // magpie 的选项框：plugins.json 里这一项的 options，按供应商 id 读。
  const opt = (key, fallback) => {
    const v = input?.magpie?.option?.(PROVIDER, key)
    return typeof v === "boolean" ? v : fallback
  }
  // 直连域名绕开 Cloudflare 的 100 秒上限；关掉就走主站 /v1。
  const apiBase = () => (opt("direct_api", true) ? API : SITE)

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
    ],
    methods: [
      {
        type: "oauth",
        label: "浏览器授权（推荐）",
        async authorize(_inputs, { signal } = {}) {
          return startBrowserAuthorization(signal)
        },
      },
      {
        // 手工兜底：授权服务不可用时，仍可分别填写 PAT 和 sk- 密钥。
        type: "api",
        label: "手动填写访问令牌 + API 密钥",
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
      const key = apiKeyOf(auth) || tokenOf(auth)
      return {
        baseURL: `${apiBase()}/v1`,
        async fetch(input, init) {
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${key}`)
          for (const [k, v] of Object.entries(clientHeaders())) headers.set(k, v)
          const res = await fetch(input, { ...init, headers })
          // 顺手记一下额度：new-api 把本期百分比放在 usage.quota 里，
          // 只解析 JSON 响应，流式的不碰，失败就算了。
          try {
            const ct = res.headers.get("content-type") || ""
            if (ct.includes("application/json")) {
              res
                .clone()
                .json()
                .then((body) => rememberQuota(key, body?.usage?.quota))
                .catch(() => {})
            }
          } catch {
            /* 记不上不影响请求本身 */
          }
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
        unit: "USD",
        display: `${sym} ${available.toFixed(2)} 可用 · 已用 ${money(spent / unit)}`,
      })

      // 一行说明，省得对着两个窗口猜哪个是钱、哪个是百分比。
      windows.push({
        name: "说明",
        aside: true,
        display: `余额取自 /api/user/self，按 ${unit} quota 兑 1 美元；本期配额是最近一次对话时站点回报的百分比`,
      })

      return {
        plan: auth.metadata?.group || self.user?.group || "默认分组",
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
        const res = await fetch(`${API}/v1/models`, { headers: authHeaders(key) })
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
  apiKeyOf,
  fetchSelf,
  siteStatus,
  stableInstallationId,
  startBrowserAuthorization,
  tokenOf,
  DEFAULT_MODELS,
  DEFAULT_QUOTA_PER_UNIT,
}
