// Cài và gỡ các mục của tl-ui-feedback trên máy người dùng: skill, shim lệnh `tl-ui-feedback`.
// Mọi đường dẫn đều truyền vào được để test không đụng tới ~/.claude thật.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { stateDir } from './server.mjs'

export const defaultClaudeDir = () => path.join(os.homedir(), '.claude')
export const defaultBinDir = () => path.join(stateDir(), 'bin')

// ---------- Skill ----------
const SKILL_NAME = 'tl-ui-feedback'
const LEGACY_SKILL_NAME = 'ui-feedback' // tên cũ trước khi đổi
const skillDest = (claudeDir, name = SKILL_NAME) => path.join(claudeDir, 'skills', name)

// Chỉ xóa nếu đúng là skill của chúng ta (front matter `name: <name>`), tránh xóa nhầm skill khác cùng tên thư mục.
function removeOwnSkill(claudeDir, name) {
  const dest = skillDest(claudeDir, name)
  let md
  try { md = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8') } catch { return false }
  if (!new RegExp(String.raw`^name:\s*${name}\s*$`, 'm').test(md)) return false
  fs.rmSync(dest, { recursive: true, force: true })
  return true
}

export function installSkill({ root, claudeDir = defaultClaudeDir() }) {
  const dest = skillDest(claudeDir)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(path.join(root, 'skills', SKILL_NAME), dest, { recursive: true })
  removeOwnSkill(claudeDir, LEGACY_SKILL_NAME) // dọn bản cài dưới tên cũ để không bị nạp đôi
  return dest
}

export function uninstallSkill({ claudeDir = defaultClaudeDir() } = {}) {
  const a = removeOwnSkill(claudeDir, SKILL_NAME)
  const b = removeOwnSkill(claudeDir, LEGACY_SKILL_NAME)
  return a || b
}

// ---------- Shim lệnh `tl-ui-feedback` ----------
// Trên Windows ghi .cmd (cmd/PowerShell) và một file sh (Git Bash); nơi khác chỉ ghi sh.
export function installShim({ root, binDir = defaultBinDir(), platform = process.platform }) {
  const cli = path.join(root, 'bridge', 'cli.mjs')
  fs.mkdirSync(binDir, { recursive: true })
  const written = []
  const sh = path.join(binDir, 'tl-ui-feedback')
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "${cli.replace(/\\/g, '/')}" "$@"\n`, { mode: 0o755 })
  written.push(sh)
  if (platform === 'win32') {
    const cmd = path.join(binDir, 'tl-ui-feedback.cmd')
    fs.writeFileSync(cmd, `@echo off\r\nnode "${cli}" %*\r\n`)
    written.push(cmd)
  }
  return written
}

export function removeShim({ binDir = defaultBinDir() } = {}) {
  let removed = 0
  for (const n of ['tl-ui-feedback', 'tl-ui-feedback.cmd', 'ui-feedback', 'ui-feedback.cmd']) { // gồm cả tên cũ
    const f = path.join(binDir, n)
    if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed++ }
  }
  try { if (!fs.readdirSync(binDir).length) fs.rmdirSync(binDir) } catch {}
  return removed
}

export function onPath(binDir, env = process.env, platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':'
  const norm = (p) => (platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '')
  return (env.PATH || env.Path || '').split(sep).some((p) => p && norm(p) === norm(binDir))
}

export function pathHint(binDir, platform = process.platform) {
  if (platform === 'win32') {
    return `Thêm vào PATH của người dùng (PowerShell), rồi mở terminal mới:\n  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${binDir}', 'User')`
  }
  return `Thêm vào PATH (vd ~/.bashrc hoặc ~/.zshrc), rồi mở terminal mới:\n  export PATH="${binDir}:$PATH"`
}

// ---------- Hook xin quyền (PermissionRequest) ----------
// Claude Code (settings.json) và Codex (hooks.json) dùng cùng cấu trúc: hooks.PermissionRequest[] = [{matcher, hooks:[{type,command,timeout}]}].
const HOOK_MARK = 'permission-hook'
export const hookTargets = ({ home = os.homedir() } = {}) => [
  { agent: 'Claude Code', file: path.join(home, '.claude', 'settings.json'), dir: path.join(home, '.claude') },
  { agent: 'Codex', file: path.join(home, '.codex', 'hooks.json'), dir: path.join(home, '.codex') },
]
const isOurs = (g) => Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARK) && h.command.includes('cli.mjs'))

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw new Error('không đọc được JSON ' + file + ': ' + e.message)
  }
}
function writeJson(file, obj) {
  if (fs.existsSync(file) && !fs.existsSync(file + '.bak-uifb')) fs.copyFileSync(file, file + '.bak-uifb')
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
}

