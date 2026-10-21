/**
 * Host-side integration tests for dsh-remote-sudo.
 *
 * Mounts the real plugin against a fake Cordis context, serves the real route
 * on a loopback HTTP server, and replaces `ssh` on PATH with a script that
 * checks the password on stdin and records `sudo -k`. No DSH process and no
 * real sudo are involved.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const PASSWORD = 's3cret pass'

const binDir = mkdtempSync(join(tmpdir(), 'dsh-remote-sudo-'))
const logFile = join(binDir, 'ssh.log')
const sshPath = join(binDir, 'ssh')
writeFileSync(sshPath, `#!/bin/bash
remote="\${!#}"
printf '%s\\n' "$remote" >> "$FAKE_SSH_LOG"
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
writeFileSync(logFile, '')

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
      requestRejection() {
        return undefined
      },
    },
  }
  apply(ctx, { sudoPath: '/usr/bin/sudo', ...config })
  assert.ok(toolDefinition, 'tool registered')
  assert.ok(route, 'route registered')
  return { tool: toolDefinition, route, disposers }
}

async function withMount(config, run) {
  const { tool, route, disposers } = mount(config)
  const server = http.createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/_dsh/dsh-remote-sudo`

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

// 1. TTL 0: every call prompts, runs sudo -S, then invalidates the timestamp.
await withMount({ passwordTtlMs: 0 }, async ({ tool, getPending, post }) => {
  writeFileSync(logFile, '')
  const first = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const firstPrompt = await getPending(5000)
  assert.equal(firstPrompt.body.host, 'aliyun')
  await post('/answer', { id: firstPrompt.body.id, password: PASSWORD })
  const firstResult = await first
  assert.match(firstResult, /root-ok/)
  assert.match(firstResult, /\[exit code: 0\]/)
  const firstLog = log()
  assert.ok(firstLog.includes("/usr/bin/sudo -S -p '' -- sh -c"), 'uses sudo -S')
  assert.ok(firstLog.includes('exec 0</dev/null; id -u'), 'command stdin is /dev/null')
  assert.ok(firstLog.includes('/usr/bin/sudo -k'), 'invalidates the timestamp')

  writeFileSync(logFile, '')
  const second = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const rejection = assert.rejects(second, /cancelled/)
  const secondPrompt = await getPending(5000)
  assert.equal(secondPrompt.body.host, 'aliyun', 'TTL 0 prompts again')
  await post('/cancel', { id: secondPrompt.body.id })
  await rejection
  console.log('ok: TTL 0 prompts every call and runs sudo -k')
})

// 2. A positive TTL reuses the in-memory password without prompting.
await withMount({ passwordTtlMs: 60000 }, async ({ tool, getPending, post }) => {
  const first = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const prompt = await getPending(5000)
  await post('/answer', { id: prompt.body.id, password: PASSWORD })
  await first

  writeFileSync(logFile, '')
  const second = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const outcome = await Promise.race([
    second,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500)),
  ])
  assert.notEqual(outcome, 'timeout', 'cached password must not prompt')
  assert.match(outcome, /root-ok/)
  assert.ok(log().includes("-S -p ''"), 'cached run still authenticates with sudo -S')
  assert.ok(log().includes('/usr/bin/sudo -k'), 'still invalidates the timestamp')
  console.log('ok: positive TTL reuses the cached password')
})

// 3. A wrong password clears the cache so the next call prompts.
await withMount({ passwordTtlMs: 60000 }, async ({ tool, getPending, post }) => {
  const first = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const prompt = await getPending(5000)
  await post('/answer', { id: prompt.body.id, password: 'wrong password' })
  const failed = await first
  assert.match(failed, /\[exit code: 1\]/)

  writeFileSync(logFile, '')
  const second = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const secondPrompt = await getPending(5000)
  assert.equal(secondPrompt.body.host, 'aliyun', 'cache was cleared after the failure')
  await post('/answer', { id: secondPrompt.body.id, password: PASSWORD })
  await second
  console.log('ok: a failed run clears the password cache')
})

// 4. sudoPath empty auto-detects, with a PATH fallback.
await withMount({ passwordTtlMs: 0, sudoPath: '' }, async ({ tool, getPending, post }) => {
  const execution = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const prompt = await getPending(5000)
  await post('/answer', { id: prompt.body.id, password: PASSWORD })
  const result = await execution
  assert.match(result, /root-ok/)
  const text = log()
  assert.ok(text.includes('command -v sudo'), 'falls back to command -v')
  assert.ok(text.includes('/usr/bin/sudo'), 'tries the common absolute paths')
  assert.ok(text.includes('/run/current-system/sw/bin/sudo'), 'covers NixOS')
  console.log('ok: auto-detects sudo path')
})

// 5. Cancel and host validation.
await withMount({ passwordTtlMs: 0 }, async ({ tool, getPending, post }) => {
  const execution = tool.execute({ host: 'aliyun', command: 'systemctl restart nginx' }, { signal: signal() })
  const rejection = assert.rejects(execution, /cancelled by the user/)
  const prompt = await getPending(5000)
  const cancel = await post('/cancel', { id: prompt.body.id })
  assert.equal(cancel.status, 200)
  await rejection

  await assert.rejects(
    tool.execute({ host: '-oProxyCommand=touch /tmp/x', command: 'id' }, { signal: signal() }),
    /host must be an SSH host alias/,
  )
  console.log('ok: cancel and host validation')
})

// 6. Route method and id validation.
await withMount({ passwordTtlMs: 0 }, async ({ base, post }) => {
  const missing = await post('/answer', { id: 'nope', password: 'x' })
  assert.equal(missing.status, 409)
  const bad = await fetch(`${base}/pending?wait=0`, { method: 'POST' })
  assert.equal(bad.status, 405)
  console.log('ok: route method and id validation')
})

process.env.PATH = originalPath
console.log('\nall host tests passed')
