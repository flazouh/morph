// Morph's Ego controller: launches Ego Lite on a CDP pipe, loads the unpacked extension,
// and answers reload requests on a Unix socket so later builds reload without a window.
//
// Run: node scripts/morph-ego-control.mjs
// Reload: printf '%s' '{"action":"load"}' | nc -U /tmp/morph-ego-control.sock
import { execFile, spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'

const extensionPath = new URL('../.output/chrome-mv3', import.meta.url).pathname
const binary = '/Applications/ego lite.app/Contents/MacOS/ego lite'
const socketPath = '/tmp/morph-ego-control.sock'
const focusCursor = () => execFile('osascript', ['-e', 'tell application "Cursor" to activate'], () => {})

try { fs.unlinkSync(socketPath) } catch {}

const browser = spawn(binary, [
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--profile-directory=Default',
  '--restore-last-session',
  '--no-first-run',
  '--no-default-browser-check',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })

const requests = new Map()
let buffer = Buffer.alloc(0)
browser.stdio[4].on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf(0)
    if (end < 0) break
    const text = buffer.subarray(0, end).toString('utf8')
    buffer = buffer.subarray(end + 1)
    if (!text) continue
    try {
      const message = JSON.parse(text)
      const pending = requests.get(message.id)
      if (!pending) continue
      requests.delete(message.id)
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result)
    } catch {}
  }
})

let nextId = 1
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++
  requests.set(id, { resolve, reject })
  const envelope = { id, method, params }
  if (sessionId !== undefined) envelope.sessionId = sessionId
  browser.stdio[3].write(JSON.stringify(envelope) + '\0')
  setTimeout(() => { if (requests.delete(id)) reject(new Error(`${method} timed out`)) }, 20000).unref()
})

const loadAndVerify = async () => {
  const loaded = await send('Extensions.loadUnpacked', { path: extensionPath })
  const listed = await send('Extensions.getExtensions')
  const morph = listed.extensions.find((item) => item.id === loaded.id)
  if (!morph || morph.path !== extensionPath || !morph.enabled) {
    throw new Error(`Morph verification failed: ${JSON.stringify(morph)}`)
  }
  return morph
}

const handle = async (input) => {
  const request = input.trim() === '' ? { action: 'load' } : JSON.parse(input)
  if (request.action === 'list') return send('Extensions.getExtensions')
  if (request.action === 'targets') return send('Target.getTargets')
  if (request.action === 'attach') return send('Target.attachToTarget', { targetId: request.targetId, flatten: true })
  if (request.action === 'cdp') return send(request.method, request.params ?? {}, request.sessionId)
  return loadAndVerify()
}

const server = net.createServer((connection) => {
  let input = ''
  let answered = false
  connection.setEncoding('utf8')
  const answer = async (payload) => {
    if (answered) return
    answered = true
    connection.write(payload + '\n', () => connection.end())
  }
  connection.on('data', (chunk) => {
    input += chunk
    // One request per connection: a complete JSON object, or a close with whatever arrived.
    let request
    try {
      request = JSON.parse(input)
    } catch {
      return
    }
    handle(input).then(
      (result) => answer(JSON.stringify({ ok: true, result })),
      (error) => answer(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    )
  })
  connection.on('end', () => {
    if (input.trim() === '' && !answered) {
      handle('').then(
        (result) => answer(JSON.stringify({ ok: true, result })),
        (error) => answer(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      )
    }
  })
  connection.on('error', () => {})
})

browser.once('exit', (code, signal) => {
  server.close()
  try { fs.unlinkSync(socketPath) } catch {}
  console.log(`EGO_EXIT code=${code} signal=${signal}`)
  process.exit(code ?? 0)
})

try {
  const morph = await loadAndVerify()
  server.listen(socketPath, () => {
    console.log(`MORPH_CONTROL_READY ${JSON.stringify(morph)}`)
    focusCursor()
    setTimeout(focusCursor, 500).unref()
    setTimeout(focusCursor, 1500).unref()
  })
} catch (error) {
  console.error(`LOAD_FAILED ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
