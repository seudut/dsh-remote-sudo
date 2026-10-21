/**
 * dsh-sudo-askpass — Host half.
 *
 * Registers the `remote_sudo` tool and the `/_dsh/dsh-sudo-askpass/*` route the
 * Client half uses to fetch a pending password prompt and submit the password.
 *
 * Password handling: the password lives only in this process's memory and in
 * the ssh child's stdin. It is never placed in the tool call, the session log,
 * the tool result, the environment, argv, or a file. The remote command runs
 * with stdin redirected to /dev/null so a password that sudo did not need can
 * never be read by the command.
 *
 * Caching: the default `sudo` mode delegates to sudo's own timestamp. A
 * preflight `sudo -n true` decides whether a prompt is needed, exactly like a
 * terminal: the first call asks, later calls inside the sudo timeout run
 * without asking. `password` mode adds a host-memory password cache for hosts
 * whose sudo cannot reuse a no-TTY timestamp. `none` forces a prompt per call
 * and invalidates the remote timestamp afterwards.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const ROUTE_PREFIX = '/_dsh/dsh-sudo-askpass'
const MAX_BODY_BYTES = 16 * 1024
const MAX_OUTPUT_CHARS = 20000
const PROBE_TIMEOUT_MS = 20000
const INVALIDATE_TIMEOUT_MS = 15000

export const name = 'dsh-sudo-askpass'
export const inject = ['tools', 'webServer', 'connection']

const TOOL_DESCRIPTION = [
  'Run a command with sudo on a remote host over SSH.',
  'DSH opens a password prompt only when sudo needs a password; the password is fed to sudo over stdin and is never stored, logged, or returned.',
  'If sudo already holds a valid timestamp, the command runs without prompting.',
  'Use this instead of bash for any remote command that needs root, for example apt-get, dpkg, systemctl on a VPS.',
  'The host argument is an SSH host alias from ~/.ssh/config (for example "aliyun").',
  'SSH must authenticate with a key (BatchMode=yes is passed), so this tool never asks for an SSH password.',
].join(' ')

const SYSTEM_PROMPT_SECTION = [
  'Remote root commands: when a command on another machine needs sudo, call `remote_sudo` with the SSH host alias and the root command.',
  'Do not run `ssh <host> sudo ...` through bash: it has no TTY and cannot receive the password.',
  'The password prompt appears in the DSH UI; never ask the user to paste a password into chat.',
].join(' ')

/**
 * Quote one string for POSIX sh so it survives ssh's remote command parsing.
 * @param {string} value raw command text.
 * @returns {string} single-quoted shell word.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Send a JSON body without leaking internals to the browser.
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON-serializable payload.
 */
function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Read a bounded request body as UTF-8.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {number} limit maximum bytes.
 * @returns {Promise<string>} decoded body.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Clamp a numeric option.
 * @param {unknown} value raw config value.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @param {number} fallback value used when the input is not a finite number.
 * @returns {number} sanitized value.
 */
function numberOption(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

/**
 * Resolve the plugin row's config with safe defaults.
 * @param {unknown} config raw row config.
 * @returns {{cacheMode: 'sudo'|'password'|'none', promptTimeoutMs: number, passwordTtlMs: number, commandTimeoutMs: number, sudoPath: string}} options
 */
function readOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const cacheMode = raw.cacheMode === 'password' || raw.cacheMode === 'none' ? raw.cacheMode : 'sudo'
  const sudoPath = typeof raw.sudoPath === 'string' && /^\/[^\s]+$/.test(raw.sudoPath) ? raw.sudoPath : '/usr/bin/sudo'
  return {
    cacheMode,
    promptTimeoutMs: numberOption(raw.promptTimeoutMs, 5000, 600000, 120000),
    passwordTtlMs: numberOption(raw.passwordTtlMs, 0, 3600000, 300000),
    commandTimeoutMs: numberOption(raw.commandTimeoutMs, 1000, 3600000, 600000),
    sudoPath,
  }
}

/**
 * Build the remote command. The command itself runs with stdin from /dev/null:
 * sudo reads the password from the ssh pipe before exec'ing the shell, so a
 * leftover password line can never reach the root command.
 * @param {{sudoPath: string, usePassword: boolean, command: string}} input command parts.
 * @returns {string} remote shell command.
 */
