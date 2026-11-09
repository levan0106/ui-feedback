import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createBridge } from '../bridge/server.mjs'
import { runDevCommand, probe, stopServe } from '../bridge/serve.mjs'

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bridge/cli.mjs')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-cmd-'))
const rmrf = (d) => fs.rmSync(d, { recursive: true, force: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const until = async (cond, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return; await sleep(100) } throw new Error('quá thời gian chờ') }
const get = (port, p = '/') => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString())) }).on('error', reject)
})

// Dev server giả chạy như một lệnh thật: khởi động sau một khoảng trễ, giữ sống tới khi bị dừng.
function writeFakeDev(dir, delayMs = 400) {
  const f = path.join(dir, 'fake-dev.mjs')
  fs.writeFileSync(f, `import http from 'node:http'
const port = +process.argv[2]
setTimeout(() => {
  http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>dev server that</body></html>') }).listen(port, '127.0.0.1')
  console.log('dev ready ' + port)
}, ${delayMs})
`)
  return f
}

test('runDevCommand chờ upstream sẵn sàng rồi trả về, stop() dừng cả cây tiến trình', async () => {
  const dir = tmp()
  const port = await freePort()
  const script = writeFakeDev(dir)
  const logs = []
  const dev = await runDevCommand({ command: `node "${script}" ${port}`, upstream: `http://localhost:${port}`, timeoutMs: 15000, log: (l) => logs.push(String(l)) })
  try {
    assert.equal(await probe(`http://localhost:${port}`), true)
    assert.ok((await get(port)).includes('dev server that'))
    await until(() => logs.join('').includes('dev ready'), 3000) // log của lệnh con được chuyển ra
  } finally {
    dev.stop()
  }
  await until(async () => !(await probe(`http://localhost:${port}`)), 8000) // dev server thật sự đã chết
  rmrf(dir)
})

test('runDevCommand: lệnh thoát sớm thì báo mã thoát', async () => {
  await assert.rejects(
    runDevCommand({ command: 'node -e "process.exit(3)"', upstream: `http://localhost:${await freePort()}`, timeoutMs: 15000, log: () => {} }),
    /dừng sớm \(mã 3\)/,
  )
})

test('runDevCommand: hết giờ chờ thì dừng lệnh và báo lỗi', async () => {
  const port = await freePort()
  const t0 = Date.now()
  await assert.rejects(
    runDevCommand({ command: 'node -e "setTimeout(()=>{},60000)"', upstream: `http://localhost:${port}`, timeoutMs: 900, log: () => {} }),
    /chưa trả lời; đã dừng lệnh/,
  )
  assert.ok(Date.now() - t0 < 8000)
})

test('runDevCommand: đã có server ở upstream thì từ chối, không chạy lệnh', async () => {
  const srv = http.createServer((q, r) => r.end('x'))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const marker = path.join(tmp(), 'da-chay.txt')
  try {
    await assert.rejects(
      runDevCommand({ command: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}','x')"`, upstream: `http://localhost:${srv.address().port}`, log: () => {} }),
      /đã có server trả lời/,
    )
    await sleep(500)
    assert.equal(fs.existsSync(marker), false)
  } finally { srv.close() }
})

test('CLI --cmd: chạy dev server, proxy chèn overlay, serve --stop dọn cả dev server', async () => {
  const home = tmp()
  const dir = tmp()
  const bridge = createBridge({ port: 0, dir: home })
  const bport = await bridge.listen()
  const devPort = await freePort()
  const script = writeFakeDev(dir)
  const env = { ...process.env, UIFB_HOME: home, UIFB_URL: `http://127.0.0.1:${bport}` }
  const child = spawn(process.execPath, [CLI, 'serve', '--cmd', `node "${script}" ${devPort}`, `http://localhost:${devPort}`, '--no-open', '--wait', '20'], { env })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  try {
    await until(() => /tại http:\/\/localhost:\d+/.test(out), 20000)
    const proxyPort = +out.match(/tại http:\/\/localhost:(\d+)/)[1]
    const page = await get(proxyPort)
    assert.ok(page.includes('dev server that') && page.includes('/__uifb/overlay.js'))
    assert.equal(stopServe(proxyPort, home), true) // dừng cứng serve như trên Windows
    await until(async () => !(await probe(`http://localhost:${devPort}`)), 10000) // dev server không bị mồ côi
  } finally {
    child.kill()
    await bridge.close()
    rmrf(home); rmrf(dir)
  }
})

test('CLI --cmd: thiếu lệnh hoặc site không phải URL thì báo lỗi rõ', async () => {
  const run = (...a) => new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...a])
    let o = ''
    c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (o += d))
    c.on('close', (code) => resolve({ code, o }))
  })
  const a = await run('serve', 'http://localhost:9', '--cmd')
  assert.equal(a.code, 1)
  assert.match(a.o, /--cmd cần một lệnh/)
  const b = await run('serve', '.', '--cmd', 'echo hi')
  assert.equal(b.code, 1)
  assert.match(b.o, /chỉ dùng với site là URL/)
  const c = await run('serve', 'http://localhost:9', '--cmd', 'echo hi', '--wait', '0')
  assert.equal(c.code, 1)
  assert.match(c.o, /--wait phải là số giây/)
})
