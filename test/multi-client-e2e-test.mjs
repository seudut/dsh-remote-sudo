/**
 * End-to-end regression test for the multi-browser sudo panel.
 *
 * Mounts the real Host half against a fake Cordis context and a loopback HTTP
 * server, then mounts two real Client halves (two browsers pointing at the same
 * Host, like the desktop and a phone through dsh-pocket). One browser answers;
 * the other panel must settle. Stopping the turn must settle every panel too.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const PASSWORD = 's3cret pass'

const binDir = mkdtempSync(join(tmpdir(), 'dsh-remote-sudo-e2e-'))
const sshPath = join(binDir, 'ssh')
writeFileSync(sshPath, `#!/bin/bash
remote="\${!#}"
case "$remote" in
  *" -k")
    exit 0
    ;;
  *" -S -p '' -- sh -c "*)
    read -r pw
    if [ "$pw" = ${JSON.stringify(PASSWORD)} ]; then
      echo "root-ok"
      exit 0
    fi
    echo "Sorry, try again." >&2
    exit 1
    ;;
  *)
    exit 9
    ;;
esac
`)
chmodSync(sshPath, 0o755)

const originalPath = process.env.PATH
process.env.PATH = `${binDir}:${originalPath ?? ''}`

// ── Real Host half on a loopback server ──────────────────────────────────────
let toolDefinition
let route
const hostDisposers = []
apply({
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') hostDisposers.push(dispose)
  },
  inject() {},
  tools: {
    register(definition) {
      toolDefinition = definition
    },
  },
  webServer: {
    register(value) {
      route = value
      return () => {}
    },
  },
  connection: {
    requestRejection() {
      return undefined
    },
  },
}, { passwordTtlMs: 0, sudoPath: '/usr/bin/sudo' })
assert.ok(toolDefinition, 'host tool registered')
assert.ok(route, 'host route registered')

const server = http.createServer((req, res) => route.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// ── Two real Client halves sharing the page globals ──────────────────────────
globalThis.document = { activeElement: null }
let captured
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      captured = value
    },
  },
}

const realFetch = globalThis.fetch
/** `/pending` requests currently in flight, both browsers together. */
let inflightPending = 0
globalThis.fetch = (url, init) => {
  const request = realFetch(new URL(String(url), base), init)
  if (!String(url).includes('/pending')) return request
  inflightPending += 1
  return request.finally(() => {
    inflightPending -= 1
  })
}

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    return [initial, () => {}]
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
}

async function mountBrowser(name) {
  captured = undefined
  await import(`../client.js?e2e=${name}-${Date.now()}`)
  assert.ok(captured, 'client bundle registered')
  const face = captured.factory((specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected require: ${specifier}`)
  })
  const published = new Map()
  const errors = []
  const disposers = []
  face.apply({
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    locale: {
      register() {
        return () => {}
      },
    },
    slots: {
      inject() {},
      register() {
        return () => {}
      },
    },
    uiSession: {
      current: { value: { key: 'session-1' } },
      registerPendingInteraction() {
        return (interaction, delegate) => {
          if (typeof delegate !== 'function') errors.push(new Error('publish delegate missing'))
          if (published.has(interaction.key)) {
            errors.push(new Error(`duplicate publication: ${interaction.key}`))
            return () => {}
          }
          published.set(interaction.key, { interaction, delegate })
          return () => published.delete(interaction.key)
        }
      },
    },
  })
  return { published, errors, disposers }
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const desktop = await mountBrowser('desktop')
const phone = await mountBrowser('phone')

// 1. Both browsers show the same prompt.
const execution = toolDefinition.execute(
  { host: 'aliyun', command: 'id -u' },
  { signal: new AbortController().signal },
)
await waitFor(
  () => desktop.published.size === 1 && phone.published.size === 1,
  'both browsers show the prompt',
)
await waitFor(() => inflightPending >= 2, 'both browsers park a long-poll before the answer')
const desktopPrompt = [...desktop.published.values()][0].interaction
const phonePrompt = [...phone.published.values()][0].interaction
assert.equal(desktopPrompt.id, phonePrompt.id, 'both browsers received the same prompt')

// 2. Answering on the phone settles the desktop panel (the reported bug).
await phonePrompt.answer(PASSWORD)
const result = await execution
assert.match(result, /root-ok/)
await waitFor(() => desktop.published.size === 0, 'the desktop panel settles when the phone answers')
assert.equal(desktopPrompt.settled, true, 'the desktop prompt is settled')
assert.equal(phonePrompt.settled, true, 'the phone prompt is settled')

// 3. Stopping the turn settles every open panel instead of stranding one.
const controller = new AbortController()
const aborted = toolDefinition.execute({ host: 'aliyun', command: 'id -u' }, { signal: controller.signal })
const abortedRejection = assert.rejects(aborted, /aborted before the password was entered/)
await waitFor(
  () => desktop.published.size === 1 && phone.published.size === 1,
  'both browsers show the second prompt',
)
await waitFor(() => inflightPending >= 2, 'both browsers park a long-poll before the abort')
controller.abort()
await waitFor(
  () => desktop.published.size === 0 && phone.published.size === 0,
  'stopping the turn settles every panel',
)
await abortedRejection
assert.deepEqual(desktop.errors, [], 'the desktop client recorded no failures')
assert.deepEqual(phone.errors, [], 'the phone client recorded no failures')

// ── Teardown ─────────────────────────────────────────────────────────────────
for (const dispose of desktop.disposers) dispose()
for (const dispose of phone.disposers) dispose()
for (const dispose of hostDisposers) dispose()
process.env.PATH = originalPath
await new Promise((resolve) => {
  server.close(resolve)
  server.closeIdleConnections()
})

console.log('ok: answering in one browser settles the other browser panel')
