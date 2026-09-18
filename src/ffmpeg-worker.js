let core = null

async function boot() {
  if (core) return

  const base = `${self.location.origin}/ffmpeg`
  const coreURL = `${base}/ffmpeg-core.js`
  const wasmURL = `${base}/ffmpeg-core.wasm`

  const mod = await import(/* @vite-ignore */ coreURL)
  const factory = mod.default

  if (typeof factory !== 'function') {
    throw new Error('ffmpeg-core.js has no default export. Run: npm run ffmpeg:copy')
  }

  core = await factory({
    locateFile: (path) => (path.endsWith('.wasm') ? wasmURL : `${base}/${path}`),
  })

  core.setLogger(({ type, message }) => self.postMessage({ kind: 'log', line: `${type} ${message}` }))
  core.setProgress(({ progress }) => self.postMessage({ kind: 'progress', progress }))
}

self.onmessage = async ({ data: { id, type, payload } }) => {
  try {
    if (type === 'boot') {
      await boot()
      return self.postMessage({ id, ok: true })
    }

    if (type === 'run') {
      await boot()
      const { inName, outName, bytes, args } = payload

      core.FS.writeFile(inName, bytes)
      core.setTimeout(-1)
      core.exec('-i', inName, ...args, outName)

      const code = core.ret
      core.reset()

      if (code !== 0) {
        try { core.FS.unlink(inName) } catch { /* already gone */ }
        throw new Error(`ffmpeg exited with code ${code}. See the log lines above.`)
      }

      const out = core.FS.readFile(outName)
      try { core.FS.unlink(inName) } catch { /* already gone */ }
      try { core.FS.unlink(outName) } catch { /* already gone */ }

      return self.postMessage({ id, ok: true, bytes: out }, [out.buffer])
    }

    throw new Error(`unknown message type: ${type}`)
  } catch (e) {
    self.postMessage({ id, ok: false, error: e?.message ?? String(e) })
  }
}