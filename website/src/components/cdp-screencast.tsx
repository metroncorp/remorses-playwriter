// CDP screencast viewer: connects to a raw Chrome DevTools Protocol WebSocket,
// streams Page.screencastFrame JPEG images onto a canvas, and relays mouse/keyboard
// input back via Input.dispatch* commands. Inspired by RedPlanetHQ/core's cdp-viewer.
'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/utils.ts'

// ── CdpClient ──────────────────────────────────────────────────────
// Minimal CDP client over a browser WebSocket. Handles id-based request/response
// correlation and per-sessionId event subscriptions.

type CdpListener = (method: string, params: unknown) => void

class CdpClient {
  private nextId = 1
  private pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>()
  private listeners = new Map<string, Set<CdpListener>>()

  constructor(private ws: WebSocket) {
    try {
      ws.binaryType = 'arraybuffer'
    } catch {
      /* some environments don't allow setting after construction */
    }
    ws.addEventListener('message', (e) => {
      this.onMessage(e)
    })
    // Reject all pending requests on socket close so they don't hang forever
    ws.addEventListener('close', () => {
      const err = new Error('WebSocket closed')
      for (const resolve of this.pending.values()) {
        resolve({ error: { message: err.message } })
      }
      this.pending.clear()
    })
  }

  private async onMessage(e: MessageEvent): Promise<void> {
    let data: string
    if (typeof e.data === 'string') {
      data = e.data
    } else if (e.data instanceof ArrayBuffer) {
      data = new TextDecoder().decode(e.data)
    } else if (typeof Blob !== 'undefined' && e.data instanceof Blob) {
      data = await e.data.text()
    } else {
      return
    }

    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string }
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }

    // Response to a send() call
    if (typeof msg.id === 'number') {
      const r = this.pending.get(msg.id)
      if (r) {
        this.pending.delete(msg.id)
        r({ result: msg.result, error: msg.error })
      }
      return
    }

    // Event dispatch
    const sid = msg.sessionId ?? ''
    const subs = this.listeners.get(sid)
    if (subs) {
      for (const sub of subs) sub(msg.method!, msg.params)
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    const frame = JSON.stringify({ id, method, params, sessionId })
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error) {
          reject(new Error(msg.error.message))
        } else {
          resolve(msg.result as T)
        }
      })
      this.ws.send(frame)
    })
  }

  on(sessionId: string, listener: CdpListener): () => void {
    let set = this.listeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => set!.delete(listener)
  }
}

/** Bitmask matching CDP Input.dispatchKeyEvent.modifiers. */
function eventModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}

// ── Mac editor command mapping ─────────────────────────────────────
// AppKit translates Cmd+Backspace, Alt+Left, etc. before the renderer sees
// them. Headless Chromium only gets raw key+modifiers, so we attach Blink
// editor command names explicitly via CDP's `commands` array.

function macEditorCommands(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): string[] {
  const sel = e.shiftKey ? 'AndModifySelection' : ''
  if (e.metaKey && !e.ctrlKey && !e.altKey) {
    switch (e.key) {
      case 'Backspace':
        return ['DeleteToBeginningOfLine']
      case 'Delete':
        return ['DeleteToEndOfLine']
      case 'ArrowLeft':
        return [`MoveToBeginningOfLine${sel}`]
      case 'ArrowRight':
        return [`MoveToEndOfLine${sel}`]
      case 'ArrowUp':
        return [`MoveToBeginningOfDocument${sel}`]
      case 'ArrowDown':
        return [`MoveToEndOfDocument${sel}`]
    }
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    switch (e.key) {
      case 'Backspace':
        return ['DeleteWordBackward']
      case 'Delete':
        return ['DeleteWordForward']
      case 'ArrowLeft':
        return [`MoveWordLeft${sel}`]
      case 'ArrowRight':
        return [`MoveWordRight${sel}`]
    }
  }
  return []
}

// ── useCdpScreencast hook ──────────────────────────────────────────

type ScreencastStatus = 'connecting' | 'running' | 'ended' | 'error'

