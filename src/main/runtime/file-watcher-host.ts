// Why: spawns the file-watcher worker thread and adapts it to the synchronous
// `watchFileExplorer` contract (a promise that resolves to an unsubscribe fn
// once the recursive crawl is live). Running @parcel/watcher in the worker
// keeps its blocking initial crawl off the main process's libuv pool so a huge
// non-git tree can't wedge the `serve` runtime (issue #5308).
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { app } from 'electron'
import type { FsChangeEvent } from '../../shared/types'
import type { FileWatcherHostMessage, FileWatcherWorkerMessage } from './file-watcher-worker'
// Why: shares the explorer watcher's canonical ignore list, pre-shaped so the
// macOS daemon-side exclusion-path cap (8) is respected — over the cap ALL
// exclusions silently fail and fseventsd delivers full node_modules churn.
import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOption
} from '../ipc/filesystem-watcher-ignore'

const RUNTIME_FILE_WATCH_IGNORE = buildParcelWatcherIgnoreOption(WATCHER_IGNORE_DIRS)

// Why: clean teardown is async (the worker awaits subscription.unsubscribe()
// before closing its port and exiting), and the worker's initial crawl can run
// for a while under load before that unsubscribe is even serviced. Wait
// generously so a slow-but-healthy worker is never abandoned; there is
// deliberately NO force-terminate backstop — see abandonWorker below.
export const WORKER_TEARDOWN_TIMEOUT_MS = 30_000
type WorkerExitWaitResult = 'exit' | 'timeout'

function getFileWatcherWorkerPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar', 'out', 'main', 'file-watcher-worker.js')
  }
  return join(__dirname, 'file-watcher-worker.js')
}

// Why: worker.terminate() force-frees the worker's V8 env while @parcel/watcher's
// native watch thread / inflight async work is still live, which aborts the WHOLE
// process inside napi (verified stack: PromiseRunner::onWorkComplete ->
// Napi::Error::ThrowAsJavaScriptException -> node::FreeEnvironment ->
// node::worker::Worker::Run, exit 134/SIGABRT). That happens whether the crawl
// already went live or not, so terminate() is never safe here. Abandoning instead
// leaks at most one worker thread when it is genuinely wedged — a bounded cost —
// where terminating can only be taken on the main process's behalf.
// Why no removeAllListeners(): that would also drop Node's internal worker-pipe
// listeners, which risks faulting the addon later (observed as a general
// protection fault inside watcher.node). The `disposed`/`ready` flags already
// stop late worker messages from reaching this watch's callbacks.
function abandonWorker(worker: Worker, reason: string, rootPath: string): void {
  try {
    worker.unref()
  } catch {
    // Older runtimes without unref() are still safe to leave attached.
  }
  console.warn('[runtime-files.watch] abandoned file watcher worker', { rootPath, reason })
}

function waitForWorkerExit(worker: Worker, timeoutMs: number): Promise<WorkerExitWaitResult> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onExit: (() => void) | undefined
    const finish = (result: WorkerExitWaitResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (onExit) {
        worker.off('exit', onExit)
      }
      resolve(result)
    }

    onExit = () => finish('exit')
    worker.once('exit', onExit)
    timer = setTimeout(() => finish('timeout'), timeoutMs)
  })
}

/** Start a recursive file watch in a worker thread. Resolves to an unsubscribe
 *  function once the worker reports the crawl is live; rejects if the worker
 *  fails to start the watch. */
export function watchFileExplorerInWorker(
  rootPath: string,
  callback: (events: FsChangeEvent[]) => void
): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(getFileWatcherWorkerPath(), {
      workerData: { rootPath, ignore: RUNTIME_FILE_WATCH_IGNORE }
    })

    let ready = false
    let disposed = false
    let exited = false
    let disposePromise: Promise<void> | undefined

    const runDispose = async (): Promise<void> => {
      if (disposed) {
        return
      }
      disposed = true
      if (exited) {
        return
      }
      // Ask the worker to unsubscribe its native watcher and exit on its own.
      // Why: never terminate() here — see abandonWorker.
      try {
        worker.postMessage({ type: 'unsubscribe' } satisfies FileWatcherHostMessage)
      } catch {
        // Worker already gone — the exit wait and timeout backstop cover this.
      }
      const exitResult = await waitForWorkerExit(worker, WORKER_TEARDOWN_TIMEOUT_MS)
      if (exitResult === 'timeout' && !exited) {
        // Wedged: abandon rather than force-free its V8 env mid-napi-callback.
        abandonWorker(worker, 'dispose timeout', rootPath)
      }
    }

    // Why: racing dispose callers must share the same worker-exit drain instead
    // of letting later calls resolve while teardown is still in flight.
    const dispose = (): Promise<void> => {
      disposePromise ??= runDispose()
      return disposePromise
    }

    worker.on('message', (message: FileWatcherWorkerMessage) => {
      if (message.type === 'ready') {
        ready = true
        resolve(dispose)
        return
      }
      if (message.type === 'events') {
        if (!disposed) {
          callback(message.events)
        }
        return
      }
      if (message.type === 'error') {
        if (!ready) {
          // The crawl never went live — fail the watch so the caller knows.
          // Why: the crawl may still be running inside @parcel/watcher, so
          // terminate() would abort the process; abandon instead.
          disposed = true
          abandonWorker(worker, 'error before ready', rootPath)
          reject(new Error(message.message))
          return
        }
        // Already live: a mid-stream watcher error. Tell the renderer to
        // refresh; the worker also emits an overflow event alongside this.
        console.error('[runtime-files.watch] worker error', { rootPath, error: message.message })
      }
    })

    worker.on('error', (err) => {
      if (!ready) {
        disposed = true
        reject(err)
        return
      }
      // A live worker crashed: surface an overflow so the renderer re-reads,
      // rather than silently going stale.
      console.error('[runtime-files.watch] worker crashed', { rootPath, err })
      if (!disposed) {
        callback([{ kind: 'overflow', absolutePath: rootPath }])
      }
    })

    worker.on('exit', (code) => {
      exited = true
      if (!ready && !disposed) {
        disposed = true
        reject(new Error(`file watcher worker exited before ready (code ${code})`))
      }
    })
  })
}