function buildRemoteCommand(input) {
  const flag = input.usePassword ? `-S -p ''` : '-n'
  const inner = `exec 0</dev/null; ${input.command}`
  return `${input.sudoPath} ${flag} -- sh -c ${shellQuote(inner)}`
}

/**
 * Spawn one ssh child with the shared non-interactive options.
 * @param {string} host SSH host alias.
 * @param {string} remote remote command string.
 * @param {import('node:child_process').StdioOptions} stdio stdio wiring.
 * @returns {import('node:child_process').ChildProcess} child.
 */
function spawnSsh(host, remote, stdio) {
  return spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remote], { stdio })
}

/**
 * Append a chunk while keeping only the tail of the stream.
 * @param {string} current accumulated text.
 * @param {Buffer|string} chunk new data.
 * @returns {string} bounded text.
 */
function appendCapped(current, chunk) {
  const next = current + chunk.toString('utf8')
  return next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next
}

/**
 * Format one completed remote invocation for the model.
 * @param {string} host SSH host alias.
 * @param {string} command root command text.
 * @param {{stdout: string, stderr: string, code: number|null, signalName: string|null}} result completed run.
 * @returns {string} tool result.
 */
function formatResult(host, command, result) {
  const lines = [`remote_sudo ${host}: ${command}`]
  if (result.stdout.trim().length > 0) lines.push(result.stdout.trimEnd())
  if (result.stderr.trim().length > 0) lines.push('[stderr]', result.stderr.trimEnd())
  lines.push(result.signalName ? `[killed by ${result.signalName}]` : `[exit code: ${result.code}]`)
  return lines.join('\n')
}

/**
 * Run one remote sudo command. `password` is written to ssh's stdin and then
 * dropped; it is never included in argv, env, the result, or logs.
 * @param {{host: string, remote: string, password: string, timeoutMs: number, signal?: AbortSignal}} input invocation.
 * @returns {Promise<{stdout: string, stderr: string, code: number|null, signalName: string|null}>} completed run.
 */
