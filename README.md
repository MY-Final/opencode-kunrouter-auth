# opencode-kunrouter-auth

KunRouter（[wcnmb.si](https://wcnmb.si)）的 magpie / OpenCode 供应商插件：访问令牌登录、钱包余额、每日签到。

## 装

```sh
git clone https://github.com/dian-dian233/opencode-kunrouter-auth.git
magpie plugin add ./opencode-kunrouter-auth
```

或者直接 `magpie plugin add https://github.com/dian-dian233/opencode-kunrouter-auth`。

## 登录：只能用访问令牌

KunRouter 的账号密码登录要过 Cloudflare Turnstile，脚本没法过；把密码交给插件也不是个好主意。所以插件只认后台生成的令牌：

后台 →「设置」→「访问令牌」→ 生成 → 复制，粘进 magpie 的登录框。

登录时插件会拿这个令牌请求一次 `/api/user/self`，令牌不对当场报错，不会存进来。

## 选项框

在 KunRouter 这个供应商的设置里有两个开关（跟 classifier.dev 那个插件一样的 `auth.options`）：

| 选项 | 默认 | 干什么 |
| --- | --- | --- |
| `direct_api` | 开 | 模型请求走 `direct.wcnmb.fun`，绕开 Cloudflare 的 100 秒上限；关掉就走 `wcnmb.si/v1` |
| `period_window` | 开 | 额度卡片里多显示一栏「本期配额」；关掉只看钱包 |

改完选项需要重载一下插件，`config` 钩子里的供应商地址才会跟着变。

## 显示什么

两个额度窗口，各管一边：

- **钱包**：`/api/user/self` 的 `quota`，按站点 `/api/status` 的 `quota_per_unit`（默认 500000 = 1 美元）换算，币种符号跟站点一致。只有访问令牌读得到。
- **本期配额**：new-api 在每次对话响应的 `usage.quota` 里塞了 `percent` 和 `reset_at`，插件顺手记下来，显示成「已用 38% · 某时重置」。只有 `sk-` 密钥也能看到这条。这个百分比的准确定义站点没文档，所以标成 `aside`：只看，不参与路由判断。
- **说明**：钱包那一栏下面跟一行小字，写清楚余额从哪来、按什么比例换算、本期配额为什么只是个百分比。
- **签到**：站点开着 `checkin_enabled` 时，magpie 每北京日替每个账号签一次，结果写在用量卡片上。
- **模型**：从 `/v1/models` 拉，拉不到就退回内置的三个占位模型。

## 域名为什么是两个

- `https://wcnmb.si/api` —— 控制台和管理接口（`/api/status`、`/api/user/self`、`/api/user/checkin`）
- `https://direct.wcnmb.fun/v1` —— 直连 API，实际模型请求走这里，绕开 Cloudflare 的 100 秒上限

直连域名如果哪天不通，把 `index.mjs` 里的 `API` 改成 `https://wcnmb.si` 即可，代价是长请求容易被 CF 掐断。

## 已知边界

- 只有单一 provider id `kunrouter`，多账号靠 magpie 自己的 `id#xxxxxx` 机制。
- 令牌失效时 `usage` 会带 `signIn: "expired"`，magpie 会把账号标出来让你重登。
- 模型的能力参数（上下文长度、是否支持 tool call）拿不到真实值，统一按 128k / 8k / 支持工具调用填，站点要是给了新模型自己改 `baseModel`。
