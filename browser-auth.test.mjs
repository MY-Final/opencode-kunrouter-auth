import assert from "node:assert/strict"

import { _internal } from "./index.mjs"

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

globalThis.fetch = realFetch
console.log("browser authorization tests passed")
