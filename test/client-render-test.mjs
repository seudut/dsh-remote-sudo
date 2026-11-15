/**
 * Client-half wiring test without a browser:
 * loads the real bundle through a fake module loader, mounts `apply` against a
 * fake Cordis context, checks the composer registration, and renders the panel
 * with a minimal React stub.
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
/** The single Host view the scripted long-poll delivers, then hangs. */
let served = false
globalThis.fetch = () => {
  if (served) return new Promise(() => {})
  served = true
  return Promise.resolve({
    ok: true,
    status: 200,
    async json() {
      return {
        id: 'p1',
        revision: 1,
        epoch: 'boot-a',
        host: 'aliyun',
        command: 'apt-get update',
        description: '更新索引',
      }
    },
  })
}
globalThis.document = { activeElement: null }

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
assert.equal(registration.id, 'dsh-remote-sudo')

const moduleFace = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error(`unexpected require: ${specifier}`)
})
assert.deepEqual(moduleFace.inject, ['locale', 'slots', 'uiSession'])

let precedence
let publish
let publishedPrompt
let slotOptions
let Panel
const disposers = []

const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  slots: {
    inject(owner, callback) {
      assert.equal(owner, 'conversation.composer')
      callback()
    },
    register(options, component) {
      slotOptions = options
      Panel = component
      return () => {}
    },
  },
  locale: {
    register(namespace, dictionaries) {
      assert.equal(namespace, 'dsh-remote-sudo')
      assert.ok(dictionaries.zh && dictionaries.en)
      return () => {}
    },
  },
  uiSession: {
    current: { value: { key: 'session-1' } },
    registerPendingInteraction(value) {
      precedence = value
      publish = (prompt, delegate) => {
        publishedPrompt = prompt
        assert.equal(typeof delegate, 'function')
        return () => {}
      }
      return publish
    },
  },
}

moduleFace.apply(ctx)

assert.equal(slotOptions.name, 'conversation.composer')
assert.equal(slotOptions.priority, 2)
assert.equal(slotOptions.locale, 'dsh-remote-sudo')
assert.equal(typeof slotOptions.select, 'function')

// Wait for the scripted Host view to publish the real SudoPrompt instance.
const deadline = Date.now() + 2000
while (publishedPrompt === undefined && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert.ok(publishedPrompt, 'the pending view published an interaction')
assert.equal(publishedPrompt.kind, 'approval', 'reports the shared approval kind')
assert.equal(publishedPrompt.toolName, 'remote_sudo', 'names the tool for notifications')
assert.equal(precedence(publishedPrompt), 3, 'our own prompt outranks other interactions')
assert.equal(precedence({ kind: 'approval' }), 0, 'a real approval keeps precedence 0')
assert.equal(precedence({ kind: 'sudo-password' }), 0, 'identity is the class, not the old kind')

const prompt = publishedPrompt
assert.equal(slotOptions.select({ pendingInteraction: prompt }), prompt)
assert.equal(slotOptions.select({ pendingInteraction: { kind: 'approval' } }), null)
assert.equal(slotOptions.select({}), null)

function walk(node, out) {
  if (node === null || node === undefined) return
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return
  }
  if (typeof node === 'object') {
    if (node.props?.['aria-label']) out.push(`aria:${node.props['aria-label']}`)
    if (node.props?.type === 'password') out.push('password-input')
    if (typeof node.props?.placeholder === 'string') out.push(`placeholder:${node.props.placeholder}`)
    walk(node.children, out)
  }
}

const dict = {
  aria: 'sudo 授权',
  strip: '需要 sudo 密码',
  headline: '在 {host} 上以 root 执行',
  placeholder: 'sudo 密码',
  cancel: '取消',
  run: '执行',
  running: '执行中…',
  'error.expired': '过期',
  'error.empty': '空密码',
  'error.failed': '失败',
}
const t = (key, vars) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars?.[name] ?? '')
const rendered = Panel({ matched: prompt, t })
const parts = []
walk(rendered, parts)
assert.ok(parts.includes('aria:sudo 授权'), 'panel aria label')
assert.ok(parts.includes('password-input'), 'password input')
assert.ok(parts.some((part) => part.includes('在 aliyun 上以 root 执行')), 'headline')
assert.ok(parts.includes('apt-get update'), 'command')
assert.ok(parts.includes('更新索引'), 'description')
assert.ok(parts.includes('需要 sudo 密码'), 'strip')
assert.ok(parts.includes('placeholder:sudo 密码'), 'placeholder')

const withoutDescription = Panel({ matched: { ...prompt, description: undefined }, t })
const parts2 = []
walk(withoutDescription, parts2)
assert.ok(!parts2.includes('更新索引'))

for (const dispose of disposers) dispose()
console.log('ok: composer registration, precedence, selection, and panel render')
