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
import { startServe, listServes, stopServe, resolveStatic } from '../bridge/serve.mjs'

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bridge/cli.mjs')
const B = 'http://127.0.0.1:47831'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-serve-'))

function makeSite() {
  const root = tmp()
  fs.writeFileSync(path.join(root, 'index.html'), '<html><body><h1>trang chu</h1></body></html>')
  fs.writeFileSync(path.join(root, 'about.html'), '<body>about</body>')
  fs.writeFileSync(path.join(root, 'a.txt'), 'plain')
  fs.writeFileSync(path.join(root, '.secret'), 'khoa')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'sub', 'index.html'), '<body>sub</body>')
  return root
}
const rmrf = (d) => fs.rmSync(d, { recursive: true, force: true })

// Gửi request thô để giữ nguyên đường dẫn (fetch tự chuẩn hóa ".." trước khi gửi).
const raw = (port, p, { method = 'GET', host } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: host ? { host } : undefined }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })

async function withSite(fn, opts = {}) {
  const root = makeSite()
  const dir = tmp()
  const s = await startServe({ port: 0, site: opts.site || root, bridgeUrl: B, dir, ...opts })
  try { await fn({ s, root, dir }) } finally { await s.close(); rmrf(root); rmrf(dir) }
}

test('HTML được chèn overlay, file khác giữ nguyên', () =>
  withSite(async ({ s }) => {
    const html = await raw(s.port, '/')
    assert.equal(html.status, 200)
    assert.match(html.type, /text\/html/)
    assert.match(html.body, /<h1>trang chu<\/h1><script>window\.__UIFB__=.*<\/script><script src="\/__uifb\/overlay\.js"><\/script><\/body>/)
    assert.equal((await raw(s.port, '/about.html')).body.includes('/__uifb/overlay.js'), true)
    const txt = await raw(s.port, '/a.txt')
    assert.equal(txt.body, 'plain')
    assert.match(txt.type, /text\/plain/)
    assert.equal((await raw(s.port, '/sub/')).body.includes('sub'), true)
  }))

test('/__uifb/overlay.js trả đúng file overlay', () =>
  withSite(async ({ s }) => {
    const r = await raw(s.port, '/__uifb/overlay.js')
    assert.equal(r.status, 200)
    assert.equal(r.body, fs.readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8'))
  }))

test('chặn thoát thư mục, dotfile và byte NUL', () =>
  withSite(async ({ s, root }) => {
    fs.writeFileSync(path.join(path.dirname(root), 'outside-' + path.basename(root) + '.txt'), 'ngoai')
    const out = 'outside-' + path.basename(root) + '.txt'
    for (const p of ['/../' + out, '/%2e%2e/' + out, '/..%2f' + out, '/sub/../../' + out, '/.secret', '/%00', '/..%5c' + out]) {
      assert.equal((await raw(s.port, p)).status, 404, p)
    }
    rmrf(path.join(path.dirname(root), out))
  }))

test('symlink trỏ ra ngoài thư mục bị chặn', () =>
  withSite(async ({ s, root }) => {
    const outside = tmp()
    fs.writeFileSync(path.join(outside, 'x.txt'), 'ngoai')
    try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction') } catch { rmrf(outside); return } // không tạo được symlink thì bỏ qua
    assert.equal((await raw(s.port, '/link/x.txt')).status, 404)
    rmrf(outside)
  }))

test('Host lạ bị từ chối, method ghi bị 405, không có file thì 404', () =>
  withSite(async ({ s }) => {
    assert.equal((await raw(s.port, '/', { host: 'evil.example' })).status, 403)
    assert.equal((await raw(s.port, '/', { method: 'POST' })).status, 405)
    assert.equal((await raw(s.port, '/khong-co')).status, 404)
  }))

test('--spa: đường dẫn không có đuôi rơi về index.html, có đuôi vẫn 404', () =>
  withSite(async ({ s }) => {
    assert.equal((await raw(s.port, '/route/bat-ky')).body.includes('trang chu'), true)
    assert.equal((await raw(s.port, '/thieu.js')).status, 404)
  }, { spa: true }))

test('không --spa thì route lạ là 404', () =>
  withSite(async ({ s }) => assert.equal((await raw(s.port, '/route/bat-ky')).status, 404)))

test('site là một file HTML: phục vụ ở "/" và asset cùng thư mục', async () => {
  const root = makeSite()
  const dir = tmp()
  const s = await startServe({ port: 0, site: path.join(root, 'about.html'), bridgeUrl: B, dir })
  try {
    const r = await raw(s.port, '/')
    assert.equal(r.status, 200)
    assert.ok(r.body.includes('about') && r.body.includes('/__uifb/overlay.js'))
    assert.equal((await raw(s.port, '/a.txt')).body, 'plain')
  } finally { await s.close(); rmrf(root); rmrf(dir) }
})

test('cổng bận: báo lỗi rõ ràng', async () => {
  const blocker = net.createServer()
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
  const root = makeSite()
  const dir = tmp()
  try {
    await assert.rejects(startServe({ port: blocker.address().port, site: root, bridgeUrl: B, dir }), /đang bị chiếm/)
    assert.deepEqual(listServes(dir), [])
  } finally { blocker.close(); rmrf(root); rmrf(dir) }
})

test('site không tồn tại thì ném lỗi', async () => {
  const dir = tmp()
  await assert.rejects(startServe({ port: 0, site: path.join(dir, 'khong-co'), bridgeUrl: B, dir }))
  rmrf(dir)
})

test('listServes dọn trạng thái của tiến trình đã chết', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'serve-4001.json'), JSON.stringify({ port: 4001, pid: 2 ** 22 + 12345, site: 'x', mode: 'static' }))
  fs.writeFileSync(path.join(dir, 'serve-4002.json'), 'không phải json')
  assert.deepEqual(listServes(dir), [])
  assert.deepEqual(fs.readdirSync(dir), [])
  rmrf(dir)
})

