/**
 * dsh-remote-sudo — Client half.
 *
 * Long-polls the Host route for a pending sudo prompt and the pending-set
 * revision, publishes it as a `uiSession` pending interaction, and takes over
 * `conversation.composer` exactly like the approval panel: the prompt replaces
 * the composer while it is pending. Because the Host is polled even while a
 * panel is open, a prompt answered or cancelled by another browser (a phone
 * through dsh-pocket, another tab) settles this panel instead of stranding it.
 * The password travels browser → Host over the same authenticated origin; it
 * never enters the session log or a tool call.
 */

window.__ModuleLoader__.load({
  id: 'dsh-remote-sudo',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const BASE = '/_dsh/dsh-remote-sudo'
    const POLL_WAIT_MS = 20000
    const RETRY_DELAY_MS = 2000
    const LEGACY_RECHECK_MS = 2000
    const KIND = 'sudo-password'
    const NS = 'dsh-remote-sudo'

    /** Simplified Chinese dictionary. */
    const zh = {
      aria: 'sudo 授权',
      strip: '需要 sudo 密码',
      headline: '在 {host} 上以 root 执行',
      placeholder: 'sudo 密码',
      cancel: '取消',
      run: '执行',
      running: '执行中…',
      'error.expired': '这次授权已过期，请重新发起',
      'error.empty': '请输入密码',
      'error.failed': '提交失败，请重试',
    }

    /** English dictionary. */
    const en = {
      aria: 'sudo authorization',
      strip: 'sudo password required',
      headline: 'Run as root on {host}',
      placeholder: 'sudo password',
      cancel: 'Cancel',
      run: 'Run',
      running: 'Running…',
      'error.expired': 'This authorization expired. Start it again.',
      'error.empty': 'Enter a password.',
      'error.failed': 'Could not submit. Try again.',
    }

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '8px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 12px',
      },
      card: {
        width: '100%',
        maxWidth: 'var(--dsh-chat-content-width, 760px)',
        overflow: 'hidden',
        border: '1px solid var(--dsw-alias-state-warn-secondary, rgba(214, 158, 46, 0.35))',
        borderRadius: 'var(--dsw-radius-xl, 14px)',
        background: 'var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2, #1e1e22))',
        boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(0, 0, 0, 0.25))',
        color: 'var(--dsw-alias-label-primary, #f3f3f3)',
        font: '14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
      },
      strip: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 16px',
        background: 'var(--dsw-alias-state-warn-tertiary, rgba(214, 158, 46, 0.12))',
        color: 'var(--dsw-alias-state-warn-primary, #d69e2e)',
        fontSize: '13px',
        lineHeight: '18px',
      },
      dot: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: 'currentColor',
        flexShrink: 0,
      },
      body: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px 16px 0',
        maxHeight: 'var(--dsh-composer-text-max-height, 40vh)',
        overflowY: 'auto',
      },
      headline: {
        fontSize: '15px',
        fontWeight: 500,
        lineHeight: '24px',
      },
      command: {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: '13px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-tertiary, #9a9aa3)',
        wordBreak: 'break-all',
        whiteSpace: 'pre-wrap',
      },
      description: {
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary, #b9b9c0)',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 12px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35))',
        background: 'var(--dsw-alias-bg-base, rgba(0, 0, 0, 0.2))',
        color: 'inherit',
        fontSize: '14px',
        outline: 'none',
      },
      error: {
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
        fontSize: '12px',
      },
      actionRow: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '8px',
        padding: '14px 16px',
      },
      reject: {
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.3))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #b9b9c0)',
        fontSize: '13px',
        cursor: 'pointer',
      },
      accept: {
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-button-primary-fill, #3b82f6)',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
      },
    }

    /** One published prompt; the composer panel drives answer/cancel. */
    class SudoPrompt {
      constructor(value, noteHostState) {
        this.kind = KIND
        this.key = value.id
        this.id = value.id
        this.host = value.host
        this.command = value.command
        this.description = value.description
        this.sessionId = value.sessionId
        this.noteHostState = noteHostState
        this.settled = false
        this.completion = new Promise((resolve) => {
          this.resolveCompletion = resolve
        })
      }

      settle() {
        if (this.settled) return
        this.settled = true
        this.resolveCompletion()
      }

      async answer(password) {
        if (this.settled) return
        const response = await fetch(`${BASE}/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: this.id, password }),
        })
        const body = await response.json().catch(() => null)
        this.noteHostState?.(body)
        if (!response.ok) {
          if (response.status === 409) {
            // Another browser answered first or the Host already withdrew the
            // prompt: the panel must go away instead of showing an error.
            this.settle()
            return
          }
          throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
        }
        this.settle()
      }

      async cancel() {
        if (this.settled) return
        try {
          const response = await fetch(`${BASE}/cancel`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: this.id }),
          })
          const body = await response.json().catch(() => null)
          this.noteHostState?.(body)
        } catch {
          // The Host may already have dropped the prompt; cancelling is best effort.
        }
        this.settle()
      }
    }

    function SudoPromptPanel(props) {
      const prompt = props.matched
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [password, setPassword] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const inputRef = useRef(null)
      const rootRef = useRef(null)

      useEffect(() => {
        if (inputRef.current !== null) inputRef.current.focus()
      }, [])

      const describeError = useCallback((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (message.includes('no pending prompt')) return t('error.expired')
        if (message.includes('password required')) return t('error.empty')
        return t('error.failed')
      }, [t])

      const cancel = useCallback(async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          await prompt.cancel()
        } catch (cause) {
          setError(describeError(cause))
        } finally {
          setBusy(false)
        }
      }, [prompt, busy, describeError])

      const submit = useCallback(async () => {
        if (busy || password.length === 0) return
        setBusy(true)
        setError(null)
        try {
          await prompt.answer(password)
        } catch (cause) {
          setError(describeError(cause))
        } finally {
          setBusy(false)
        }
      }, [prompt, busy, password, describeError])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          const root = rootRef.current
          if (root !== null && !root.contains(document.activeElement)) return
          event.preventDefault()
          cancel()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [cancel])

      return h(
        'div',
        { ref: rootRef, style: S.root },
        h(
          'div',
          { style: S.card, role: 'group', 'aria-label': t('aria') },
          h('div', { style: S.strip }, h('span', { style: S.dot }), t('strip')),
          h(
            'div',
            { style: S.body },
            h('div', { style: S.headline }, t('headline', { host: prompt.host })),
            h('div', { style: S.command }, prompt.command),
            prompt.description ? h('div', { style: S.description }, prompt.description) : null,
            h('input', {
              ref: inputRef,
              type: 'password',
              value: password,
              autoComplete: 'off',
              spellCheck: false,
              placeholder: t('placeholder'),
              disabled: busy,
              style: S.input,
              onChange: (event) => setPassword(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submit()
                }
              },
            }),
            error ? h('div', { style: S.error }, error) : null,
          ),
          h(
            'div',
            { style: S.actionRow },
            h('button', { type: 'button', style: S.reject, disabled: busy, onClick: cancel }, t('cancel')),
            h(
              'button',
              { type: 'button', style: S.accept, disabled: busy || password.length === 0, onClick: submit },
              busy ? t('running') : t('run'),
            ),
          ),
        ),
      )
    }

    return {
      inject: ['locale', 'slots', 'uiSession'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-sudo: dictionaries')
        const publish = ctx.uiSession.registerPendingInteraction((pending) =>
          pending.kind === KIND ? 3 : 0,
        )
        const controller = new AbortController()
        let active = null
        let revision = -1
        let epoch = null
        /** Prompt ids settled here; a late view must not revive them. */
        const settledIds = new Set()

        /** Remember one settled prompt id, keeping the set bounded. */
        function rememberSettled(id) {
          settledIds.add(id)
          if (settledIds.size > 50) settledIds.delete(settledIds.values().next().value)
        }

        /**
         * Apply the Host identity and revision carried by a view or an
         * answer/cancel response.
         * @param {unknown} value Host body with optional `epoch`/`revision`.
         * @returns {boolean} false when this is an older view that was already
         *   in flight when a newer revision was learned; it must not revive a
         *   settled panel.
         */
        function applyHostState(value) {
          if (value === null || typeof value !== 'object') return true
          const nextEpoch = typeof value.epoch === 'string' ? value.epoch : undefined
          const epochChanged = nextEpoch !== undefined && epoch !== null && nextEpoch !== epoch
          if (epochChanged) {
            // A restarted Host starts a new revision space; drop the old one.
            revision = -1
            settledIds.clear()
          }
          if (nextEpoch !== undefined) epoch = nextEpoch
          const viewRevision = Number.isSafeInteger(value.revision) && value.revision >= 0
            ? value.revision
            : undefined
          if (viewRevision === undefined) return true
          if (viewRevision < revision && !epochChanged) return false
          revision = viewRevision
          return true
        }

        /**
         * Reconcile one Host view with the panel this browser shows. The Host
         * is authoritative: when the prompt disappears, another browser
         * answered, cancelled, or withdrew it, and this panel must settle
         * instead of waiting for an answer that will never come.
         * @param {unknown} value decoded `/pending` body.
         */
        function reconcile(value) {
          const view = value !== null && typeof value === 'object' ? value : {}
          if (!applyHostState(view)) return
          const next = typeof view.id === 'string' ? view : null
          if (active !== null && (next === null || next.id !== active.id)) {
            const stale = active
            active = null
            rememberSettled(stale.id)
            stale.settle()
          }
          if (next !== null && active === null && !settledIds.has(next.id)) {
            const sessionId = typeof next.sessionId === 'string'
              ? next.sessionId
              : ctx.uiSession.current?.value?.key
            const prompt = new SudoPrompt({ ...next, sessionId }, applyHostState)
            active = prompt
            const remove = publish(prompt, () => prompt.settle())
            prompt.completion.then(() => {
              rememberSettled(prompt.id)
              if (active === prompt) active = null
              remove()
            })
          }
        }

        async function poll() {
          while (!controller.signal.aborted) {
            try {
              const query = `wait=${POLL_WAIT_MS}&since=${revision}&epoch=${encodeURIComponent(epoch ?? '')}`
              const response = await fetch(`${BASE}/pending?${query}`, {
                signal: controller.signal,
                headers: { accept: 'application/json' },
                cache: 'no-store',
              })
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              const value = await response.json()
              reconcile(value)
              if (active !== null && !Number.isSafeInteger(value?.revision)) {
                // A Host without revisions cannot push settlement: re-check at a
                // low rate so another browser's answer still settles this panel.
                await new Promise((resolve) => setTimeout(resolve, LEGACY_RECHECK_MS))
              }
            } catch {
              if (controller.signal.aborted) return
              await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
            }
          }
        }

        poll()

        ctx.effect(() => () => {
          controller.abort()
        }, 'dsh-remote-sudo: pending poll')

        ctx.slots.inject('conversation.composer', () => ctx.slots.register({
          name: 'conversation.composer',
          priority: 2,
          locale: NS,
          select: ({ pendingInteraction }) =>
            pendingInteraction !== undefined && pendingInteraction.kind === KIND ? pendingInteraction : null,
        }, SudoPromptPanel))
      },
    }
  },
})
