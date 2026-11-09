import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBridge, symbolicate, isLoopbackOrigin } from '../bridge/server.mjs'

const STACK = [{ comp: 'Text', lines: ['Error: react-stack-top-frame', 'at createElement (http://localhost:8091/entry.bundle:10:5)', 'at T (http://localhost:8091/entry.bundle:20:7)'] }]
// Metro giả: trả về frame node_modules rồi frame app.
const fakeFetch = async (url, init) => {
  assert.equal(new URL(url).pathname, '/symbolicate')
  const { stack } = JSON.parse(init.body)
  return {
    json: async () => ({
      stack: [
        { ...stack[0], file: 'F:\\x\\node_modules\\react\\index.js', lineNumber: 1 },
        { ...stack[1], methodName: 'Sidebar', file: 'F:\\x\\app\\apps\\src\\shell\\DesktopShell.tsx', lineNumber: 43, column: 9 },
      ],
    }),
  }
}

async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-'))
  const b = createBridge({ port: 0, dir, fetchImpl: fakeFetch, ...opts })
  const port = await b.listen()
  const base = `http://127.0.0.1:${port}`
  const H = { authorization: 'Bearer ' + b.token, 'content-type': 'application/json' }
  const post = (p, body, headers = H) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) })
  return {
    b, base, port, H, post,
    stop: async () => {
      await b.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
const fb = (note = 'sai màu') => ({
  note, url: 'http://localhost:8091/', stacks: STACK, components: ['T', 'Sidebar'],
  element: { tag: 'DIV', text: 'DEMO', selector: '#a', rect: { x: 1, y: 2, w: 3, h: 4 } },
})

test('health và overlay không cần token', async () => {
  const s = await start()
  try {
    assert.equal((await (await fetch(s.base + '/health')).json()).name, 'ui-feedback-bridge')
    assert.equal((await fetch(s.base + '/overlay.js')).status, 200)
  } finally { await s.stop() }
})

test('API cần token: thiếu hoặc sai bị từ chối', async () => {
  const s = await start()
  try {
    assert.equal((await fetch(s.base + '/api/status')).status, 401)
    assert.equal((await fetch(s.base + '/api/status', { headers: { authorization: 'Bearer wrong' } })).status, 401)
    assert.equal((await fetch(s.base + '/api/status', { headers: s.H })).status, 200)
  } finally { await s.stop() }
})

test('Origin lạ và Host lạ bị chặn; handshake chỉ cho Origin loopback/extension', async () => {
  const s = await start()
  try {
    assert.equal((await fetch(s.base + '/health', { headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal((await fetch(s.base + '/api/handshake')).status, 403)
    const ok = await fetch(s.base + '/api/handshake', { headers: { origin: 'http://localhost:8091' } })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).token, s.b.token)
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:8091')
    const ext = await fetch(s.base + '/api/handshake', { headers: { origin: 'chrome-extension://' + 'a'.repeat(32) } })
    assert.equal(ext.status, 200)
    const code = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/health', headers: { host: 'evil.example' } }, (r) => {
        r.resume()
        resolve(r.statusCode)
      })
    })
    assert.equal(code, 403)
  } finally { await s.stop() }
})

test('feedback vào hàng đợi, poll lấy được, có file:dòng đã symbolicate', async () => {
  const s = await start()
  try {
    assert.equal((await s.post('/api/feedback', fb())).status, 200)
    const got = await (await fetch(s.base + '/api/poll?ack=1&timeout=2000', { headers: s.H })).json()
    assert.equal(got.status, 'feedback')
    assert.equal(got.count, 1)
    const it = got.items[0]
    assert.equal(it.note, 'sai màu')
    assert.equal(it.source.frames[0].file, 'F:/x/app/apps/src/shell/DesktopShell.tsx')
    assert.equal(it.source.frames[0].line, 43)
    assert.equal(it.source.frames[0].createdIn, 'Sidebar')
    const again = await (await fetch(s.base + '/api/poll?ack=1&timeout=200', { headers: s.H })).json()
    assert.equal(again.status, 'timeout')
  } finally { await s.stop() }
})

