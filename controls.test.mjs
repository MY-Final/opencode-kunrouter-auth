import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apiRoot, publishLoginDefaults, publishProtocolReport } from "./controls.mjs"
import { KunRouterPlugin } from "./index.mjs"

test("Base URL accepts both API versions and rejects embedded credentials or query auth", () => {
  for (const url of ["https://relay.example/v1/", "https://relay.example/v1beta", "https://relay.example/"]) {
    assert.equal(apiRoot(url), "https://relay.example")
  }
  assert.equal(apiRoot("http://127.0.0.1:1234/proxy/v1"), "http://127.0.0.1:1234/proxy")
  for (const url of ["file:///secret", "https://user:password@relay.example/v1", "https://relay.example/v1?key=secret", "https://relay.example/#key", "invalid"]) {
    assert.throws(() => apiRoot(url))
  }
})

test("reports use the native options command with structured arguments and preserve settings", async () => {
  let call
  const settings = { api_base: "https://relay.example/v1", protocol: "responses", keep: "unchanged", protocol_probe: { id: "request" } }
  const report = { id: "request", status: "done", model: "model $(literal)", results: [] }
  await publishProtocolReport(settings, report, {}, async (...args) => {
    call = args
    return { stdout: JSON.stringify(settings) }
  })
  assert.deepEqual(call[1].slice(0, 3), ["plugin", "options", "kunrouter"])
  const saved = JSON.parse(call[1][3])
  assert.equal(saved.keep, "unchanged")
  assert.deepEqual(saved.protocol_report, report)
  assert.equal(call[2].windowsHide, true)
  assert.equal(call[2].shell, undefined)
  assert.equal(call[2].env.KUNROUTER_REPORT_WRITER, "1")
})

test("an old detection cannot overwrite a newer request or connection", async () => {
  const settings = { api_base: "https://first.example/v1", protocol_probe: { id: "old" } }
  for (const current of [{ ...settings, protocol_probe: { id: "new" } }, { ...settings, api_base: "https://second.example/v1" }, { ...settings, authorization_origin: "https://wcnmb.si" }]) {
    let calls = 0
    const saved = await publishProtocolReport(settings, { id: "old" }, {}, async () => {
      calls++
      return { stdout: `switches on\n${JSON.stringify(current)}` }
    })
    assert.equal(saved, false)
    assert.equal(calls, 1)
  }
})

test("login synchronizes the displayed default without replacing a manual Base URL", async () => {
  const current = { api_base: "https://custom.example/v1", keep: true }
  let saved
  await publishLoginDefaults("https://wcnmb.si", "https://direct.wcnmb.si/v1", async (_bin, args) => {
    if (args.length === 3) return { stdout: JSON.stringify(current) }
    saved = JSON.parse(args[3])
    return { stdout: "ok" }
  })
  assert.equal(saved.api_base, current.api_base)
  assert.equal(saved.default_api_base, "https://direct.wcnmb.si/v1")
  assert.equal(saved.authorization_origin, "https://wcnmb.si")
  assert.equal(saved.keep, true)
})

test("panel detection publishes a visible result once and persists native routing without credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kunrouter-panel-"))
  const cwd = process.cwd()
  const oldBin = process.env.KUNROUTER_MAGPIE_BIN
  const oldOut = process.env.KUNROUTER_TEST_REPORT
  const realFetch = globalThis.fetch
  const output = join(dir, "result.json")
  try {
    // This temporary CLI records arguments; no real Magpie settings are changed.
    await writeFile(join(dir, "plugin"), 'const fs=require("node:fs"); if(process.argv[4]) fs.writeFileSync(process.env.KUNROUTER_TEST_REPORT,process.argv[4]); else console.log(fs.readFileSync(process.env.KUNROUTER_TEST_REPORT,"utf8"))')
    process.chdir(dir)
    process.env.KUNROUTER_MAGPIE_BIN = process.execPath
    process.env.KUNROUTER_TEST_REPORT = output
    const settings = { api_base: "https://relay.example/v1", protocol: "responses", protocol_probe: { id: "once", model: "native" } }
    await writeFile(output, JSON.stringify(settings))
    const input = { magpie: { option: (_, key) => key === "direct_api" } }
    let generations = 0
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/v1/models")) return Response.json({ data: [{ id: "native" }] })
      generations++
      return String(url).endsWith("/responses") ? Response.json({ object: "response", output: [] }) : new Response(null, { status: 404 })
    }
    const auth = { type: "api", key: "sk-not-written-to-options" }
    const hooks = await KunRouterPlugin(input, settings)
    await hooks.provider.models({ models: {} }, { auth })
    const text = await readFile(output, "utf8")
    const saved = JSON.parse(text)
    assert.equal(saved.protocol_report.id, "once")
    assert.equal(saved.protocol_report.status, "done")
    assert.equal(saved.protocol_report.results.find((r) => r.protocol === "responses").status, "supported")
    assert.deepEqual(saved.protocol_support.native.protocols, ["responses"])
    assert.equal(text.includes(auth.key), false)
    assert.equal(generations, 4)
    await hooks.provider.models({ models: {} }, { auth })
    assert.equal(generations, 4)
    const restarted = await KunRouterPlugin(input, saved)
    const models = await restarted.provider.models({ models: {} }, { auth })
    assert.equal(models.native.api.npm, "@ai-sdk/openai")
    assert.equal(models.native.api.url, "https://relay.example/v1")
    assert.equal(generations, 4)
  } finally {
    process.chdir(cwd)
    globalThis.fetch = realFetch
    if (oldBin === undefined) delete process.env.KUNROUTER_MAGPIE_BIN; else process.env.KUNROUTER_MAGPIE_BIN = oldBin
    if (oldOut === undefined) delete process.env.KUNROUTER_TEST_REPORT; else process.env.KUNROUTER_TEST_REPORT = oldOut
    await rm(dir, { recursive: true, force: true })
  }
})
