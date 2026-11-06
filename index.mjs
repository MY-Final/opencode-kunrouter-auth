// KunRouter (wcnmb.si) provider plugin for OpenCode / magpie.
//
// KunRouter 跑的是 new-api（one-api 的分支）。它的账号密码登录要走 Cloudflare
// Turnstile，脚本过不去，所以插件只认后台生成的「访问令牌」（Bearer）。
// 余额和签到走站点侧的 /api，模型请求走直连域名，绕开 Cloudflare 的 100 秒上限。

const PROVIDER = "kunrouter"
const SITE = "https://wcnmb.si" // 控制台 + /api
const API = "https://direct.wcnmb.fun" // 直连 /v1，不受 CF 超时限制
const VERSION = "0.1.0"

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
  return typeof auth?.key === "string" ? auth.key.trim() : ""
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

export const KunRouterPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "KunRouter",
      npm: "@ai-sdk/openai-compatible",
      api: `${API}/v1`,
      endpoint: `${API}/v1`,
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
    methods: [
      {
        // 唯一可行的自动化登录：后台「设置 → 访问令牌」生成的 PAT。
        // 密码登录要过 Turnstile，插件里做不了，也不该要用户把密码交出来。
        type: "api",
        label: "访问令牌",
        placeholder: "在 KunRouter 后台「设置 → 访问令牌」生成",
        prompts: [
          {
            type: "password",
            key: "token",
            message: "KunRouter 访问令牌",
            placeholder: "粘贴令牌，形如 32 位以上字符串",
            validate: (v) => (v && v.trim().length >= 8 ? undefined : "令牌太短，先确认复制全了"),
          },
        ],
        authorize: async (inputs) => {
          const token = String(inputs?.token ?? "").trim()
          if (!token) return { type: "failed", error: "令牌不能为空" }
          const self = await fetchSelf(token)
          if (self.error) return { type: "failed", error: self.error }
          const name = self.user?.email || self.user?.username || self.user?.display_name
          return {
            type: "success",
            key: token,
            accountId: self.user?.id != null ? String(self.user.id) : undefined,
            metadata: { mode: "token", username: name },
          }
        },
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      const key = tokenOf(auth)
      return {
        baseURL: `${API}/v1`,
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

    // 钱包是预付制：报剩余额度，不写 used/limit，magpie 会当余额窗口显示。
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return { windows: [] }
      const key = tokenOf(auth)
      if (!key) return { windows: [] }

      const self = await fetchSelf(key)
      if (self.error) {
        // 只填了 sk- API 密钥的账号查不到钱包，但每次对话响应里带本期百分比，
        // 有这条就先拿它顶着，免得额度卡片一片空白。
        const seen = lastQuota.get(key)
        if (seen) {
          const resetHint = seen.resetAt
            ? new Date(seen.resetAt * 1000).toLocaleString("zh-CN", { hour12: false })
            : ""
          return {
            plan: "API 密钥",
            windows: [
              {
                name: "本期配额",
                ...(seen.resetAt ? { resetsAt: new Date(seen.resetAt * 1000).toISOString() } : {}),
                display: `本期配额 ${seen.percent}%${resetHint ? ` · ${resetHint} 重置` : ""} · 钱包余额需访问令牌`,
              },
            ],
          }
        }
        const out = { error: self.error, windows: [] }
        if (self.expired) out.signIn = "expired"
        return out
      }

      const status = await siteStatus()
      const unit = status.quotaPerUnit || DEFAULT_QUOTA_PER_UNIT
      const sym = status.symbol || "$"
      const left = Number(self.user?.quota) || 0
      const used = Number(self.user?.used_quota) || 0
      const available = left / unit
      const spent = used / unit
      const money = (n) => `$${n.toFixed(2)}`

      return {
        plan: self.user?.group || "默认分组",
        user: self.user?.email || self.user?.username || undefined,
        balance: money(available),
        windows: [
          {
            name: "钱包",
            balance: available,
            unit: "USD",
            display: `${sym} ${available.toFixed(2)} 可用 · 已用 ${money(spent)}`,
          },
        ],
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
      const key = tokenOf(auth)
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
})

// 给测试用，别从入口导出别的函数：magpie 会把每个导出函数都当插件调用。
export const _internal = { fetchSelf, siteStatus, DEFAULT_MODELS, DEFAULT_QUOTA_PER_UNIT }
