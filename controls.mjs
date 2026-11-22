import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readlink } from "node:fs/promises"
import { basename, delimiter, dirname, join } from "node:path"
import { promisify } from "node:util"

export function apiRoot(value) {
  const url = new URL(value)
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("请填写完整的 HTTP 或 HTTPS Base URL")
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:v1|v1beta)$/, "")
  return url.toString().replace(/\/+$/, "")
}

async function magpieBinary() {
  if (process.env.KUNROUTER_MAGPIE_BIN) return process.env.KUNROUTER_MAGPIE_BIN
  // The desktop app's child may have no CLI on PATH. Prefer its actual parent binary.
  try {
    const run = promisify(execFile)
    const parent = process.platform === "linux" ? await readlink(`/proc/${process.ppid}/exe`)
      : (await run(process.platform === "win32" ? "powershell.exe" : "/bin/ps", process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.ppid}').ExecutablePath`]
        : ["-p", String(process.ppid), "-o", "comm="], { windowsHide: true, timeout: 3000 })).stdout.trim()
    if (/^magpie(?:\.(?:exe|com))?$/i.test(basename(parent))) {
      const console = join(dirname(parent), "magpie.com")
      return process.platform === "win32" && existsSync(console) ? console : parent
    }
  } catch { /* CLI-only installs fall back to PATH. */ }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of process.platform === "win32" ? ["magpie.com", "magpie.exe"] : ["magpie"]) {
      const file = join(dir, name)
      if (existsSync(file)) return file
    }
  }
  return "magpie"
}

// The page bridge can edit its own options but has no backend RPC. Publish
// the explicit operation's result using Magpie's supported options command.
async function ownOptions(run) {
  const binary = await magpieBinary()
  // Option enumeration may load this plugin in a new host. It must not start the pending probe again.
  const execution = { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, KUNROUTER_REPORT_WRITER: "1" } }
  const { stdout } = await run(binary, ["plugin", "options", "kunrouter"], execution)
  const json = stdout.replace(/\x1b\[[0-9;]*m/g, "")
  const start = json.indexOf("{")
  const current = start < 0 ? {} : JSON.parse(json.slice(start))
  return { binary, execution, current }
}

export async function publishLoginDefaults(origin, base, run = promisify(execFile)) {
  const { binary, execution, current } = await ownOptions(run)
  if (current.authorization_origin === origin && current.default_api_base === base) return false
  const options = { ...current, authorization_origin: origin, default_api_base: base }
  await run(binary, ["plugin", "options", "kunrouter", JSON.stringify(options)], execution)
  return true
}

export async function publishProtocolReport(settings, report, support, run = promisify(execFile)) {
  const { binary, execution, current } = await ownOptions(run)
  if (current.protocol_probe?.id !== report.id || current.api_base !== settings.api_base || current.protocol !== settings.protocol
    || current.authorization_origin !== settings.authorization_origin) return false
  const merged = { ...current.protocol_support }
  if (report.model && support[report.model]) merged[report.model] = support[report.model]
  for (const old of Object.keys(merged).slice(0, Math.max(0, Object.keys(merged).length - 64))) delete merged[old]
  const options = { ...current, protocol_report: report, protocol_support: merged }
  await run(binary, ["plugin", "options", "kunrouter", JSON.stringify(options)], execution)
  return true
}
