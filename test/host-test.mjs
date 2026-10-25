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

  async function getPending(wait = 0, since, epoch) {
    const query = new URLSearchParams({ wait: String(wait) })
    if (since !== undefined) query.set('since', String(since))
    if (epoch !== undefined) query.set('epoch', String(epoch))
    const response = await fetch(`${base}/pending?${query.toString()}`)
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

// 7. Every polling client learns when a prompt is settled by another one.
await withMount({ passwordTtlMs: 0 }, async ({ tool, getPending, post }) => {
  const execution = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const prompt = await getPending(5000)
  assert.equal(typeof prompt.body.revision, 'number', 'the pending view carries a revision')
  assert.equal(typeof prompt.body.epoch, 'string', 'the pending view carries the Host epoch')
  const revision = prompt.body.revision

  // Timing out with an unchanged revision keeps the same prompt instead of
  // reporting it settled.
  const started = Date.now()
  const timed = await getPending(300, revision, prompt.body.epoch)
  assert.ok(Date.now() - started >= 250, 'the long-poll honors the wait window')
  assert.equal(timed.body.id, prompt.body.id, 'an unchanged view keeps the pending prompt')
  assert.equal(timed.body.revision, revision, 'an unchanged view keeps the revision')

  // A second viewer that already observed this revision parks its long-poll;
  // answering must wake it promptly instead of letting it wait out the window.
  let watched = false
  let watchedAt = 0
  const watcher = getPending(20000, revision, prompt.body.epoch).then((value) => {
    watched = true
    watchedAt = Date.now()
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(watched, false, 'unchanged revision keeps the long-poll parked')

  const answeredAt = Date.now()
  const answeredResponse = await post('/answer', { id: prompt.body.id, password: PASSWORD })
  assert.equal(answeredResponse.status, 200)
  assert.ok(answeredResponse.body.revision > revision, 'the answer response carries the new revision')
  const answered = await watcher
  assert.ok(watchedAt - answeredAt < 1000, 'answer wakes the parked long-poll immediately')
  assert.equal(answered.body.id, undefined, 'the settled prompt is gone')
  assert.ok(answered.body.revision > revision, 'answer advances the revision')
  await execution

  // Cancelling from one viewer wakes the others the same way.
  const cancelled = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const cancelRejection = assert.rejects(cancelled, /cancelled by the user/)
  const cancelPrompt = await getPending(5000)
  let cancelWatched = false
  let cancelWatchedAt = 0
  const cancelWatcher = getPending(20000, cancelPrompt.body.revision, cancelPrompt.body.epoch)
    .then((value) => {
      cancelWatched = true
      cancelWatchedAt = Date.now()
      return value
    })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(cancelWatched, false, 'the cancel watcher parks first')
  const cancelPostedAt = Date.now()
  const cancelResponse = await post('/cancel', { id: cancelPrompt.body.id })
  assert.ok(cancelResponse.body.revision > cancelPrompt.body.revision, 'the cancel response carries the new revision')
  const afterCancel = await cancelWatcher
  assert.ok(cancelWatchedAt - cancelPostedAt < 1000, 'cancel wakes the parked long-poll immediately')
  assert.equal(afterCancel.body.id, undefined, 'the cancelled prompt is gone')
  assert.ok(afterCancel.body.revision > cancelPrompt.body.revision, 'cancel advances the revision')
  await cancelRejection

  // Stopping the turn withdraws the prompt and notifies the viewers too.
  const controller = new AbortController()
  const aborted = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: controller.signal })
  const abortRejection = assert.rejects(aborted, /aborted before the password was entered/)
  const abortPrompt = await getPending(5000)
  let abortWatched = false
  let abortWatchedAt = 0
  const abortWatcher = getPending(20000, abortPrompt.body.revision, abortPrompt.body.epoch)
    .then((value) => {
      abortWatched = true
      abortWatchedAt = Date.now()
      return value
    })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(abortWatched, false, 'the abort watcher parks first')
  const abortAt = Date.now()
  controller.abort()
  const afterAbort = await abortWatcher
  assert.ok(abortWatchedAt - abortAt < 1000, 'abort wakes the parked long-poll immediately')
  assert.equal(afterAbort.body.id, undefined, 'the withdrawn prompt is gone')
  assert.ok(afterAbort.body.revision > abortPrompt.body.revision, 'abort advances the revision')
  await abortRejection
  console.log('ok: settling a prompt notifies every polling client')
})

// 8. A restarted Host is recognized even when its revision matches the client's.
await withMount({ passwordTtlMs: 0 }, async ({ tool, getPending, post }) => {
  const execution = tool.execute({ host: 'aliyun', command: 'id -u' }, { signal: signal() })
  const rejection = assert.rejects(execution, /cancelled by the user/)
  const prompt = await getPending(5000)
  assert.equal(typeof prompt.body.epoch, 'string')

  // A client that learned revision R from one Host must not park on a different
  // Host that happens to be at the same revision.
  const started = Date.now()
  const mismatched = await getPending(20000, prompt.body.revision, 'a-different-host')
  assert.ok(Date.now() - started < 1000, 'an epoch mismatch returns without waiting')
  assert.equal(mismatched.body.id, prompt.body.id, 'the new Host view is delivered')
  assert.equal(mismatched.body.epoch, prompt.body.epoch, 'the Host epoch is echoed')

  // A Client from before the epoch field stays on revision-only semantics.
  const legacyStarted = Date.now()
  const legacyPoll = await getPending(300, prompt.body.revision)
  assert.ok(Date.now() - legacyStarted >= 250, 'a missing epoch keeps revision-only semantics')
  assert.equal(legacyPoll.body.id, prompt.body.id)

  await post('/cancel', { id: prompt.body.id })
  await rejection
  console.log('ok: a changed Host epoch short-circuits the revision wait')
})

process.env.PATH = originalPath
console.log('\nall host tests passed')
