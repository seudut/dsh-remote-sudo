/**
 * Client-half synchronization test without a browser:
 * mounts the real bundle against a fake Cordis context and a scripted Host, so
 * a prompt settled by another browser (answer, cancel, or withdrawal) removes
 * the stale panel here, a replacement prompt swaps panels, late views cannot
 * revive a settled panel, a restarted Host resets the revision space, and the
 * legacy no-revision Host still settles through low-rate rechecks.
 *
 * Assertions raised inside the poll loop are swallowed by its retry catch, so
 * the fake Host and publisher record failures in `errors` and the test asserts
 * that list at the end.
 */

import assert from 'node:assert/strict'

let registration
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}
globalThis.document = { activeElement: null }

const BOOT = 'boot-a'

/** Pending `/pending` responses the test has not delivered yet. */
const queued = []
/** In-flight long-polls waiting for the test to push a view. */
const parked = []
/** `since` query values the scripted client has polled with. */
const pendingSinces = []
/** `epoch` query values the scripted client has polled with. */
const pendingEpochs = []
/** Scripted non-2xx `/answer` response. */
let answerResponse
/** Failures recorded from inside the poll loop (its catch would swallow throws). */
const errors = []

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

function abortedError() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

let pendingRequests = 0

globalThis.fetch = (url, init = {}) => {
  const target = String(url)
  if (target.includes('/answer')) {
    assert.ok(answerResponse, 'the test scripts the /answer response first')
    const response = answerResponse
    answerResponse = undefined
    return Promise.resolve(response)
  }
  if (!target.includes('/pending')) {
    errors.push(new Error(`unexpected fetch: ${target}`))
    return new Promise(() => {})
  }
  pendingRequests += 1
  const query = new URL(target, 'http://localhost').searchParams
  pendingSinces.push(query.get('since'))
  pendingEpochs.push(query.get('epoch'))
  const next = queued.shift()
  if (next !== undefined) return Promise.resolve(jsonResponse(next))
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject }
    parked.push(entry)
    init.signal?.addEventListener('abort', () => {
      const index = parked.indexOf(entry)
      if (index >= 0) parked.splice(index, 1)
      reject(abortedError())
    }, { once: true })
  })
}

/** Deliver one Host `/pending` view to the scripted client. */
function pushPending(value) {
  const parkedEntry = parked.shift()
  if (parkedEntry !== undefined) parkedEntry.resolve(jsonResponse(value))
  else queued.push(value)
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

await import(`../client.js?test=${Date.now()}`)
assert.ok(registration, 'bundle registered')

const moduleFace = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error(`unexpected require: ${specifier}`)
})

const published = new Map()
const released = []
const disposers = []

const ctx = {
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
    registerPendingInteraction(precedence) {
      assert.equal(precedence({ kind: 'sudo-password' }), 3)
      assert.equal(precedence({ kind: 'approval' }), 0)
      return (interaction, delegate) => {
        if (published.has(interaction.key)) {
          errors.push(new Error(`duplicate publication: ${interaction.key}`))
          return () => {}
        }
        if (typeof delegate !== 'function') errors.push(new Error('publish delegate missing'))
        published.set(interaction.key, { interaction, delegate })
        return () => {
          published.delete(interaction.key)
          released.push(interaction.key)
        }
      }
    },
  },
}

moduleFace.apply(ctx)

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// 1. A prompt is published once; repeating the same view does not duplicate it.
pushPending({ id: 'p1', revision: 1, epoch: BOOT, host: 'aliyun', command: 'id -u' })
await waitFor(() => published.has('p1'), 'the first prompt is published')
await waitFor(
  () => pendingSinces.includes('1') && pendingEpochs.includes(BOOT),
  'the client keeps long-polling with the revision and epoch it observed',
)
pushPending({ id: 'p1', revision: 1, epoch: BOOT, host: 'aliyun', command: 'id -u' })
await tick()
assert.equal(published.size, 1, 'the same prompt is not published twice')
assert.deepEqual(released, [])

// 2. Answered in another browser: the Host view loses the prompt, so the local
// panel must settle even though nothing was submitted here.
pushPending({ revision: 2, epoch: BOOT })
await waitFor(() => !published.has('p1'), 'a settled prompt leaves the Host view')
await waitFor(
  () => pendingSinces.includes('2'),
  'the next long-poll carries the settled revision',
)
assert.deepEqual(released, ['p1'])
assert.equal(published.size, 0)

// 3. A newer prompt settles the stale panel before it is published.
pushPending({ id: 'p2', revision: 3, epoch: BOOT, host: 'aliyun', command: 'id -u' })
await waitFor(() => published.has('p2'), 'the next prompt is published')
pushPending({ id: 'p3', revision: 4, epoch: BOOT, host: 'aliyun', command: 'id -u' })
await waitFor(() => !published.has('p2') && published.has('p3'), 'a replacement settles the stale panel')
assert.equal(published.size, 1, 'only one panel stays published')
assert.ok(released.includes('p2'))

// 4. Losing the answer race (409) settles instead of pinning an error panel.
pushPending({ id: 'p4', revision: 5, epoch: BOOT, host: 'aliyun', command: 'id -u' })
await waitFor(() => published.has('p4'), 'the fourth prompt is published')
const racing = published.get('p4').interaction
answerResponse = jsonResponse({ error: 'no pending prompt with that id', revision: 6, epoch: BOOT }, 409)
await racing.answer('s3cret')
assert.equal(racing.settled, true, 'a 409 answer settles the prompt')
await waitFor(() => !published.has('p4'), 'the losing panel is removed')
assert.ok(released.includes('p4'))

// 4b. A stale in-flight view that predates the answer response cannot revive it.
pushPending({ id: 'p4', revision: 5, epoch: BOOT, host: 'aliyun', command: 'id -u' })
await tick()
assert.equal(published.has('p4'), false, 'an older view does not revive a settled prompt')
pushPending({ revision: 6, epoch: BOOT })
await waitFor(() => parked.length > 0, 'the poll loop continues after the stale view')

// 5. A restarted Host (new epoch) resets the revision space and shows its prompt.
pushPending({ id: 'p5', revision: 1, epoch: 'boot-b', host: 'aliyun', command: 'id -u' })
await waitFor(() => published.has('p5'), 'the restarted Host prompt is published')
await waitFor(
  () => pendingEpochs.includes('boot-b') && pendingSinces.includes('1'),
  'the client polls the restarted Host with its new revision space',
)
pushPending({ revision: 2, epoch: 'boot-b' })
await waitFor(() => !published.has('p5'), 'the restarted Host view settles the prompt')

// 6. A legacy Host without revisions still settles through low-rate rechecks.
pushPending({ id: 'p6', host: 'aliyun', command: 'id -u' })
await waitFor(() => published.has('p6'), 'the legacy Host prompt is published')
pushPending({})
await waitFor(() => !published.has('p6'), 'a legacy Host view without the prompt settles it', 5000)

// 7. The poll loop survives and unmount stops it.
await waitFor(() => parked.length > 0, 'the long-poll keeps running')
const beforeDispose = pendingRequests
for (const dispose of disposers) dispose()
await tick()
assert.equal(parked.length, 0, 'unmount aborts the in-flight long-poll')
assert.equal(pendingRequests, beforeDispose, 'unmount stops polling')
assert.deepEqual(errors, [], 'the scripted Host and publisher recorded no failures')

console.log('ok: cross-browser settlement reconciles the client panel')
