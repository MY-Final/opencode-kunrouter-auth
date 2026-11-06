# opencode-kunrouter-auth

KunRouter（[wcnmb.si](https://wcnmb.si)）的 magpie / OpenCode 供应商插件：浏览器一键授权、钱包余额、每日签到。

## 装

```sh
git clone https://github.com/MY-Final/opencode-kunrouter-auth.git
magpie plugin add ./opencode-kunrouter-auth
```

或者直接 `magpie plugin add https://github.com/MY-Final/opencode-kunrouter-auth`。

## 登录：浏览器一键授权

在 magpie 里选择「浏览器授权（推荐）」后，magpie 会打开 KunRouter 授权页：

1. 登录 KunRouter。
2. 选择一个模型分组；插件拿到的 `sk-` 密钥只会使用这个分组。
3. 确认 Magpie 的授权范围并完成安全验证。
4. 浏览器自动跳回本机一次性回调，magpie 接收访问令牌和模型密钥。

插件不会拿到账号密码。授权页使用 PKCE、随机 `state` 和本机 loopback 回调；令牌不会放进浏览器跳转 URL。每次重新授权都会轮换旧的 Magpie 凭据。

模型分组可以在每次浏览器授权时重新选择。重新授权会同时更换密钥和分组，不需要手动删除旧 Key。

### 控制台把 Key 删掉了

在 KunRouter 后台「令牌」里删掉 Magpie 那把 Key 之后，插件手里的 `sk-` 会立刻失效。下次请求收到 401 时，插件会用访问令牌自动重签一把同名 Key（沿用原来的分组），写回 Magpie 后重试这次请求，不需要重新授权。

这条自愈只在访问令牌还有效时成立；访问令牌也一起失效了，就只能重新走一次浏览器授权。

### 没有账号

供应商登录页会多一个「没有账号？注册并领取鸡蛋」入口。点击后直接打开 KunRouter 注册页，插件已经自动填入活动邀请码：

```text
shjglbwadfbhblqvwcpqoqbo
```

用户不需要手动输入邀请码。注册并登录后会自动返回 Magpie 授权页，选择分组并完成授权；邀请码对应的分组和注册额度由 KunRouter 后台控制。

- 入口只在邀请码**当前可用**时出现：插件加载时会查一次站点公开接口 `GET /api/invite_codes/public/:code`，码被禁用、过期或注册名额满了就自动隐藏，省得用户点进去才看到报错（网络抖动查不到时按可用处理，宁可多给一次机会）。
- 换活动不用改代码发版：用环境变量 `KUNROUTER_INVITE_CODE` 覆盖默认码，或把 `index.mjs` 里的 `INVITE_CODE` 常量留空彻底关掉这个入口。
- 也可以在供应商设置里把「显示注册入口」开关（`registration_entry`）关掉，完全不提注册。

如果浏览器授权暂时不可用，仍可选择「手动填写访问令牌 + API 密钥」作为兜底：

- 访问令牌：后台 →「个人设置」→「安全设置」→ 访问令牌。
- API 密钥：后台 →「令牌」→ 新建，复制 `sk-` 开头的密钥。

只填访问令牌、不填 API 密钥也能登录，但那样只能看余额和签到：访问令牌只能读 `/api`，调 `/v1` 一定 401，插件会直接告诉你补一把 `sk-` 密钥，而不是打出去被拒。

## 选项框

在 KunRouter 这个供应商的设置里有两个开关（跟 classifier.dev 那个插件一样的 `auth.options`）：

| 选项 | 默认 | 干什么 |
| --- | --- | --- |
| `direct_api` | 开 | 模型请求走 `direct.wcnmb.fun`，绕开 Cloudflare 的 100 秒上限；关掉就走 `wcnmb.si/v1` |
| `period_window` | 开 | 额度卡片里多显示一栏「本期配额」；关掉只看钱包 |
| `registration_entry` | 开 | 登录页显示「没有账号？注册并领取鸡蛋」；邀请码不可用时自动隐藏，关掉完全不提注册 |

改完选项需要重载一下插件，`config` 钩子里的供应商地址才会跟着变。

## 显示什么

两个额度窗口，各管一边：

- **钱包**：`/api/user/self` 的 `quota`，按站点 `/api/status` 的 `quota_per_unit`（默认 500000 = 1 美元）换算，币种符号跟站点一致。浏览器授权后直接可用。
- **本期配额**：new-api 在每次对话响应的 `usage.quota` 里塞了 `percent` 和 `reset_at`，插件顺手记下来，显示成「已用 38% · 某时重置」。流式（SSE）和非流式都会解析，只有 `sk-` 密钥也能看到这条。这个百分比的准确定义站点没文档，所以标成 `aside`：只看，不参与路由判断。
- **说明**：钱包那一栏下面跟一行小字，写清楚余额从哪来、按什么比例换算、本期配额为什么只是个百分比。
- **签到**：站点开着 `checkin_enabled` 时，magpie 每北京日替每个账号签一次，结果写在用量卡片上。
- **分组**：额度卡上的分组会带访问令牌去 `/api/desktop/keys` 读当前真实分组（按 Key 遮罩匹配），你在控制台改过分组也能显示最新值；读不到才退回授权时的快照并标注「授权时」。
- **模型**：从 `/v1/models` 拉，按授权时选择的模型分组返回；拉不到就退回内置的三个占位模型。

站点相关的 `/api` 请求都带 10 秒超时，网络卡住时不会把额度卡和签到一起拖死。

## 域名为什么是两个

- `https://wcnmb.si/api` —— 控制台和管理接口（`/api/status`、`/api/user/self`、`/api/user/checkin`）
- `https://kuncode.120403.xyz/desktop/authorize` —— 浏览器授权页，由站点 `/api/desktop/auth/start` 返回
- `https://direct.wcnmb.fun/v1` —— 直连 API，实际模型请求走这里，绕开 Cloudflare 的 100 秒上限

`direct_api` 打开时模型请求走直连域名；如果直连域名出现网络层错误（DNS、连不上），插件会自动回退一次主站 `wcnmb.si/v1`，不会让明明还能用的站干等。想彻底固定走主站，可以把 `index.mjs` 里的 `API` 改成 `https://wcnmb.si`，代价是长请求容易被 CF 掐断。

授权域名和 API 域名分开部署时，插件接受 `wcnmb.si`、`wcnmb.fun`、`kuncode.120403.xyz` 及其子域，也接受 `KUNROUTER_AUTH_ORIGIN` 指定的域名，避免把授权码发送到任意地址。

## 本地联调

插件默认连正式站。需要连本地服务时，对加载插件的 magpie 命令临时覆盖两个地址：

```sh
KUNROUTER_SITE=http://localhost:3000 \
KUNROUTER_API=http://localhost:3000 \
magpie plugin login kunrouter
```

本地后端要把 `ServerAddress` 设成同一个 `http://localhost:3000`，否则授权回调会回到正式域名。`magpie quota kunrouter` 也要带同样的环境变量，才会读取本地钱包。

## 已知边界

- 只有单一 provider id `kunrouter`，多账号靠 magpie 自己的 `id#xxxxxx` 机制。
- 浏览器授权签发的访问令牌和模型密钥默认 30 天有效；重新授权会轮换两把凭据，并可按新的分组重新签发。
- 令牌失效时 `usage` 会带 `signIn: "expired"`，magpie 会把账号标出来让你重登。
- 模型的能力参数（上下文长度、是否支持 tool call）拿不到真实值，统一按 128k / 8k / 支持工具调用填，站点要是给了新模型自己改 `baseModel`。