test('poll đang chờ được đánh thức khi có feedback mới', async () => {
  const s = await start()
  try {
    const pending = fetch(s.base + '/api/poll?ack=1&timeout=5000', { headers: s.H }).then((r) => r.json())
    await new Promise((r) => setTimeout(r, 150))
    assert.equal((await (await fetch(s.base + '/health')).json()).listening, 1)
    await s.post('/api/feedback', fb('đánh thức'))
    assert.equal((await pending).items[0].note, 'đánh thức')
  } finally { await s.stop() }
})

test('poll bị ngắt kết nối không làm mất tin', async () => {
  const s = await start()
  try {
    const ac = new AbortController()
    const p = fetch(s.base + '/api/poll?ack=1&timeout=5000', { headers: s.H, signal: ac.signal }).catch(() => 'aborted')
    await new Promise((r) => setTimeout(r, 150))
    ac.abort()
    assert.equal(await p, 'aborted')
    await new Promise((r) => setTimeout(r, 100))
    await s.post('/api/feedback', fb('không mất'))
    const got = await (await fetch(s.base + '/api/poll?ack=1&timeout=1000', { headers: s.H })).json()
    assert.equal(got.items[0].note, 'không mất')
  } finally { await s.stop() }
})

test('lọc theo origin', async () => {
  const s = await start()
  try {
    await s.post('/api/feedback', { ...fb('A'), url: 'http://localhost:1111/' })
    await s.post('/api/feedback', { ...fb('B'), url: 'http://localhost:2222/' })
    const got = await (await fetch(s.base + '/api/poll?ack=1&timeout=500&origin=' + encodeURIComponent('http://localhost:2222'), { headers: s.H })).json()
    assert.deepEqual(got.items.map((i) => i.note), ['B'])
  } finally { await s.stop() }
})

test('validate: thiếu note → 400; reply id lạ → 404', async () => {
  const s = await start()
  try {
    assert.equal((await s.post('/api/feedback', { url: 'http://localhost:1/' })).status, 400)
    assert.equal((await s.post('/api/reply', { text: 'x', id: 'nope' })).status, 404)
  } finally { await s.stop() }
})