interface ScreencastFrameParams {
  data: string // base64 jpeg
  sessionId: number // CDP screencast ack id (not Target sessionId)
  metadata: {
    offsetTop?: number
    pageScaleFactor?: number
    deviceWidth?: number
    deviceHeight?: number
    scrollOffsetX?: number
    scrollOffsetY?: number
    timestamp?: number
  }
}

interface Viewport {
  width: number
  height: number
  dpr: number
}

interface NavigationHistory {
  currentIndex: number
  entries: Array<{ id: number; url: string; title: string; transitionType: string }>
}

interface ScreencastApi {
  status: ScreencastStatus
  errorMsg: string
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  pageUrl: string
  navigate: (url: string) => void
  goBack: () => void
  goForward: () => void
  reload: () => void
  dispatchMouse: (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', e: React.MouseEvent<HTMLCanvasElement>) => void
  dispatchWheel: (e: WheelEvent) => void
  dispatchKey: (type: 'keyDown' | 'keyUp' | 'char', e: KeyboardEvent) => void
  reconnect: () => void
  setViewport: (width: number, height: number, dpr: number) => void
}

/**
 * Connect to Chrome DevTools Protocol over WebSocket and stream
 * Page.screencastFrame images into a canvas. Exposes mouse/keyboard
 * dispatch helpers for interactive control.
 *
 * Flow:
 *   1. Open WebSocket -> wrap with CdpClient
 *   2. Target.setDiscoverTargets + Target.getTargets -> find page target
 *   3. Target.attachToTarget {flatten:true} -> get sessionId
 *   4. Page.enable for navigation events
 *   5. Wire Page.screencastFrame listener
 *   6. Page.startScreencast -> Chromium begins emitting JPEG frames
 *   7. Each frame ack'd via Page.screencastFrameAck
 */
function useCdpScreencast({ wsUrl, quality = 70, maxWidth = 1280 }: { wsUrl: string; quality?: number; maxWidth?: number }): ScreencastApi {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cdpRef = useRef<CdpClient | null>(null)
  const pageSessionRef = useRef<string>('')
  const viewportRef = useRef<Viewport | null>(null)

  const [status, setStatus] = useState<ScreencastStatus>('connecting')
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [pageUrl, setPageUrl] = useState<string>('')
  const [reconnectKey, setReconnectKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setStatus('connecting')
    setErrorMsg('')

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : `Invalid WebSocket URL: ${wsUrl}`)
      return
    }
    const cdp = new CdpClient(ws)
    cdpRef.current = cdp

    ws.addEventListener('error', () => {
      if (cancelled) return
      setStatus('error')
      setErrorMsg('Connection error')
    })
    ws.addEventListener('close', () => {
      if (cancelled) return
      setStatus((s) => {
        return s === 'error' ? s : 'ended'
      })
    })

    ws.addEventListener('open', async () => {
      if (cancelled) return
      try {
        await cdp.send('Target.setDiscoverTargets', { discover: true })
        const { targetInfos } = await cdp.send<{
          targetInfos: Array<{ targetId: string; type: string; url?: string }>
        }>('Target.getTargets')
        const pageTarget = targetInfos.find((t) => {
          return t.type === 'page'
        })
        if (!pageTarget) throw new Error('No page target found')

        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
          targetId: pageTarget.targetId,
          flatten: true,
        })
        pageSessionRef.current = sessionId

        await cdp.send('Page.enable', {}, sessionId)
        if (pageTarget.url && !cancelled) setPageUrl(pageTarget.url)

        // Track navigation
        cdp.on(sessionId, (method, params) => {
          if (method !== 'Page.frameNavigated') return
          const p = params as { frame: { id: string; parentId?: string; url: string } }
          if (!p.frame.parentId && !cancelled) setPageUrl(p.frame.url)
        })

        // Wire frame listener BEFORE startScreencast (Chromium can emit first frame synchronously)
        cdp.on(sessionId, (method, params) => {
          if (method !== 'Page.screencastFrame') return
          const p = params as ScreencastFrameParams
          // Ack immediately so Chromium keeps shipping frames
          cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sessionId).catch(() => {})

          const canvas = canvasRef.current
          if (!canvas) return
          // Decode off main thread via createImageBitmap (avoids base64 data URL jank)
          const bin = atob(p.data)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          const blob = new Blob([bytes], { type: 'image/jpeg' })
          createImageBitmap(blob)
            .then((bm) => {
              if (cancelled) {
                bm.close()
                return
              }
              const c = canvasRef.current
              if (!c) {
                bm.close()
                return
              }
              if (c.width !== bm.width || c.height !== bm.height) {
                c.width = bm.width
                c.height = bm.height
              }
              const ctx = c.getContext('2d')
              if (ctx) ctx.drawImage(bm, 0, 0)
              bm.close()
            })
            .catch(() => {})
        })

