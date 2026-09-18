import { useEffect, useRef, useState } from 'react'
import './index.css'

const MAX_FILES = 8
const MAX_BYTES = 512 * 1024 * 1024
const BOOT_TIMEOUT = 180000

const TARGETS = {
  mp3: { label: 'MP3', mime: 'audio/mpeg', args: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'] },
  m4a: { label: 'M4A', mime: 'audio/mp4', args: ['-vn', '-c:a', 'aac', '-b:a', '192k'] },
  wav: { label: 'WAV', mime: 'audio/wav', args: ['-vn', '-c:a', 'pcm_s16le'] },
  flac: { label: 'FLAC', mime: 'audio/flac', args: ['-vn', '-c:a', 'flac'] },
  ogg: { label: 'OGG', mime: 'audio/ogg', args: ['-vn', '-c:a', 'libvorbis', '-q:a', '5'] },
  opus: { label: 'OPUS', mime: 'audio/ogg', args: ['-vn', '-c:a', 'libopus', '-b:a', '128k'] },
  mp4: { label: 'MP4', mime: 'video/mp4', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-c:a', 'aac'] },
}

const mb = (n) => (n / 1048576).toFixed(2) + ' MB'
const stem = (s) => s.replace(/\.[^.]+$/, '')
const ext = (s) => s.match(/\.[^.]+$/)?.[0] ?? ''

export default function App() {
  const workerRef = useRef(null)
  const pendingRef = useRef(new Map())
  const idRef = useRef(0)
  const progressRef = useRef(null)

  const [items, setItems] = useState([])
  const [target, setTarget] = useState('mp3')
  const [busy, setBusy] = useState(false)
  const [engine, setEngine] = useState('cold')
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const w = new Worker(new URL('./ffmpeg-worker.js', import.meta.url), { type: 'module' })

    w.onmessage = ({ data }) => {
      if (data.kind === 'log') return console.log('[ffmpeg]', data.line)
      if (data.kind === 'progress') return progressRef.current?.(data.progress)

      const slot = pendingRef.current.get(data.id)
      if (!slot) return
      pendingRef.current.delete(data.id)
      data.ok ? slot.resolve(data) : slot.reject(new Error(data.error))
    }

    w.onerror = (e) => {
      console.error('[worker]', e.message)
      setEngine('dead')
      setNotice(e.message || 'The converter failed to start. Check the browser console for details.')
      pendingRef.current.forEach((s) => s.reject(new Error(e.message || 'The converter stopped unexpectedly.')))
      pendingRef.current.clear()
      setBusy(false)
    }

    workerRef.current = w
    return () => w.terminate()
  }, [])

  const send = (type, payload, timeout = 0) =>
    new Promise((resolve, reject) => {
      const id = ++idRef.current
      pendingRef.current.set(id, { resolve, reject })
      workerRef.current.postMessage({ id, type, payload }, payload?.bytes ? [payload.bytes.buffer] : [])
      if (timeout) {
        setTimeout(() => {
          if (pendingRef.current.delete(id)) reject(new Error('The converter took too long to start. Try reloading the page.'))
        }, timeout)
      }
    })

  const patch = (id, next) => setItems((p) => p.map((it) => (it.id === id ? { ...it, ...next } : it)))

  const add = (fileList) => {
    const incoming = Array.from(fileList ?? [])
    if (!incoming.length) return

    setItems((prev) => {
      const room = MAX_FILES - prev.length
      if (room <= 0) {
        setNotice(`You can queue up to ${MAX_FILES} files at a time.`)
        return prev
      }

      const seen = new Set(prev.map((p) => p.file.name + p.file.size))
      const fresh = []
      let oversize = false

      for (const f of incoming) {
        if (fresh.length >= room) break
        if (seen.has(f.name + f.size)) continue
        if (f.size > MAX_BYTES) { oversize = true; continue }
        seen.add(f.name + f.size)
        fresh.push({ id: ++idRef.current, file: f, state: 'queued', progress: 0, result: null, error: null })
      }

      setNotice(
        oversize ? 'Files larger than 512 MB were skipped.'
          : incoming.length > room ? `Only ${room} more file${room === 1 ? '' : 's'} fit in the queue.`
            : ''
      )
      return [...prev, ...fresh]
    })
  }

  const remove = (id) => setItems((prev) => {
    const gone = prev.find((it) => it.id === id)
    if (gone?.result) URL.revokeObjectURL(gone.result.url)
    return prev.filter((it) => it.id !== id)
  })

  const clear = () => {
    items.forEach((it) => it.result && URL.revokeObjectURL(it.result.url))
    setItems([])
    setNotice('')
  }

  const run = async () => {
    const queue = items.filter((it) => it.state === 'queued' || it.state === 'failed')
    if (!queue.length || busy) return

    setBusy(true)
    setNotice('')

    if (engine !== 'hot') {
      setEngine('igniting')
      try {
        await send('boot', null, BOOT_TIMEOUT)
        setEngine('hot')
      } catch (e) {
        console.error(e)
        setEngine('dead')
        setNotice(e.message)
        setBusy(false)
        return
      }
    }

    for (const item of queue) {
      patch(item.id, { state: 'working', progress: 0, error: null })
      progressRef.current = (p) => patch(item.id, { progress: Math.max(0, Math.min(100, Math.round(p * 100))) })

      try {
        const bytes = new Uint8Array(await item.file.arrayBuffer())
        const { bytes: out } = await send('run', {
          inName: `in_${item.id}${ext(item.file.name)}`,
          outName: `out_${item.id}.${target}`,
          bytes,
          args: TARGETS[target].args,
        })

        const url = URL.createObjectURL(new Blob([out], { type: TARGETS[target].mime }))
        patch(item.id, { state: 'done', progress: 100, result: { url, name: `${stem(item.file.name)}.${target}` } })
      } catch (e) {
        console.error(e)
        patch(item.id, { state: 'failed', error: e.message })
      } finally {
        progressRef.current = null
      }
    }

    setBusy(false)
  }

  const pending = items.filter((it) => it.state === 'queued' || it.state === 'failed').length
  const full = items.length >= MAX_FILES

  return (
    <div className="shell">
      <div className="ember ember-a" />
      <div className="ember ember-b" />

      <main className="panel">  
        <header className="head">
          <span className={`rune ${engine}`} />
          <div className="titles">
            <h1>Media Converter</h1>
            <p>Converts audio and video right here in your browser</p>
          </div>
          <span className="count">{items.length}/{MAX_FILES}</span>
        </header>

        <div className="trust">
          <span>Nothing is uploaded</span>
          <span>No account needed</span>
          <span>Works offline</span>
        </div>

        <label
          className={`drop ${dragging ? 'hot' : ''} ${full ? 'off' : ''}`}
          onDragOver={(e) => { e.preventDefault(); if (!full) setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (!full) add(e.dataTransfer.files) }}
        >
          <input type="file" multiple accept="audio/*,video/*" hidden disabled={full}
            onChange={(e) => { add(e.target.files); e.target.value = '' }} />
          <strong>{full ? 'Queue is full' : 'Drop files here'}</strong>
          <small>{full ? 'Remove one to add more' : `Up to ${MAX_FILES} at a time, or click to browse`}</small>
        </label>

        {items.length > 0 && (
          <ul className="queue">
            {items.map((it) => (
              <li key={it.id} className={`row ${it.state}`}>
                <div className="rowtop">
                  <span className="nm" title={it.file.name}>{it.file.name}</span>
                  {it.state === 'done'
                    ? <a className="dl" href={it.result.url} download={it.result.name}>Save</a>
                    : <button className="x" onClick={() => remove(it.id)} disabled={busy}>Remove</button>}
                </div>
                <small className="meta">
                  {it.state === 'working' ? `Converting ${it.progress}%`
                    : it.state === 'done' ? `Ready as .${target}`
                      : it.state === 'failed' ? it.error
                        : mb(it.file.size)}
                </small>
                <div className="bar"><div className="lava" style={{ width: `${it.progress}%` }} /></div>
              </li>
            ))}
          </ul>
        )}

        <div className="formats">
          {Object.entries(TARGETS).map(([k, v]) => (
            <button key={k} className={`chip ${target === k ? 'on' : ''}`} disabled={busy} onClick={() => setTarget(k)}>
              {v.label}
            </button>
          ))}
        </div>

        {notice && <p className="err">{notice}</p>}

        <div className="actions">
          <button className="fire" disabled={busy || !pending} onClick={run}>
            {busy ? (engine === 'igniting' ? 'Starting engine…' : 'Converting…') : pending ? `Convert ${pending}` : 'Convert'}
          </button>
          {items.length > 0 && <button className="ghost" disabled={busy} onClick={clear}>Clear</button>}
        </div>
      </main>
    </div>
  )
}