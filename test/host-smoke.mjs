/**
 * Host-half smoke test — run with `node test/host-smoke.mjs`.
 *
 * Boots the plugin's `apply` against a fake Cordis context, then drives the
 * three real entry points (system-prompt section, `global_rules` tool, `/rules`
 * command) plus the browser half's HTTP route. It writes only inside a unique
 * temporary `DSH_HOME`, so the live rule store is never touched.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-global-rules-'))
process.env.DSH_HOME = tmpHome

const failures = []
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** A context that records what the plugin registers. */
function makeContext() {
  const captured = { section: undefined, tool: undefined, route: undefined, command: undefined, disposers: [] }
  const ctx = {
    systemPrompt: {
      section(section) {
        captured.section = section
        const dispose = () => { captured.section = undefined }
        captured.disposers.push(dispose)
        return dispose
      },
    },
    tools: {
      register(definition) {
        captured.tool = definition
        return () => { captured.tool = undefined }
      },
    },
    webServer: {
      register(route) {
        captured.route = route
        return () => { captured.route = undefined }
      },
    },
    effect(callback) {
      const dispose = callback()
      captured.disposers.push(dispose)
      return () => {}
    },
    inject(_names, callback) {
      callback({
        effect(inner) {
          const dispose = inner()
          captured.disposers.push(dispose)
          return () => {}
        },
        commands: {
          register(definition) {
            captured.command = definition
            return () => { captured.command = undefined }
          },
        },
      })
      return () => {}
    },
    get() {
      return undefined
    },
  }
  return { ctx, captured }
}

