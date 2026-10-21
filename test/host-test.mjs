/**
 * Host-side integration tests for dsh-sudo-askpass.
 *
 * Mounts the real plugin against a fake Cordis context, serves the real route
 * on a loopback HTTP server, and replaces `ssh` on PATH with a script that
 * implements the remote side: probe, ticket run, password run, and
 * invalidation. No DSH process and no real sudo are involved.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const PASSWORD = 's3cret pass'

const binDir = mkdtempSync(join(tmpdir(), 'dsh-sudo-askpass-'))
const logFile = join(binDir, 'ssh.log')
const sshPath = join(binDir, 'ssh')
writeFileSync(sshPath, `#!/bin/bash
remote="\${!#}"
printf '%s\\n' "$remote" >> "$FAKE_SSH_LOG"
case "$remote" in
  *" -n true")
    case "$FAKE_SUDO_MODE" in
      ticket) exit 0 ;;
      fatal) echo "sudo: user is not in the sudoers file" >&2; exit 1 ;;
      *) echo "sudo: a password is required" >&2; exit 1 ;;
    esac
    ;;
  *" -k")
    echo "timestamp invalidated" >&2
    exit 0
    ;;
  *" -n -- sh -c "*)
    echo "ticket-ok"
    exit 0
    ;;
  *" -S -p '' -- sh -c "*)
    read -r pw
    if [ "$pw" = ${JSON.stringify(PASSWORD)} ]; then
      echo "root-ok"
      exit 0
    fi
    echo "Sorry, try again." >&2
    echo "sudo: 1 incorrect password attempt" >&2
    exit 1
    ;;
  *)
    echo "unexpected remote: $remote" >&2
    exit 9
    ;;
esac
`)
chmodSync(sshPath, 0o755)

const originalPath = process.env.PATH
process.env.PATH = `${binDir}:${originalPath ?? ''}`
process.env.FAKE_SSH_LOG = logFile
process.env.FAKE_SUDO_MODE = 'ticket'

function setMode(mode) {
  process.env.FAKE_SUDO_MODE = mode
  writeFileSync(logFile, '')
}

function log() {
  try {
    return readFileSync(logFile, 'utf8')
  } catch {
    return ''
  }
}

function mount(config) {
  let toolDefinition
  let route
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
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
      rejectWith: undefined,
      requestRejection() {
        return this.rejectWith
      },
    },
  }
  apply(ctx, config)
  assert.ok(toolDefinition, 'tool registered')
  assert.ok(route, 'route registered')
  return { tool: toolDefinition, route, disposers }
}

async function withMount(config, run) {
  const { tool, route, disposers } = mount(config)
  const server = http.createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/_dsh/dsh-sudo-askpass`

  async function getPending(wait = 0) {
    const response = await fetch(`${base}/pending?wait=${wait}`)
    return { status: response.status, body: await response.json() }
  }

  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  try {
    return await run({ tool, base, getPending, post })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    for (const dispose of disposers) dispose()
  }
}

function signal() {
  return new AbortController().signal
}

// 1. `sudo` mode with a valid ticket: probe succeeds, no prompt, no password.
await withMount({ cacheMode: 'sudo' }, async ({ tool, getPending }) => {
  setMode('ticket')
  const result = await tool.execute({ host: 'aliyun', command: 'apt-get update' }, { signal: signal() })
  assert.match(result, /ticket-ok/)
  assert.match(result, /\[exit code: 0\]/)
  const pending = await getPending(0)
  assert.deepEqual(pending.body, {})
  const text = log()
  assert.ok(text.includes('/usr/bin/sudo -n true'), 'probe uses the absolute sudo path')
  assert.ok(text.includes('/usr/bin/sudo -n -- sh -c'), 'ticket run uses sudo -n')
  assert.ok(text.includes('exec 0</dev/null; apt-get update'), 'command stdin is /dev/null')
  assert.ok(!text.includes('-S -p'), 'no password run')
  console.log('ok: valid ticket skips the prompt and uses sudo -n')
})

// 2. `sudo` mode without a ticket: prompt, password on stdin, sudo -S.
await withMount({ cacheMode: 'sudo' }, async ({ tool, getPending, post }) => {
  setMode('password')
  const execution = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const pending = await getPending(5000)
  assert.equal(pending.status, 200)
  assert.equal(pending.body.host, 'aliyun')
  assert.equal(pending.body.command, 'id -u')
  const answer = await post('/answer', { id: pending.body.id, password: PASSWORD })
  assert.equal(answer.status, 200)
  const result = await execution
  assert.match(result, /root-ok/)
  assert.match(result, /\[exit code: 0\]/)
  assert.ok(!result.includes(PASSWORD), 'result must not contain the password')
  const text = log()
  assert.ok(text.includes("/usr/bin/sudo -S -p '' -- sh -c"), 'password run uses sudo -S')
  console.log('ok: missing ticket prompts and feeds sudo -S over stdin')
})

// 3. `password` mode caches the password in host memory for the TTL.
await withMount({ cacheMode: 'password', passwordTtlMs: 60000 }, async ({ tool, getPending, post }) => {
  setMode('password')
  const first = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const pending = await getPending(5000)
  await post('/answer', { id: pending.body.id, password: PASSWORD })
  await first

  writeFileSync(logFile, '')
  const second = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const outcome = await Promise.race([
    second,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500)),
  ])
  assert.notEqual(outcome, 'timeout', 'cached password must not prompt')
  assert.match(outcome, /root-ok/)
  assert.ok(log().includes("-S -p ''"), 'cached run still sends the password')
  console.log('ok: password cache skips the second prompt within the TTL')
})

// 4. `none` mode always prompts and invalidates the remote timestamp.
await withMount({ cacheMode: 'none' }, async ({ tool, getPending, post }) => {
  setMode('ticket')
  const first = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const pending = await getPending(5000)
  assert.equal(pending.body.host, 'aliyun')
  await post('/answer', { id: pending.body.id, password: PASSWORD })
  await first
  assert.ok(log().includes(' -k'), 'timestamp invalidated after the run')

  writeFileSync(logFile, '')
  const second = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const rejection = assert.rejects(second, /cancelled/)
  const secondPending = await getPending(5000)
  assert.equal(secondPending.body.host, 'aliyun', 'second call prompts again')
  await post('/cancel', { id: secondPending.body.id })
  await rejection
  console.log('ok: none mode prompts every time and invalidates the timestamp')
})

// 5. A fatal preflight failure is reported without prompting.
await withMount({ cacheMode: 'sudo' }, async ({ tool, getPending }) => {
  setMode('fatal')
  await assert.rejects(
    tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() }),
    /not in the sudoers file/,
  )
  const pending = await getPending(0)
  assert.deepEqual(pending.body, {})
  console.log('ok: fatal preflight reports without prompting')
})

// 6. A wrong password clears the cache so the next call prompts again.
await withMount({ cacheMode: 'password', passwordTtlMs: 60000 }, async ({ tool, getPending, post }) => {
  setMode('password')
  const first = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const pending = await getPending(5000)
  await post('/answer', { id: pending.body.id, password: 'wrong password' })
  const failed = await first
  assert.match(failed, /\[exit code: 1\]/)

  writeFileSync(logFile, '')
  const second = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const secondPending = await getPending(5000)
  assert.equal(secondPending.body.host, 'aliyun', 'cache was cleared after the failure')
  await post('/answer', { id: secondPending.body.id, password: PASSWORD })
  await second
  console.log('ok: wrong password clears the cache')
})

// 7. Cancel and validation still work.
await withMount({ cacheMode: 'sudo' }, async ({ tool, getPending, post }) => {
  setMode('password')
  const execution = tool.execute({ host: 'aliyun', command: 'systemctl restart nginx' }, { signal: signal() })
  const rejection = assert.rejects(execution, /cancelled by the user/)
  const pending = await getPending(5000)
  const cancel = await post('/cancel', { id: pending.body.id })
  assert.equal(cancel.status, 200)
  await rejection

  await assert.rejects(
    tool.execute({ host: '-oProxyCommand=touch /tmp/x', command: 'id' }, { signal: signal() }),
    /host must be an SSH host alias/,
  )
  console.log('ok: cancel and host validation')
})

// 8. The route keeps the connection auth boundary and rejects bad ids.
await withMount({ cacheMode: 'sudo' }, async ({ getPending, post, base }) => {
  setMode('ticket')
  const rejected = await getPending(0)
  assert.equal(rejected.status, 200)
  const missing = await post('/answer', { id: 'nope', password: 'x' })
  assert.equal(missing.status, 409)
  const bad = await fetch(`${base}/pending?wait=0`, { method: 'POST' })
  assert.equal(bad.status, 405)
  console.log('ok: route method and id validation')
})

process.env.PATH = originalPath
console.log('\nall host tests passed')