        // Apply any pre-set viewport
        const v = viewportRef.current
        if (v) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: false }, sessionId)
        }

        await cdp.send(
          'Page.startScreencast',
          {
            format: 'jpeg',
            quality,
            maxWidth: v ? Math.ceil(v.width * v.dpr) : maxWidth,
            maxHeight: v ? Math.ceil(v.height * v.dpr) : maxWidth * 2,
            everyNthFrame: 2,
          },
          sessionId,
        )

        if (!cancelled) setStatus('running')
      } catch (err) {
        if (cancelled) return
        setStatus('error')
        setErrorMsg(err instanceof Error ? err.message : String(err))
      }
    })

    return () => {
      cancelled = true
      try {
        ws.close()
      } catch {}
    }
  }, [wsUrl, reconnectKey, quality, maxWidth])

  // ── Navigation helpers ──────────────────────────────────────────

  const coerceUrl = (raw: string): string => {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
    if (/^[^\s/]+\.[^\s/]+/i.test(trimmed) && !trimmed.includes(' ')) {
      return `https://${trimmed}`
    }
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
  }

  const navigate = (url: string) => {
    const cdp = cdpRef.current
    const sid = pageSessionRef.current
    if (!cdp || !sid) return
    const target = coerceUrl(url)
    if (!target) return
    cdp.send('Page.navigate', { url: target }, sid).catch(() => {})
  }

  const reload = () => {
    const cdp = cdpRef.current
    const sid = pageSessionRef.current
    if (!cdp || !sid) return
    cdp.send('Page.reload', {}, sid).catch(() => {})
  }

  const stepHistory = async (delta: -1 | 1): Promise<void> => {
    const cdp = cdpRef.current
    const sid = pageSessionRef.current
    if (!cdp || !sid) return
    try {
      const hist = await cdp.send<NavigationHistory>('Page.getNavigationHistory', {}, sid)
      const target = hist.entries[hist.currentIndex + delta]
      if (!target) return
      await cdp.send('Page.navigateToHistoryEntry', { entryId: target.id }, sid)
    } catch {}
  }

  const goBack = () => {
    void stepHistory(-1)
  }
  const goForward = () => {
    void stepHistory(1)
  }

  // ── Input dispatch ──────────────────────────────────────────────

  // CDP Input.dispatchMouseEvent expects CSS pixels (matching the viewport set
  // via Emulation.setDeviceMetricsOverride), not DPR-scaled bitmap pixels.
  // On Retina (DPR 2), canvas.width is 2x the CSS rect, so dividing by
  // canvas.width would send coordinates 2x too large. Instead we map the
  // pointer position proportionally to the viewport dimensions.
  const dispatchMouse = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', e: React.MouseEvent<HTMLCanvasElement>) => {
    const cdp = cdpRef.current
    const sid = pageSessionRef.current
    const canvas = canvasRef.current
    const viewport = viewportRef.current
    if (!cdp || !sid || !canvas || !viewport) return

    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * viewport.width
    const y = ((e.clientY - rect.top) / rect.height) * viewport.height

    cdp
      .send(
        'Input.dispatchMouseEvent',
        {
          type,
          x,
          y,
          button: type === 'mouseMoved' ? 'none' : e.button === 2 ? 'right' : 'left',
          clickCount: type === 'mouseReleased' || type === 'mousePressed' ? 1 : 0,
          modifiers: eventModifiers(e),
        },
        sid,
      )
      .catch(() => {})
  }

  const dispatchWheel = (e: WheelEvent) => {
    const cdp = cdpRef.current
    const sid = pageSessionRef.current
    const canvas = canvasRef.current
    const viewport = viewportRef.current
    if (!cdp || !sid || !canvas || !viewport) return

    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * viewport.width
    const y = ((e.clientY - rect.top) / rect.height) * viewport.height

    const lineHeight = 16
    const pageHeight = rect.height || 800
    const factor = e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? pageHeight : 1
    const deltaX = e.deltaX * factor
    const deltaY = e.deltaY * factor

    cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: eventModifiers(e) }, sid).catch(() => {})
  }

  const setViewport = useCallback(
    (width: number, height: number, dpr: number) => {
      const dprSafe = dpr > 0 ? dpr : 1
      const w = Math.max(1, Math.floor(width))
      const h = Math.max(1, Math.floor(height))
      const prev = viewportRef.current
      if (prev && prev.width === w && prev.height === h && prev.dpr === dprSafe) return
      viewportRef.current = { width: w, height: h, dpr: dprSafe }

      const cdp = cdpRef.current
      const sid = pageSessionRef.current
      if (!cdp || !sid) return

      cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dprSafe, mobile: false }, sid).catch(() => {})
      // Re-issue screencast at new resolution
      cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: Math.ceil(w * dprSafe), maxHeight: Math.ceil(h * dprSafe), everyNthFrame: 2 }, sid).catch(() => {})
    },
    [quality],
  )

  const dispatchKey = (type: 'keyDown' | 'keyUp' | 'char', e: KeyboardEvent) => {
    const cdp = cdpRef.current
    const sid = pageSessionRef.current
    if (!cdp || !sid) return
    const isPrintable = e.key.length === 1
    const cdpType = type === 'keyDown' && isPrintable ? 'rawKeyDown' : type
    const params: Record<string, unknown> = {
      type: cdpType,
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      modifiers: eventModifiers(e),
    }
    if (isPrintable) params.text = e.key
    if (type === 'keyDown') {
      const commands = macEditorCommands(e)
      if (commands.length > 0) params.commands = commands
    }
    cdp.send('Input.dispatchKeyEvent', params, sid).catch(() => {})
  }

  return {
    status,
    errorMsg,
    canvasRef,
    pageUrl,
    navigate,
    goBack,
    goForward,
    reload,
    dispatchMouse,
    dispatchWheel,
    dispatchKey,
    reconnect: () => {
      setReconnectKey((k) => {
        return k + 1
      })
    },
    setViewport,
  }
}

