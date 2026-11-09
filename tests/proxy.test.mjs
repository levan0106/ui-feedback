import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServe } from '../bridge/serve.mjs'

const B = 'http://127.0.0.1:47831'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-proxy-'))

// Dev server giả: ghi lại request, có HTML, JSON, redirect, echo POST và WebSocket kiểu echo.
async function fakeUpstream() {
  const seen = []
  const tunnels = new Set()
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      const port = srv.address().port
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"a"' }); return res.end('<html><body><div id="root"></div></body></html>') }
      if (req.url === '/api') { res.writeHead(201, { 'content-type': 'application/json', 'x-up': 'yes' }); return res.end('{"ok":true}') }
      if (req.url === '/go') { res.writeHead(302, { location: `http://localhost:${port}/landing` }); return res.end() }
      if (req.url === '/echo') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(Buffer.concat(chunks)) }
      if (req.url === '/gz') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end('khong-phai-gzip-that') }
      if (req.url === '/chunked') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<body>a'); return setTimeout(() => res.end('b</body>'), 20) }
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope')
    })
  })
  srv.on('upgrade', (req, socket) => {
    seen.push({ upgrade: true, url: req.url, headers: req.headers })
    tunnels.add(socket)
    socket.on('close', () => tunnels.delete(socket))
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, seen, port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections?.(); for (const t of tunnels) t.destroy(); srv.close(r); if (!srv.listening) r() }) }
}

const raw = (port, p, { method = 'GET', headers, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })

const until = (cond) => new Promise((resolve, reject) => {
  const t0 = Date.now()
  const t = setInterval(() => {
    if (cond()) { clearInterval(t); resolve() }
    else if (Date.now() - t0 > 4000) { clearInterval(t); reject(new Error('quá thời gian chờ')) }
  }, 10)
})

async function withProxy(fn) {
  const up = await fakeUpstream()
  const dir = tmp()
  const s = await startServe({ port: 0, site: `http://localhost:${up.port}`, bridgeUrl: B, dir })
  try { await fn({ s, up }) } finally { await s.close(); await up.close(); fs.rmSync(dir, { recursive: true, force: true }) }
}

test('proxy: HTML được chèn overlay, content-length đúng, ép accept-encoding identity', () =>
  withProxy(async ({ s, up }) => {
    const r = await raw(s.port, '/', { headers: { 'accept-encoding': 'gzip, br' } })
    assert.equal(r.status, 200)
    assert.match(r.body, /<div id="root"><\/div><script>window\.__UIFB__=.*<\/script><script src="\/__uifb\/overlay\.js"><\/script><\/body>/)
    assert.equal(+r.headers['content-length'], Buffer.byteLength(r.body))
    assert.equal(r.headers.etag, '"a"')
    assert.equal(up.seen[0].headers['accept-encoding'], 'identity')
    assert.equal(up.seen[0].headers.host, `localhost:${up.port}`)
  }))

test('proxy: không phải HTML thì giữ nguyên status, header, body', () =>
  withProxy(async ({ s }) => {
    const r = await raw(s.port, '/api')
    assert.equal(r.status, 201)
    assert.equal(r.headers['x-up'], 'yes')
    assert.equal(r.body, '{"ok":true}')
    const nf = await raw(s.port, '/missing')
    assert.equal(nf.status, 404)
    assert.equal(nf.body, 'nope')
  }))

test('proxy: POST chuyển body, Origin và Referer được viết lại về upstream', () =>
  withProxy(async ({ s, up }) => {
    const r = await raw(s.port, '/echo', {
      method: 'POST', body: 'xin chao',
      headers: { 'content-type': 'text/plain', host: `localhost:${s.port}`, origin: `http://localhost:${s.port}`, referer: `http://localhost:${s.port}/trang` },
    })
    assert.equal(r.body, 'xin chao')
    const seen = up.seen.find((x) => x.url === '/echo')
    assert.equal(seen.headers.origin, `http://localhost:${up.port}`)
    assert.equal(seen.headers.referer, `http://localhost:${up.port}/trang`)
  }))

test('proxy: redirect về upstream được viết lại về origin của proxy', () =>
  withProxy(async ({ s }) => {
    const r = await raw(s.port, '/go', { headers: { host: `localhost:${s.port}` } })
    assert.equal(r.status, 302)
    assert.equal(r.headers.location, `http://localhost:${s.port}/landing`)
  }))

test('proxy: HTML dạng chunked vẫn chèn được; nội dung nén thì để nguyên', () =>
  withProxy(async ({ s }) => {
    const c = await raw(s.port, '/chunked')
    assert.ok(c.body.startsWith('<body>ab<script>') && c.body.endsWith('</script></body>'))
    const gz = await raw(s.port, '/gz')
    assert.equal(gz.body, 'khong-phai-gzip-that')
  }))

test('proxy: /__uifb/overlay.js phục vụ cục bộ, không hỏi upstream', () =>
  withProxy(async ({ s, up }) => {
    const r = await raw(s.port, '/__uifb/overlay.js')
    assert.equal(r.status, 200)
    assert.equal(r.body, fs.readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8'))
    assert.equal(up.seen.length, 0)
  }))

test('proxy: Host lạ bị 403 và không chạm upstream', () =>
  withProxy(async ({ s, up }) => {
    const r = await raw(s.port, '/', { headers: { host: 'evil.example' } })
    assert.equal(r.status, 403)
    assert.equal(up.seen.length, 0)
  }))

test('proxy: upstream chưa chạy thì 502 kèm hướng dẫn', async () => {
  const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const dir = tmp()
  const s = await startServe({ port: 0, site: `http://localhost:${free}`, bridgeUrl: B, dir })
  try {
    const r = await raw(s.port, '/')
    assert.equal(r.status, 502)
    assert.match(r.body, /Dev server đã chạy chưa/)
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('proxy: upstream không phải loopback bị từ chối, trừ khi có allowRemote', async () => {
  const dir = tmp()
  await assert.rejects(startServe({ port: 0, site: 'http://example.com', bridgeUrl: B, dir }), /không phải loopback/)
  const s = await startServe({ port: 0, site: 'http://example.com', bridgeUrl: B, dir, allowRemote: true })
  await s.close()
  await assert.rejects(startServe({ port: 0, site: 'ftp://localhost', bridgeUrl: B, dir }))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('proxy: WebSocket đi hai chiều nguyên vẹn, Host và Origin được viết lại', () =>
  withProxy(async ({ s, up }) => {
    const sock = net.connect(s.port, '127.0.0.1')
    let buf = ''
    sock.on('data', (d) => (buf += d))
    try {
      const head = ['GET /hot HTTP/1.1', `Host: localhost:${s.port}`, `Origin: http://localhost:${s.port}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: abc', 'Sec-WebSocket-Version: 13', '', ''].join('\r\n')
      sock.write(head)
      await until(() => buf.includes('101')).catch((e) => { throw new Error(e.message + ' (101) buf=' + JSON.stringify(buf)) })
      sock.write('ping-1')
      await until(() => buf.includes('echo:ping-1')).catch((e) => { throw new Error(e.message + ' buf=' + JSON.stringify(buf)) })
    } finally {
      sock.destroy() // luôn đóng, nếu không s.close() sẽ treo vì socket nâng cấp không bị closeAllConnections
    }
    const w = up.seen.find((x) => x.upgrade)
    assert.equal(w.url, '/hot')
    assert.equal(w.headers.host, `localhost:${up.port}`)
    assert.equal(w.headers.origin, `http://localhost:${up.port}`)
  }))
