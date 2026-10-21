/**
 * Real-host probe: mounts the real plugin, serves the real route, and runs
 * `remote_sudo` against the real `ssh aliyun` with a deliberately wrong
 * password. It proves the production path (ssh BatchMode -> sudo -S on stdin)
 * without knowing the real password.
 */

import assert from 'node:assert/strict'
import http from 'node:http'

import { apply } from '../index.js'

const HOST = process.env.DSH_SUDO_PROBE_HOST ?? 'aliyun'
const WRONG_PASSWORD = `wrong-probe-${Date.now()}`

let toolDefinition
let route

const ctx = {
  effect(fn) {
    fn()
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
}

apply(ctx, { passwordTtlMs: 0 })
assert.ok(toolDefinition, 'tool registered')
assert.ok(route, 'route registered')

const server = http.createServer((req, res) => route.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/_dsh/dsh-remote-sudo`

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

const execution = toolDefinition.execute(
  { host: HOST, command: 'id -u', description: 'real-host probe' },
  { signal: new AbortController().signal },
)

const pendingResponse = await fetch(`${base}/pending?wait=10000`)
const pending = await pendingResponse.json()
assert.equal(pending.host, HOST)
console.log('prompt:', JSON.stringify({ host: pending.host, command: pending.command, id: pending.id }))

const answer = await post('/answer', { id: pending.id, password: WRONG_PASSWORD })
assert.equal(answer.status, 200)

const result = await execution
console.log('--- tool result ---')
console.log(result)
console.log('-------------------')

assert.match(result, /\[exit code: 1\]/)
assert.match(result, /Sorry, try again|incorrect password attempt/)
assert.ok(!result.includes(WRONG_PASSWORD), 'password must not appear in the result')

await new Promise((resolve) => server.close(resolve))
console.log('ok: real ssh + sudo -S path reached the remote password check')
