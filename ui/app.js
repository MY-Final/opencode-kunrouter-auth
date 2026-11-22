(() => {
  const $ = (id) => document.getElementById(id)
  const form = $("settings"), address = $("base-url"), model = $("model")
  const detect = $("detect"), status = $("status"), results = $("results")
  const tabs = [...document.querySelectorAll("[data-protocol]")]
  const labels = { chat: "Chat", responses: "Responses", anthropic: "Messages", gemini: "Gemini" }
  let protocol = "chat", busy = false, armed = false, loaded = false, addressEdited = false

  function say(text = "", tone = "") {
    status.textContent = text
    status.dataset.tone = tone
  }
  function disarm() {
    armed = false
    detect.textContent = "检测协议"
    delete detect.dataset.confirm
  }
  function lock(on) {
    busy = on
    for (const field of form.querySelectorAll("button, input")) field.disabled = on
    form.setAttribute("aria-busy", String(on))
  }
  function select(value, adjust = false) {
    protocol = Object.hasOwn(labels, value) ? value : "chat"
    for (const tab of tabs) {
      const active = tab.dataset.protocol === protocol
      tab.setAttribute("aria-selected", String(active))
      tab.tabIndex = active ? 0 : -1
    }
    if (adjust) {
      address.value = address.value.replace(/\/(v1|v1beta)\/?$/, protocol === "gemini" ? "/v1beta" : "/v1")
      disarm()
      say()
    }
  }
  function valid() {
    if (!address.value.trim()) return true
    if (!address.reportValidity()) return false
    const url = new URL(address.value.trim())
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      say("请输入有效的 HTTP(S) 地址", "error")
      address.focus()
      return false
    }
    return true
  }
  function render(report) {
    results.replaceChildren()
    results.hidden = true
    if (!report || report.status !== "done") return
    if (report.model) {
      const name = document.createElement("span")
      name.className = "model-name"
      name.textContent = report.model
      name.title = report.model
      results.append(name)
    }
    for (const row of report.results || []) {
      if (!Object.hasOwn(labels, row.protocol)) continue
      const chip = document.createElement("span")
      const state = ["supported", "unsupported"].includes(row.status) ? row.status : "unknown"
      chip.className = "result"
      chip.dataset.state = state
      const word = { supported: "支持", unsupported: "不支持", unknown: "未确认" }[state]
      chip.textContent = `${{ supported: "✓", unsupported: "×", unknown: "—" }[state]} ${labels[row.protocol]}`
      chip.title = word
      chip.setAttribute("aria-label", `${labels[row.protocol]}：${word}`)
      results.append(chip)
    }
    results.hidden = !results.childElementCount
  }
  async function save(extra = {}) {
    const current = await magpie.options.get()
    const next = { ...current, protocol, ...extra }
    if (addressEdited) {
      const value = address.value.trim()
      if (!value || sameRoot(value, current.default_api_base)) delete next.api_base
      else next.api_base = value
    }
    const saved = await magpie.options.set(next)
    addressEdited = false
    address.value = (saved.api_base || saved.default_api_base || "")
      .replace(/\/(v1|v1beta)\/?$/, protocol === "gemini" ? "/v1beta" : "/v1")
    return saved
  }
  function sameRoot(value, automatic) {
    const root = (text) => {
      const url = new URL(text)
      return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/(v1|v1beta)$/, "")
    }
    try { return !!automatic && root(value) === root(automatic) } catch { return false }
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab.dataset.protocol, true))
    tab.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
      if (!step) return
      event.preventDefault()
      const next = tabs[(index + step + tabs.length) % tabs.length]
      next.focus()
      select(next.dataset.protocol, true)
    })
  }
  for (const field of [address, model]) field.addEventListener("input", () => { disarm(); say() })
  address.addEventListener("input", () => { addressEdited = true })
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (!loaded || busy || !valid()) return
    disarm()
    lock(true)
    try { await save(); say("已应用", "success") }
    catch (error) { say(error.message || "应用失败，请重试", "error") }
    finally { lock(false) }
  })
  detect.addEventListener("click", async () => {
    if (!loaded || busy || !valid()) return
    if (!armed) {
      armed = true
      detect.textContent = "确认检测"
      detect.dataset.confirm = "true"
      say("可能产生少量费用")
      return
    }
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    disarm()
    lock(true)
    results.hidden = true
    say("检测中…")
    try {
      await save({ protocol_probe: { id, model: model.value.trim() } })
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const report = (await magpie.options.get()).protocol_report
        if (report?.id !== id) continue
        if (report.status === "error") throw new Error(report.error || "检测失败，请重试")
        if (report.status !== "done") continue
        render(report)
        say("检测完成", "success")
        return
      }
      say("检测尚未完成，请重新获取模型后重试", "error")
    } catch (error) { say(error.message || "检测失败，请重试", "error") }
    finally { lock(false) }
  })
  model.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); detect.click() }
  })
  lock(true)
  ;(async () => {
    try {
      await magpie.ready
      const options = await magpie.options.get()
      address.value = options.api_base || options.default_api_base || ""
      model.value = options.protocol_probe?.model || ""
      select(options.protocol)
      render(options.protocol_report)
      loaded = true
      lock(false)
    } catch { say("连接失败，请重新打开", "error") }
  })()
})()