test('resolveStatic: root phải là đường dẫn thật, file ẩn bị loại', () => {
  const root = fs.realpathSync(makeSite())
  assert.ok(resolveStatic(root, '/a.txt').endsWith('a.txt'))
  assert.equal(resolveStatic(root, '/.secret'), null)
  assert.equal(resolveStatic(root, '/sub'), path.join(root, 'sub', 'index.html'))
  rmrf(root)
})

test('CLI: serve chạy, --list thấy, --stop dừng, tải được trang có overlay', async () => {
  const home = tmp()
  const bridge = createBridge({ port: 0, dir: home })
  const bport = await bridge.listen()
  const root = makeSite()
  const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const env = { ...process.env, UIFB_HOME: home, UIFB_URL: `http://127.0.0.1:${bport}` }
  const run = (...a) => new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...a], { env })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (out += d))
    c.on('close', (code) => resolve({ code, out }))
  })
  const child = spawn(process.execPath, [CLI, 'serve', String(free), root, '--no-open'], { env })
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('serve không khởi động')), 8000)
      child.stdout.on('data', (d) => { if (String(d).includes('đang phục vụ')) { clearTimeout(t); resolve() } })
      child.on('exit', () => reject(new Error('serve thoát sớm')))
    })
    const page = await raw(free, '/')
    assert.ok(page.body.includes(`"bridge":"http://127.0.0.1:${bport}"`))
    const list = await run('serve', '--list')
    assert.match(list.out, new RegExp(`^${free}\\s+static`))
    assert.equal(stopServe(free, home), true)
    await new Promise((r) => child.on('exit', r))
    assert.match((await run('serve', '--list')).out, /không có site nào/)
    assert.equal((await run('serve', '--stop', String(free))).out.includes('không có site'), true)
    assert.equal((await run('serve', 'abc', root)).code, 1)
  } finally {
    child.kill()
    await bridge.close()
    rmrf(root); rmrf(home)
  }
})

test('CLI: bỏ cổng thì tự chọn cổng trống, hai lần chạy ra hai cổng khác nhau', async () => {
  const home = tmp()
  const bridge = createBridge({ port: 0, dir: home })
  const bport = await bridge.listen()
  const root = makeSite()
  const env = { ...process.env, UIFB_HOME: home, UIFB_URL: `http://127.0.0.1:${bport}` }
  const start = (...a) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CLI, 'serve', ...a, '--no-open'], { env })
    const t = setTimeout(() => reject(new Error('serve không khởi động')), 8000)
    c.stdout.on('data', (d) => {
      const m = String(d).match(/tại http:\/\/localhost:(\d+)/)
      if (m) { clearTimeout(t); resolve({ c, port: +m[1] }) }
    })
    c.on('exit', () => reject(new Error('serve thoát sớm')))
  })
  const run = (...a) => new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...a], { env })
    let out = ''
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d))
    c.on('close', (code) => resolve({ code, out }))
  })
  const a = await start(root)
  const b = await start(root)
  try {
    assert.ok(a.port > 0 && b.port > 0 && a.port !== b.port)
    assert.ok((await raw(a.port, '/')).body.includes('/__uifb/overlay.js'))
    const list = (await run('serve', '--list')).out
    assert.ok(list.includes(String(a.port)) && list.includes(String(b.port)))
    // Chỉ một số mà không có site: báo lỗi, không phục vụ gì
    const bad = await run('serve', '3000')
    assert.equal(bad.code, 1)
    assert.match(bad.out, /thiếu site/)
  } finally {
    a.c.kill(); b.c.kill()
    await new Promise((r) => setTimeout(r, 200))
    await bridge.close()
    rmrf(root); rmrf(home)
  }
})