test('reply phát SSE tới trang', async () => {
  const s = await start()
  try {
    const id = (await (await s.post('/api/feedback', fb())).json()).id
    const ac = new AbortController()
    const res = await fetch(s.base + '/api/events?token=' + s.b.token, { signal: ac.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    await reader.read() // presence
    await s.post('/api/reply', { text: 'đã sửa', id })
    const { value } = await reader.read()
    assert.match(dec.decode(value), /"type":"message".*"role":"agent".*"đã sửa"/)
    ac.abort()
  } finally { await s.stop() }
})

test('symbolicate: chặn metro không phải loopback (SSRF); lọc node_modules', async () => {
  assert.equal(isLoopbackOrigin('http://169.254.169.254'), false)
  assert.equal(isLoopbackOrigin('http://localhost:8081'), true)
  await assert.rejects(() => symbolicate('http://evil.example', STACK, fakeFetch), /loopback/)
  const out = await symbolicate('http://localhost:8091', STACK, fakeFetch)
  assert.equal(out.length, 1)
  assert.equal(out[0].file, 'F:/x/app/apps/src/shell/DesktopShell.tsx')
})

test('body quá lớn bị từ chối', async () => {
  const s = await start()
  try {
    const r = await s.post('/api/feedback', { note: 'x'.repeat(300 * 1024) }).catch(() => ({ status: 'reset' }))
    assert.ok(r.status === 413 || r.status === 'reset')
  } finally { await s.stop() }
})

test('lịch sử: yêu cầu → giao → trả lời, có trạng thái; lọc theo origin', async () => {
  const s = await start()
  try {
    const id = (await (await s.post('/api/feedback', fb('lệch 8px'))).json()).id
    const h = () => fetch(s.base + '/api/history?origin=' + encodeURIComponent('http://localhost:8091'), { headers: s.H }).then((r) => r.json())
    let e = (await h()).entries
    assert.equal(e.length, 1)
    assert.equal(e[0].role, 'user')
    assert.equal(e[0].status, 'queued')
    assert.equal(e[0].element.file, 'F:/x/app/apps/src/shell/DesktopShell.tsx:43')
    await (await fetch(s.base + '/api/poll?ack=1&timeout=1000', { headers: s.H })).json()
    assert.equal((await h()).entries[0].status, 'delivered')
    await s.post('/api/reply', { text: 'đã sửa', id })
    e = (await h()).entries
    assert.equal(e[0].status, 'replied')
    assert.deepEqual(e.map((x) => x.role), ['user', 'agent'])
    assert.equal(e[1].itemId, id)
    // tin nhắn agent không gắn id hiện ở mọi origin; yêu cầu của origin khác thì không
    await s.post('/api/reply', { text: 'đang xử lý' })
    await s.post('/api/feedback', { ...fb('khác'), url: 'http://localhost:2222/' })
    const mine = (await h()).entries.map((x) => x.text)
    assert.deepEqual(mine, ['lệch 8px', 'đã sửa', 'đang xử lý'])
    assert.equal((await fetch(s.base + '/api/history')).status, 401)
  } finally { await s.stop() }
})

test('xóa lịch sử: chỉ xóa origin được chỉ định, cần token', async () => {
  const s = await start()
  try {
    await s.post('/api/feedback', fb('một'))
    await s.post('/api/feedback', { ...fb('khác'), url: 'http://localhost:2222/' })
    const o = encodeURIComponent('http://localhost:8091')
    assert.equal((await fetch(s.base + '/api/history/clear?origin=' + o, { method: 'POST' })).status, 401)
    const r = await (await fetch(s.base + '/api/history/clear?origin=' + o, { method: 'POST', headers: s.H })).json()
    assert.equal(r.cleared, 1)
    const h = (u) => fetch(s.base + '/api/history?origin=' + encodeURIComponent(u), { headers: s.H }).then((x) => x.json())
    assert.equal((await h('http://localhost:8091')).entries.length, 0)
    assert.equal((await h('http://localhost:2222')).entries.length, 1)
  } finally { await s.stop() }
})

test('tin nhắn tự do (không kèm phần tử) vẫn vào hàng đợi và lịch sử', async () => {
  const s = await start()
  try {
    assert.equal((await s.post('/api/feedback', { note: 'đổi nút thành màu xanh', url: 'http://localhost:8091/' })).status, 200)
    const got = await (await fetch(s.base + '/api/poll?ack=1&timeout=1000', { headers: s.H })).json()
    assert.equal(got.items[0].note, 'đổi nút thành màu xanh')
    const h = await (await fetch(s.base + '/api/history', { headers: s.H })).json()
    assert.equal(h.entries[0].element, null)
  } finally { await s.stop() }
})

test('SSE phát message và status', async () => {
  const s = await start()
  try {
    const ac = new AbortController()
    const res = await fetch(s.base + '/api/events?token=' + s.b.token, { signal: ac.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    await reader.read()
    await s.post('/api/feedback', fb('x'))
    let buf = dec.decode((await reader.read()).value)
    assert.match(buf, /"type":"message".*"role":"user".*"status":"queued"/)
    await fetch(s.base + '/api/poll?ack=1&timeout=1000', { headers: s.H }).then((r) => r.json())
    buf = dec.decode((await reader.read()).value)
    assert.match(buf, /"type":"status".*"status":"delivered"/)
    ac.abort()
  } finally { await s.stop() }
})
