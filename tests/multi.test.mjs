import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBridge } from '../bridge/server.mjs'

const A = 'http://localhost:51001'
const B = 'http://localhost:51002'

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-multi-'))
  const b = createBridge({ port: 0, dir })
  const port = await b.listen()
  const call = (method, p, { body, origin, auth = true } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { 'content-type': 'application/json' }
      if (auth) headers.authorization = 'Bearer ' + b.token
      if (origin) headers.origin = origin
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const c = []
        res.on('data', (d) => c.push(d))
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || '{}') }))
      })
      req.on('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  const feedback = (site, note) => call('POST', '/api/feedback', { body: { note, url: site + '/' } })
  const poll = (origin, timeout = 3000) => call('GET', '/api/poll?timeout=' + timeout + (origin ? '&origin=' + encodeURIComponent(origin) : ''))
  const history = async (origin) => (await call('GET', '/api/history?origin=' + encodeURIComponent(origin))).json
  // Đọc sự kiện presence đầu tiên của luồng SSE.
  const presenceEvent = () =>
    new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/events?token=' + b.token }, (res) => {
        res.once('data', (d) => { req.destroy(); resolve(JSON.parse(String(d).replace(/^data: /, ''))) })
      })
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e) })
    })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  return { b, call, feedback, poll, history, presenceEvent, sleep, stop: async () => { await b.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('poll theo origin: agent của B không nhận tin của A', async () => {
  const t = await start()
  try {
    await t.feedback(A, 'tin cho A')
    const none = await t.poll(B, 300)
    assert.equal(none.json.status, 'timeout')
    const got = await t.poll(A)
    assert.equal(got.json.count, 1)
    assert.equal(got.json.items[0].note, 'tin cho A')
  } finally { await t.stop() }
})

test('hai agent poll đồng thời, mỗi agent chỉ nhận tin của site mình', async () => {
  const t = await start()
  try {
    const pa = t.poll(A)
    const pb = t.poll(B)
    await t.sleep(150)
    await t.feedback(B, 'cho B')
    await t.feedback(A, 'cho A')
    const [ra, rb] = await Promise.all([pa, pb])
    assert.deepEqual(ra.json.items.map((i) => i.note), ['cho A'])
    assert.deepEqual(rb.json.items.map((i) => i.note), ['cho B'])
  } finally { await t.stop() }
})

test('poll không origin vẫn nhận tin của mọi site (tương thích cũ)', async () => {
  const t = await start()
  try {
    await t.feedback(A, 'a')
    await t.feedback(B, 'b')
    const got = await t.poll(undefined)
    assert.deepEqual(got.json.items.map((i) => i.note).sort(), ['a', 'b'])
  } finally { await t.stop() }
})

test('reply không id có origin chỉ hiện ở site đó; không origin hoặc origin lạ thì hiện ở mọi site', async () => {
  const t = await start()
  try {
    await t.call('POST', '/api/reply', { body: { text: 'tiến độ riêng A', origin: A } })
    await t.call('POST', '/api/reply', { body: { text: 'chung' } })
    await t.call('POST', '/api/reply', { body: { text: 'origin lạ', origin: 'https://evil.example' } })
    const ha = (await t.history(A)).entries.map((e) => e.text)
    const hb = (await t.history(B)).entries.map((e) => e.text)
    assert.deepEqual(ha, ['tiến độ riêng A', 'chung', 'origin lạ'])
    assert.deepEqual(hb, ['chung', 'origin lạ'])
  } finally { await t.stop() }
})

test('reply có id đi theo origin của yêu cầu, bỏ qua origin khai báo', async () => {
  const t = await start()
  try {
    const { json } = await t.feedback(A, 'yêu cầu của A')
    await t.call('POST', '/api/reply', { body: { text: 'xong', id: json.id, origin: B } })
    assert.ok((await t.history(A)).entries.some((e) => e.text === 'xong'))
    assert.ok(!(await t.history(B)).entries.some((e) => e.text === 'xong'))
  } finally { await t.stop() }
})

test('presence theo origin: waiter của A không làm chấm của B xanh', async () => {
  const t = await start()
  try {
    const pa = t.poll(A, 5000)
    await t.sleep(150)
    const forA = await t.call('GET', '/api/handshake', { origin: A, auth: false })
    const forB = await t.call('GET', '/api/handshake', { origin: B, auth: false })
    assert.equal(forA.json.listening, true)
    assert.equal(forB.json.listening, false)
    assert.equal((await t.history(A)).listening, true)
    assert.equal((await t.history(B)).listening, false)
    const ev = await t.presenceEvent()
    assert.equal(ev.any, false)
    assert.deepEqual(ev.origins, [A])
    await t.feedback(A, 'đánh thức') // để poll kết thúc sạch
    await pa
  } finally { await t.stop() }
})

test('waiter không lọc origin nghe mọi site', async () => {
  const t = await start()
  try {
    const p = t.poll(undefined, 5000)
    await t.sleep(150)
    for (const o of [A, B]) assert.equal((await t.call('GET', '/api/handshake', { origin: o, auth: false })).json.listening, true)
    assert.equal((await t.presenceEvent()).any, true)
    await t.feedback(A, 'x')
    await p
  } finally { await t.stop() }
})

test('POST /api/feedback báo listening theo origin của trang', async () => {
  const t = await start()
  try {
    const pa = t.poll(A, 5000)
    await t.sleep(150)
    const toB = await t.feedback(B, 'b')
    assert.equal(toB.json.listening, false)
    const toA = await t.feedback(A, 'a')
    // Waiter của A đã bị tin của A đánh thức, nên sau đó không còn ai nghe.
    assert.equal(typeof toA.json.listening, 'boolean')
    await pa
  } finally { await t.stop() }
})
