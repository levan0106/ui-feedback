import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { installSkill, uninstallSkill, addToUserPath, enabledPlugins, installShim, removeShim, onPath, pathHint } from '../bridge/install.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bridge', 'cli.mjs')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'uifb-inst-'))
const rmrf = (d) => fs.rmSync(d, { recursive: true, force: true })

test('installSkill chép skill vào <claude>/skills/tl-ui-feedback, uninstallSkill gỡ đúng skill của mình', () => {
  const claude = tmp()
  const dest = installSkill({ root: ROOT, claudeDir: claude })
  assert.equal(dest, path.join(claude, 'skills', 'tl-ui-feedback'))
  assert.match(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), /^---\r?\nname: tl-ui-feedback/)
  assert.equal(uninstallSkill({ claudeDir: claude }), true)
  assert.equal(fs.existsSync(dest), false)
  assert.equal(uninstallSkill({ claudeDir: claude }), false) // gỡ lần hai: không có gì
  rmrf(claude)
})

test('installSkill dọn skill cũ tên ui-feedback của mình, không đụng skill khác cùng tên', () => {
  const claude = tmp()
  const old = path.join(claude, 'skills', 'ui-feedback')
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'SKILL.md'), '---\nname: ui-feedback\n---\n')
  installSkill({ root: ROOT, claudeDir: claude })
  assert.equal(fs.existsSync(old), false)
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'SKILL.md'), '---\nname: cua-nguoi-khac\n---\n')
  installSkill({ root: ROOT, claudeDir: claude })
  assert.equal(fs.existsSync(old), true)
  rmrf(claude)
})

test('uninstallSkill không xóa skill khác tên cùng thư mục', () => {
  const claude = tmp()
  const dir = path.join(claude, 'skills', 'tl-ui-feedback')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: skill-cua-nguoi-khac\n---\nnội dung\n')
  assert.equal(uninstallSkill({ claudeDir: claude }), false)
  assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), true)
  rmrf(claude)
})

test('installShim trên Windows ghi .cmd và sh trỏ tới cli.mjs; trên Linux chỉ sh', () => {
  const bin = tmp()
  const w = installShim({ root: ROOT, binDir: bin, platform: 'win32' })
  assert.equal(w.length, 2)
  const cmd = fs.readFileSync(path.join(bin, 'tl-ui-feedback.cmd'), 'utf8')
  assert.ok(cmd.includes(`node "${path.join(ROOT, 'bridge', 'cli.mjs')}" %*`))
  assert.match(fs.readFileSync(path.join(bin, 'tl-ui-feedback'), 'utf8'), /^#!\/bin\/sh\nexec node ".*\/bridge\/cli\.mjs" "\$@"\n$/)
  assert.equal(removeShim({ binDir: bin }), 2)
  assert.equal(fs.existsSync(bin), false) // thư mục rỗng cũng được dọn
  assert.equal(installShim({ root: ROOT, binDir: bin, platform: 'linux' }).length, 1)
  assert.equal(fs.existsSync(path.join(bin, 'tl-ui-feedback.cmd')), false)
  rmrf(bin)
})

test('removeShim giữ thư mục nếu còn file khác', () => {
  const bin = tmp()
  installShim({ root: ROOT, binDir: bin, platform: 'linux' })
  fs.writeFileSync(path.join(bin, 'khac.txt'), 'x')
  removeShim({ binDir: bin })
  assert.deepEqual(fs.readdirSync(bin), ['khac.txt'])
  rmrf(bin)
})

test('onPath so khớp không phân biệt hoa thường và dấu gạch cuối trên Windows', () => {
  assert.equal(onPath('C:\\Users\\a\\bin', { PATH: 'C:\\x;c:\\users\\A\\BIN\\;D:\\y' }, 'win32'), true)
  assert.equal(onPath('/home/a/bin', { PATH: '/usr/bin:/home/a/bin' }, 'linux'), true)
  assert.equal(onPath('/home/a/bin', { PATH: '/usr/bin:/home/A/bin' }, 'linux'), false)
  assert.equal(onPath('/x', {}, 'linux'), false)
})

test('pathHint chỉ in lệnh, theo từng hệ điều hành', () => {
  assert.match(pathHint('C:\\b', 'win32'), /SetEnvironmentVariable\('Path'.*;C:\\b', 'User'\)/)
  assert.match(pathHint('/h/b', 'linux'), /export PATH="\/h\/b:\$PATH"/)
})

test('CLI: install-shim ghi vào UIFB_HOME/bin, báo PATH; uninstall gỡ shim; chạy được qua shim', () => {
  const home = tmp()
  const env = { ...process.env, UIFB_HOME: home }
  const r = spawnSync(process.execPath, [CLI, 'install-shim'], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const bin = path.join(home, 'bin')
  assert.ok(r.stdout.includes(bin))
  assert.match(r.stdout, /PATH/)
  assert.equal(fs.existsSync(path.join(bin, 'tl-ui-feedback')), true)
  // Shim gọi được CLI thật: `serve --list` in thông báo rỗng.
  const sh = process.platform === 'win32' ? path.join(bin, 'tl-ui-feedback.cmd') : path.join(bin, 'tl-ui-feedback')
  const run = spawnSync(sh, ['serve', '--list'], { env, encoding: 'utf8', shell: process.platform === 'win32' })
  assert.match(run.stdout, /không có site nào đang chạy/)
  rmrf(home)
})

test('addToUserPath: thêm một lần, idempotent, không đụng nền không phải Windows', () => {
  let stored = 'C:/a;C:/b'
  const io = { platform: 'win32', getPath: () => stored, setPath: (v) => { stored = v } }
  assert.deepEqual(addToUserPath('C:/x/bin', io), { changed: true })
  assert.equal(stored, 'C:/a;C:/b;C:/x/bin')
  assert.deepEqual(addToUserPath('c:/X/bin/', io), { changed: false })
  assert.equal(stored, 'C:/a;C:/b;C:/x/bin')
  assert.deepEqual(addToUserPath('/x/bin', { platform: 'linux' }), { changed: false, unsupported: true })
})

test('bin/ của plugin: sh dùng đường dẫn tương đối và chạy được CLI', () => {
  const sh = path.join(ROOT, 'bin', 'tl-ui-feedback')
  assert.match(fs.readFileSync(sh, 'utf8'), /^#!\/bin\/sh\n[\s\S]*bridge\/cli\.mjs/)
  assert.equal(fs.existsSync(path.join(ROOT, 'bin', 'tl-ui-feedback.cmd')), true)
})

test('enabledPlugins: chỉ báo plugin tl-ui-feedback đang bật; JSON hỏng thì rỗng', () => {
  const j = JSON.stringify([
    { id: 'tl-ui-feedback@mk', enabled: true },
    { id: 'tl-ui-feedback@mk2', enabled: false },
    { id: 'khac@mk', enabled: true },
  ])
  assert.deepEqual(enabledPlugins(j), ['tl-ui-feedback@mk'])
  assert.deepEqual(enabledPlugins('không phải json'), [])
})