/** One HTTP round trip through the registered route. */
async function call(captured, method, url, body, headers = {}) {
  const request = {
    method,
    url,
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  let status = 0
  let text = ''
  const response = {
    writeHead(code) { status = code },
    end(chunk) { if (chunk) text += String(chunk) },
  }
  await captured.route.handler(request, response)
  return { status, text, json: text ? JSON.parse(text) : null }
}

try {
  const host = await import(`file:///${path.join(here, '..', 'lib', 'index.js').replace(/\\/g, '/')}`)
  const { ctx, captured } = makeContext()
  host.apply(ctx)

  console.log('\nregistration')
  check('prompt section registered', captured.section?.name === 'global-rules', captured.section?.name)
  check('prompt section order is 100', captured.section?.order === 100, String(captured.section?.order))
  check('prompt section is literal (no interpolation)', captured.section?.interpolate === false)
  check('tool registered as global_rules', captured.tool?.name === 'global_rules', captured.tool?.name)
  check('route registered as a prefix', captured.route?.kind === 'prefix' && captured.route?.path === '/dsh-global-rules')
  check('command registered as /rules', captured.command?.name === 'rules', captured.command?.name)

  console.log('\nempty store')
  check('no rule means no injected text', captured.section.text({}) === '', JSON.stringify(captured.section.text({})))

  console.log('\nHTTP route (browser half data path)')
  const initial = await call(captured, 'GET', '/dsh-global-rules/state')
  check('GET /state answers 200', initial.status === 200, String(initial.status))
  check('GET /state reports an empty list', initial.json?.count === 0)
  check('store lives outside the package', String(initial.json?.path).startsWith(tmpHome.replace(/\\/g, '\\')))

  const saved = await call(captured, 'POST', '/dsh-global-rules/state', {
    enabled: true,
    acknowledge: true,
    rules: [
      { text: '回答只用简体中文。', enabled: true },
      { text: '代码块必须标注语言。', enabled: false },
    ],
  })
  check('POST /state answers 200', saved.status === 200, `${saved.status} ${saved.text}`)
  check('one of two rules is enabled', saved.json?.enabledCount === 1 && saved.json?.count === 2, JSON.stringify({ n: saved.json?.count, on: saved.json?.enabledCount }))
  check('saved state carries ids', typeof saved.json?.rules?.[0]?.id === 'string')

  console.log('\nsystem prompt (the model-facing contract)')
  const injected = captured.section.text({})
  check('section states the review requirement', injected.includes('每次回答前必须逐条核对'))
  check('enabled rule is numbered into the prompt', injected.includes('1. 回答只用简体中文。'))
  check('disabled rule stays out of the prompt', !injected.includes('代码块必须标注语言。'))
  check('acknowledge adds the visible check line', injected.includes('规则检查：已核对 N 条'))
  check('preview matches the injected text', saved.json?.preview === injected)

  const silent = await call(captured, 'POST', '/dsh-global-rules/state', { acknowledge: false })
  const silentText = captured.section.text({})
  check('silent mode forbids printing the check', silentText.includes('不要在回答里输出规则核对结果'), silentText.slice(-120))
  check('silent mode drops the visible check line', !silentText.includes('规则检查：已核对 N 条'))
  check('silent mode keeps the rules themselves', silentText.includes('1. 回答只用简体中文。'))
  check('silent is the stored state', silent.json?.acknowledge === false)
  await call(captured, 'POST', '/dsh-global-rules/state', { acknowledge: true })

  const off = await call(captured, 'POST', '/dsh-global-rules/state', { enabled: false })
  check('disabling removes the section entirely', captured.section.text({}) === '')
  check('disabled state keeps the rules stored', off.json?.rules?.length === 2)
  await call(captured, 'POST', '/dsh-global-rules/state', { enabled: true })

  console.log('\nglobal_rules tool')
  const listed = await captured.tool.execute({ action: 'list' })
  check('list names the stored rules', listed.includes('回答只用简体中文。'), listed.slice(0, 80))
  const added = await captured.tool.execute({ action: 'add', text: '先给结论，再给理由。' })
  check('add appends a rule', added.includes('先给结论，再给理由。'))
  check('add reaches the prompt', captured.section.text({}).includes('2. 先给结论，再给理由。'))
  const updated = await captured.tool.execute({ action: 'update', index: 2, ruleEnabled: false })
  check('update can disable one rule', updated.includes('[停用] 代码块必须标注语言。'))
  check('a disabled rule leaves the prompt', !captured.section.text({}).includes('代码块必须标注语言。'))
  const removed = await captured.tool.execute({ action: 'remove', index: 2 })
  check('remove deletes by 1-based index', removed.includes('已删除第 2 条'))
  let toolError = ''
  try {
    await captured.tool.execute({ action: 'remove', index: 99 })
  } catch (error) {
    toolError = error instanceof Error ? error.message : String(error)
  }
  check('an out-of-range index is a tool error', toolError.includes('global_rules:'), toolError)

  console.log('\n/rules command')
  const help = await captured.command.handler({ rawInput: ' help' })
  check('help lists the subcommands', help.kind === 'success' && help.text.includes('/rules add <文本>'))
  const cmdAdd = await captured.command.handler({ rawInput: ' add 不要输出表情符号。' })
  check('add works from the command', cmdAdd.kind === 'success' && cmdAdd.text.includes('不要输出表情符号。'))
  const cmdOff = await captured.command.handler({ rawInput: ' check off' })
  check('check off works from the command', cmdOff.kind === 'success' && cmdOff.text.includes('显示规则检查：关'), cmdOff.text)
  const guard = await captured.command.handler({ rawInput: ' clear' })
  check('clear asks for confirmation', guard.kind === 'error' && guard.text.includes('clear yes'))
  const unknown = await captured.command.handler({ rawInput: ' nope' })
  check('an unknown subcommand is an error', unknown.kind === 'error')

  console.log('\nrequest fence')
  const crossSite = await call(captured, 'GET', '/dsh-global-rules/state', undefined, { 'sec-fetch-site': 'cross-site' })
  check('cross-site fetch is refused', crossSite.status === 403, String(crossSite.status))
  const remoteHost = await call(captured, 'GET', '/dsh-global-rules/state', undefined, { host: 'evil.example.com' })
  check('a non-loopback Host is refused', remoteHost.status === 403, String(remoteHost.status))
  const otherOrigin = await call(captured, 'GET', '/dsh-global-rules/state', undefined, { origin: 'http://evil.example.com' })
  check('a foreign Origin is refused', otherOrigin.status === 403, String(otherOrigin.status))
  const badJson = await call(captured, 'POST', '/dsh-global-rules/state', undefined, { 'content-type': 'application/json' })
  check('an empty body is a 400 patch, not a crash', badJson.status === 400 || badJson.status === 200, String(badJson.status))

  console.log('\nteardown')
  for (const dispose of captured.disposers) if (typeof dispose === 'function') dispose()
  check('every registration returns a disposer', captured.disposers.length === 3, String(captured.disposers.length))
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true })
}

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