// ── CdpViewer component ────────────────────────────────────────────

interface CdpViewerProps {
  wsUrl: string
  quality?: number
  maxWidth?: number
}

export function CdpViewer({ wsUrl, quality = 70, maxWidth = 1280 }: CdpViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { status, errorMsg, canvasRef, pageUrl, navigate, goBack, goForward, reload, dispatchMouse, dispatchWheel, dispatchKey, reconnect, setViewport } =
    useCdpScreencast({ wsUrl, quality, maxWidth })

  // Resize remote viewport to match container (debounced)
  useEffect(() => {
    const node = containerRef.current
    if (!node) return

    let timer: ReturnType<typeof setTimeout> | null = null
    const apply = () => {
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      setViewport(Math.floor(rect.width), Math.floor(rect.height), window.devicePixelRatio || 1)
    }

    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(apply, 150)
    })
    ro.observe(node)
    apply()

    return () => {
      if (timer) clearTimeout(timer)
      ro.disconnect()
    }
  }, [setViewport])

  const [hasControl, setHasControl] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const urlInputRef = useRef<HTMLInputElement>(null)
  const isUrlFocusedRef = useRef(false)

  useEffect(() => {
    if (!isUrlFocusedRef.current) setUrlInput(pageUrl)
  }, [pageUrl])

  // Wire keyboard events when control is active
  useEffect(() => {
    if (!hasControl) return
    const node = containerRef.current
    if (!node) return

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      dispatchKey('keyDown', e)
      if (e.key.length === 1) dispatchKey('char', e)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault()
      dispatchKey('keyUp', e)
    }
    node.addEventListener('keydown', onKeyDown)
    node.addEventListener('keyup', onKeyUp)
    node.focus()
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      node.removeEventListener('keyup', onKeyUp)
    }
  }, [hasControl, dispatchKey])

  // Non-passive wheel binding so we can preventDefault and forward to remote
  useEffect(() => {
    if (!hasControl) return
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      dispatchWheel(e)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [hasControl, dispatchWheel, canvasRef])

  const isRunning = status === 'running'

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-white/10 bg-neutral-950 shadow-2xl shadow-black/50">
      {/* ── Toolbar ────────────────────────────────────────────── */}
      <form
        className="flex shrink-0 items-center gap-1.5 border-b border-white/10 bg-neutral-900 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!isRunning) return
          navigate(urlInput)
          urlInputRef.current?.blur()
        }}
      >
        {/* Traffic light dots */}
        <div className="mr-2 flex items-center gap-1.5">
          <div className="size-3 rounded-full bg-red-500/80" />
          <div className="size-3 rounded-full bg-yellow-500/80" />
          <div className="size-3 rounded-full bg-green-500/80" />
        </div>

        {/* Nav buttons */}
        <button
          type="button"
          className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          title="Back"
          onClick={goBack}
          disabled={!isRunning}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          type="button"
          className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          title="Forward"
          onClick={goForward}
          disabled={!isRunning}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
        <button
          type="button"
          className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          title="Reload"
          onClick={reload}
          disabled={!isRunning}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </button>

        {/* URL bar */}
        <input
          ref={urlInputRef}
          value={urlInput}
          onChange={(e) => {
            setUrlInput(e.target.value)
          }}
          onFocus={(e) => {
            isUrlFocusedRef.current = true
            e.currentTarget.select()
          }}
          onBlur={() => {
            isUrlFocusedRef.current = false
          }}
          placeholder={isRunning ? 'Enter URL or search...' : ''}
          disabled={!isRunning}
          className="mx-1.5 h-7 flex-1 rounded-md border border-white/10 bg-neutral-800 px-3 font-mono text-xs text-white/80 outline-none placeholder:text-white/30 focus:border-white/25 disabled:opacity-40"
        />

        {/* Status + controls */}
        <div className="flex shrink-0 items-center gap-2 text-xs text-white/50">
          {status === 'connecting' && (
            <span className="flex items-center gap-1.5">
              <svg className="size-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
              </svg>
              Connecting...
            </span>
          )}
          {status === 'ended' && <span>Disconnected</span>}
          {status === 'error' && <span className="text-red-400">{errorMsg}</span>}

          {isRunning && (
            <button
              type="button"
              onClick={() => {
                setHasControl((v) => {
                  return !v
                })
              }}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition',
                hasControl ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-white/10 text-white/70 hover:bg-white/15 hover:text-white',
              )}
            >
              {hasControl ? 'Release' : 'Take control'}
            </button>
          )}
          {(status === 'ended' || status === 'error') && (
            <button type="button" onClick={reconnect} className="rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white/70 transition hover:bg-white/15 hover:text-white">
              Reconnect
            </button>
          )}
        </div>
      </form>

      {/* ── Canvas area ────────────────────────────────────────── */}
      <div
        ref={containerRef}
        tabIndex={0}
        className={cn('relative flex-1 overflow-hidden bg-neutral-950 outline-none', hasControl ? 'cursor-crosshair' : 'cursor-default')}
      >
        <canvas
          ref={canvasRef}
          className="block h-full w-full object-contain"
          onContextMenu={(e) => {
            if (hasControl) e.preventDefault()
          }}
          onMouseMove={(e) => {
            if (hasControl) dispatchMouse('mouseMoved', e)
          }}
          onMouseDown={(e) => {
            if (!hasControl) return
            // Restore keyboard focus to the container after clicking the canvas,
            // otherwise keys stop dispatching if user clicked the URL bar first
            containerRef.current?.focus()
            dispatchMouse('mousePressed', e)
          }}
          onMouseUp={(e) => {
            if (hasControl) dispatchMouse('mouseReleased', e)
          }}
        />
        {status === 'connecting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <svg className="size-6 animate-spin text-white/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
            <span className="text-sm text-white/40">Connecting to browser...</span>
          </div>
        )}
        {status === 'ended' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <span className="text-sm text-white/40">Session ended</span>
            <button onClick={reconnect} className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/15 hover:text-white">
              Reconnect
            </button>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <span className="text-sm text-red-400">{errorMsg}</span>
            <button onClick={reconnect} className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/15 hover:text-white">
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
