/**
 * The page's side of the schematic check worker: one worker for the app,
 * shared by every open sheet, so a design's checks run off the main thread
 * (docs/performance-workstream.md). A session asks with its design's sheet
 * instances and each file's text as it now is; the host sends only the texts
 * the worker does not hold, and lets a file go once no job has named it for a
 * while (another design's, a closed tab's).
 *
 * One job runs at a time. A request that arrives while one runs waits, and a
 * newer request from the same asker (a session) replaces its waiting one,
 * which answers null: an edit made mid-check costs one more check, never a
 * queue of them. Askers wait their turn in the order they asked.
 *
 * Where there is no Worker (a test under node) the same engine runs on this
 * thread, behind the same messages. Each answered job is measured on the
 * page's timeline as `schematic:check`.
 */
import type { CheckResult } from '../checks'
import { CheckWorkerEngine } from './checkWorkerEngine'
import type { CheckRequest, FromWorker, ToWorker } from './protocol'

/** A file no job has named in this many is let go. */
const KEEP_JOBS = 16

interface Channel {
  post(message: ToWorker): void
  terminate(): void
}

interface Ask {
  asker: string
  request: CheckRequest
  /** Each file's text as it now is, for every file the instances name. */
  texts: ReadonlyMap<string, string>
  resolve(results: CheckResult[] | null): void
}

export class CheckWorkerHost {
  private channel: Channel | null = null
  /** What the worker holds: each file's text, and the last job that named it. */
  private held = new Map<string, { text: string; used: number }>()
  private nextJob = 1
  private running: { job: number; ask: Ask; sent: number; retried: boolean } | null = null
  /** The newest request of each asker, in the order they asked. */
  private waiting = new Map<string, Ask>()

  /** A test hands in `inThread` to run the engine on this thread even where Worker exists. */
  constructor(private readonly inThread = false) {}

  /**
   * The sheet-only checks over a design; null when a newer request from the
   * same `asker` replaced this one before it ran.
   */
  run(
    asker: string,
    request: CheckRequest,
    texts: ReadonlyMap<string, string>
  ): Promise<CheckResult[] | null> {
    return new Promise((resolve) => {
      const replaced = this.waiting.get(asker)
      replaced?.resolve(null)
      if (replaced) this.waiting.delete(asker)
      this.waiting.set(asker, { asker, request, texts, resolve })
      this.pump()
    })
  }

  private open(): Channel {
    const receive = (message: FromWorker): void => this.receive(message)
    if (!this.inThread && typeof Worker !== 'undefined') {
      const worker = new Worker(new URL('./checkWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<FromWorker>) => receive(e.data)
      worker.onerror = (e) => {
        console.error('schematic check worker failed:', e.message)
        this.crashed()
      }
      return { post: (message) => worker.postMessage(message), terminate: () => worker.terminate() }
    }
    const engine = new CheckWorkerEngine()
    return {
      post: (message) => {
        const answer = engine.handle(message)
        queueMicrotask(() => receive(answer))
      },
      terminate: () => {}
    }
  }

  private pump(): void {
    if (this.running) return
    const next = this.waiting.values().next()
    if (next.done) return
    this.waiting.delete(next.value.asker)
    this.send(next.value, false)
  }

  private send(ask: Ask, retried: boolean): void {
    const job = this.nextJob++
    const texts: Array<[string, string]> = []
    for (const [file, text] of ask.texts) {
      if (this.held.get(file)?.text !== text) texts.push([file, text])
      this.held.set(file, { text, used: job })
    }
    const drop: string[] = []
    for (const [file, { used }] of this.held) {
      if (job - used > KEEP_JOBS) {
        drop.push(file)
        this.held.delete(file)
      }
    }
    this.running = { job, ask, sent: performance.now(), retried }
    this.channel ??= this.open()
    this.channel.post({ type: 'check', job, texts, drop, ...ask.request })
  }

  private receive(message: FromWorker): void {
    const running = this.running
    if (!running || message.job !== running.job) return
    this.running = null
    if (message.type === 'checked') {
      performance.measure('schematic:check', { start: running.sent, end: performance.now() })
      running.ask.resolve(message.results)
    } else {
      // As the in-thread checks answer when the graph cannot be built: no findings.
      console.error('schematic checks failed:', message.message)
      running.ask.resolve([])
    }
    this.pump()
  }

  /**
   * The worker died: start afresh, and run its job once more — unless its
   * asker has asked again since, or it already took the worker down once.
   */
  private crashed(): void {
    this.channel?.terminate()
    this.channel = null
    this.held.clear()
    const running = this.running
    this.running = null
    if (running && !running.retried && !this.waiting.has(running.ask.asker)) {
      this.send(running.ask, true)
      return
    }
    if (running) running.ask.resolve(this.waiting.has(running.ask.asker) ? null : [])
    this.pump()
  }
}

let shared: CheckWorkerHost | null = null

/** The app's check worker, started on first use. */
export const checkWorker = (): CheckWorkerHost => (shared ??= new CheckWorkerHost())