function runRemoteSudo(input) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnSsh(input.host, input.remote, ['pipe', 'pipe', 'pipe'])
    } catch (error) {
      reject(new Error(`cannot start ssh: ${error instanceof Error ? error.message : String(error)}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      finish()
      child.kill('SIGKILL')
      reject(new Error(`remote command timed out after ${Math.round(input.timeoutMs / 1000)}s`))
    }, input.timeoutMs)
    const onAbort = () => {
      child.kill('SIGKILL')
      finish()
      reject(new Error('remote_sudo was aborted'))
    }

    function finish() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
    }

    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => {
      stdout = appendCapped(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendCapped(stderr, chunk)
    })
    child.stdin.on('error', () => {
      // ssh may close stdin before the write lands (auth failure); the exit code carries the reason.
    })
    child.on('error', (error) => {
      finish()
      reject(new Error(`cannot start ssh: ${error.message}`))
    })
    child.on('close', (code, signalName) => {
      finish()
      resolve({ stdout, stderr, code, signalName })
    })

    if (input.password.length > 0) child.stdin.end(`${input.password}\n`)
    else child.stdin.end()
  })
}

/**
 * Decide whether sudo needs a password on the remote host.
 * @param {{host: string, sudoPath: string, signal?: AbortSignal}} input probe input.
 * @returns {Promise<'ticket'|'password'>} whether a valid timestamp exists.
 */
function probeTicket(input) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnSsh(input.host, `LC_ALL=C ${input.sudoPath} -n true`, ['ignore', 'pipe', 'pipe'])
    } catch (error) {
      reject(new Error(`cannot start ssh: ${error instanceof Error ? error.message : String(error)}`))
      return
    }

    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      finish()
      child.kill('SIGKILL')
      reject(new Error('sudo preflight timed out'))
    }, PROBE_TIMEOUT_MS)
    const onAbort = () => {
      child.kill('SIGKILL')
      finish()
      reject(new Error('remote_sudo was aborted'))
    }

    function finish() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
    }

    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', (chunk) => {
      stderr = appendCapped(stderr, chunk)
    })
    child.on('error', (error) => {
      finish()
      reject(new Error(`cannot start ssh: ${error.message}`))
    })
    child.on('close', (code) => {
      finish()
      if (code === 0) {
        resolve('ticket')
        return
      }
      const text = stderr.toLowerCase()
      if (text.includes('password is required') || text.includes('no password was provided')) {
        resolve('password')
        return
      }
      reject(new Error(`sudo preflight failed: ${stderr.trim() || `ssh exit ${code}`}`))
    })
  })
}

/**
 * Invalidate the remote sudo timestamp (used by `cacheMode: none`).
 * @param {{host: string, sudoPath: string}} input invalidation target.
 * @returns {Promise<void>} completion; failures are ignored.
 */
function invalidateTicket(input) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnSsh(input.host, `${input.sudoPath} -k`, 'ignore')
    } catch {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, INVALIDATE_TIMEOUT_MS)
    child.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Install the tool, the web route, and the prompt section.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config row config.
 */
export function apply(ctx, config = {}) {
  const options = readOptions(config)

  /** @type {Map<string, {id: string, host: string, command: string, description?: string, sessionId?: string, createdAt: number, resolve: (password: string) => void, reject: (error: Error) => void}>} */
  const pending = new Map()
  /** @type {Set<() => void>} */
  const waiters = new Set()
  /** @type {Map<string, {value: string, expiresAt: number}>} */
  const cachedPasswords = new Map()

  function snapshot() {
    const first = pending.values().next().value
    if (first === undefined) return null
    return {
      id: first.id,
      host: first.host,
      command: first.command,
      ...(first.description === undefined ? {} : { description: first.description }),
      ...(first.sessionId === undefined ? {} : { sessionId: first.sessionId }),
      createdAt: first.createdAt,
      count: pending.size,
    }
  }

  function wakeWaiters() {
    for (const wake of [...waiters]) wake()
  }

  /**
   * Resolve with the current or next prompt, or null after the wait.
   * @param {number} ms maximum wait.
   * @param {import('node:http').IncomingMessage} req request used to stop early.
   * @returns {Promise<ReturnType<typeof snapshot>>} prompt snapshot.
   */
  function waitForPrompt(ms, req) {
    const now = snapshot()
    if (now !== null || ms <= 0) return Promise.resolve(now)
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(finish)
        req.removeListener('close', finish)
        resolve(snapshot())
      }
      const timer = setTimeout(finish, ms)
      waiters.add(finish)
      req.once('close', finish)
    })
  }

  /**
   * Ask the browser for one password and wait for the answer.
   * @param {{host: string, command: string, description?: string, sessionId?: string, signal?: AbortSignal}} request prompt content.
   * @returns {Promise<string>} the submitted password.
   */
  function requestPassword(request) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('sudo password prompt timed out'))
      }, options.promptTimeoutMs)
      const entry = {
        id,
        host: request.host,
        command: request.command,
        ...(request.description === undefined ? {} : { description: request.description }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        createdAt: Date.now(),
        resolve: (value) => {
          clearTimeout(timer)
          pending.delete(id)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        },
      }
      pending.set(id, entry)
      wakeWaiters()
      request.signal?.addEventListener('abort', () => {
        entry.reject(new Error('remote_sudo was aborted before the password was entered'))
      }, { once: true })
    })
  }

  async function handleRoute(req, res) {
    let method = ''
    try {
      const rejection = typeof ctx.connection.requestRejection === 'function'
        ? ctx.connection.requestRejection(req)
        : undefined
      if (rejection !== undefined) {
        sendJson(res, rejection, { error: rejection === 401 ? 'authentication required' : 'request rejected' })
        return
      }

      const url = new URL(req.url || '/', 'http://localhost')
      if (!url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      method = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1))

      if (method === 'pending') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'pending requires GET' })
          return
        }
        const requested = Number(url.searchParams.get('wait') ?? '0')
        const wait = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 25000) : 0
        const prompt = await waitForPrompt(wait, req)
        sendJson(res, 200, prompt ?? {})
        return
      }

      if (method === 'answer') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'answer requires POST' })
          return
        }
        const body = JSON.parse(await readBody(req, MAX_BODY_BYTES) || '{}')
        const id = typeof body?.id === 'string' ? body.id : ''
        const password = typeof body?.password === 'string' ? body.password : ''
        const entry = pending.get(id)
        if (entry === undefined) {
          sendJson(res, 409, { error: 'no pending prompt with that id' })
          return
        }
        if (password.length === 0) {
          sendJson(res, 400, { error: 'password required' })
          return
        }
        entry.resolve(password)
        sendJson(res, 200, { ok: true })
        return
      }

      if (method === 'cancel') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'cancel requires POST' })
          return
        }
        const body = JSON.parse(await readBody(req, MAX_BODY_BYTES) || '{}')
        const id = typeof body?.id === 'string' ? body.id : ''
        const entry = pending.get(id)
        if (entry === undefined) {
          sendJson(res, 409, { error: 'no pending prompt with that id' })
          return
        }
        entry.reject(new Error('sudo password prompt was cancelled by the user'))
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { error: `unknown method: ${method}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, message === 'request body too large' ? 413 : 400, { error: message })
    }
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: handleRoute,
    })
    return () => dispose()
  }, 'dsh-sudo-askpass: web route')

  ctx.effect(() => () => {
    cachedPasswords.clear()
  }, 'dsh-sudo-askpass: password cache')

  ctx.effect(() => () => {
    for (const entry of [...pending.values()]) {
      entry.reject(new Error('dsh-sudo-askpass was unloaded'))
    }
    pending.clear()
    wakeWaiters()
  }, 'dsh-sudo-askpass: pending prompts')

  ctx.tools.register({
    name: 'remote_sudo',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: {
          type: 'string',
          description: 'SSH host alias from ~/.ssh/config, for example "aliyun".',
        },
        command: {
          type: 'string',
          description: 'Command to run as root on the remote host, for example "apt-get update".',
        },
        description: {
          type: 'string',
          description: 'Optional short label shown in the password prompt, for example "更新 apt 索引".',
        },
      },
      required: ['host', 'command'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const host = String(args.host ?? '').trim()
      const command = String(args.command ?? '').trim()
      if (host.length === 0 || !/^[A-Za-z0-9._@%+:-]+$/.test(host) || host.startsWith('-')) {
        throw new Error('remote_sudo: host must be an SSH host alias (letters, digits, dot, dash, underscore)')
      }
      if (command.length === 0 || command.includes('\u0000')) {
        throw new Error('remote_sudo: command is required')
      }

      const sessionId = typeof exec.agent?.session?.id === 'string' ? exec.agent.session.id : undefined
      const mode = options.cacheMode
      let ticket = false
      if (mode !== 'none') {
        ticket = await probeTicket({ host, sudoPath: options.sudoPath, signal: exec.signal }) === 'ticket'
      }

      let password = ''
      if (!ticket) {
        if (mode === 'password') {
          const cached = cachedPasswords.get(host)
          if (cached !== undefined && cached.expiresAt > Date.now()) password = cached.value
        }
        if (password.length === 0) {
          password = await requestPassword({
            host,
            command,
            description: typeof args.description === 'string' && args.description.trim().length > 0
              ? args.description.trim()
              : undefined,
            sessionId,
            signal: exec.signal,
          })
          if (mode === 'password' && options.passwordTtlMs > 0) {
            cachedPasswords.set(host, { value: password, expiresAt: Date.now() + options.passwordTtlMs })
          }
        }
      }

      const usePassword = !ticket && password.length > 0
      const remote = buildRemoteCommand({ sudoPath: options.sudoPath, usePassword, command })
      let result
      try {
        result = await runRemoteSudo({
          host,
          remote,
          password: usePassword ? password : '',
          timeoutMs: options.commandTimeoutMs,
          signal: exec.signal,
        })
      } finally {
        password = ''
        if (mode === 'none') await invalidateTicket({ host, sudoPath: options.sudoPath })
      }

      if (result.code !== 0) {
        // Conservative: any failure drops the cached password so the next call
        // asks again instead of replaying a possibly stale secret.
        cachedPasswords.delete(host)
      }

      return formatResult(host, command, result)
    },
  })

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => {
      const dispose = scope.systemPrompt.section({
        name: 'tool:remote-sudo',
        order: 10250,
        text: SYSTEM_PROMPT_SECTION,
      })
      return () => dispose()
    }, 'dsh-sudo-askpass: prompt section')
  })
}