// Chỉ thêm vào agent đã có thư mục cấu hình. Trả về danh sách {agent,file,changed}.
export function installHooks({ root, home = os.homedir() }) {
  const cli = path.join(root, 'bridge', 'cli.mjs')
  const command = 'node "' + cli + '" ' + HOOK_MARK
  const out = []
  for (const t of hookTargets({ home })) {
    if (!fs.existsSync(t.dir)) { out.push({ agent: t.agent, file: t.file, changed: false, skipped: true }); continue }
    let j
    try { j = readJson(t.file) } catch (e) { out.push({ agent: t.agent, file: t.file, changed: false, error: e.message }); continue }
    if (j === null || typeof j !== 'object' || Array.isArray(j)) { out.push({ agent: t.agent, file: t.file, changed: false, error: 'gốc JSON không phải object' }); continue }
    if (j.hooks != null && (typeof j.hooks !== 'object' || Array.isArray(j.hooks))) { out.push({ agent: t.agent, file: t.file, changed: false, error: '"hooks" không phải object' }); continue }
    if (j.hooks?.PermissionRequest != null && !Array.isArray(j.hooks.PermissionRequest)) { out.push({ agent: t.agent, file: t.file, changed: false, error: '"hooks.PermissionRequest" không phải mảng' }); continue }
    j.hooks = j.hooks || {}
    const list = (j.hooks.PermissionRequest || []).filter((g) => !isOurs(g))
    list.push({ matcher: '', hooks: [{ type: 'command', command, timeout: 120 }] })
    j.hooks.PermissionRequest = list
    writeJson(t.file, j)
    out.push({ agent: t.agent, file: t.file, changed: true })
  }
  return out
}

export function uninstallHooks({ home = os.homedir() } = {}) {
  const out = []
  for (const t of hookTargets({ home })) {
    let j
    try { j = readJson(t.file) } catch { out.push({ agent: t.agent, file: t.file, changed: false }); continue }
    const before = Array.isArray(j?.hooks?.PermissionRequest) ? j.hooks.PermissionRequest : []
    const after = before.filter((g) => !isOurs(g))
    if (after.length === before.length) { out.push({ agent: t.agent, file: t.file, changed: false }); continue }
    if (after.length) j.hooks.PermissionRequest = after
    else delete j.hooks.PermissionRequest
    if (!Object.keys(j.hooks).length) delete j.hooks
    writeJson(t.file, j)
    out.push({ agent: t.agent, file: t.file, changed: true })
  }
  return out
}

// Thêm binDir vào PATH của NGƯỜI DÙNG (không đụng PATH hệ thống). Chỉ Windows tự làm; nơi khác trả về unsupported
// để CLI in hướng dẫn (mỗi shell một kiểu). Idempotent. getPath/setPath truyền vào được để test không đụng registry thật.
export function addToUserPath(binDir, { platform = process.platform, getPath, setPath } = {}) {
  if (platform !== 'win32') return { changed: false, unsupported: true }
  const ps = (script) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  getPath ||= () => (ps("[Environment]::GetEnvironmentVariable('Path','User')").stdout || '').trim()
  setPath ||= (v) => {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::SetEnvironmentVariable('Path', $env:UIFB_NEWPATH, 'User')"], { encoding: 'utf8', env: { ...process.env, UIFB_NEWPATH: v } })
    if (r.status !== 0) throw new Error('không ghi được PATH người dùng: ' + (r.stderr || '').trim())
  }
  const cur = getPath()
  const norm = (p) => p.toLowerCase().replace(/[\\/]+$/, '')
  if (cur.split(';').some((p) => p && norm(p) === norm(binDir))) return { changed: false }
  setPath(cur && !cur.endsWith(';') ? cur + ';' + binDir : cur + binDir)
  return { changed: true }
}

// Plugin tl-ui-feedback đang bật cùng bản `install` thì skill và MCP bị nạp trùng. Trả về các id plugin đang bật
// (rỗng nếu không có hoặc không chạy được `claude`). listJson truyền vào được để test.
export function enabledPlugins(listJson) {
  if (listJson == null) {
    const r = spawnSync('claude plugin list --json', { shell: true, encoding: 'utf8' })
    if (r.status !== 0) return []
    listJson = r.stdout
  }
  try {
    return JSON.parse(listJson).filter((p) => /^tl-ui-feedback@/.test(p.id) && p.enabled !== false).map((p) => p.id)
  } catch { return [] }
}
