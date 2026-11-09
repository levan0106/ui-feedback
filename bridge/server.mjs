// UI Feedback Bridge — server local (Node thuần, không dependency).
// Nhận phản hồi UI từ overlay (extension / script dev), giữ hàng đợi, agent lấy qua long-poll.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 47831
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OVERLAY_FILE = path.resolve(HERE, '../extension/overlay.js')
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const ORIGIN_OK = /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f-]{36})$/
const MAX_BODY = 256 * 1024

export function stateDir() {
  return process.env.UIFB_HOME || path.join(os.homedir(), '.ui-feedback-bridge')
}

export function loadOrCreateToken(dir = stateDir()) {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'token')
  try {
    const t = fs.readFileSync(f, 'utf8').trim()
    if (t.length >= 32) return t
  } catch {}
  const t = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(f, t, { mode: 0o600 })
  return t
}

// Chỉ cho gọi Metro trên loopback (chặn SSRF).
export function isLoopbackOrigin(o) {
  try {
    const u = new URL(o)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname)
  } catch {
    return false
  }
}

const norm = (file) => file.replace(/\\/g, '/')

// stacks: [{ comp, lines: ["at fn (url:line:col)", ...] }] lấy từ fiber._debugStack ở trình duyệt.
export async function symbolicate(metroOrigin, stacks, fetchImpl = fetch) {
  if (!isLoopbackOrigin(metroOrigin)) throw Object.assign(new Error('metro origin not loopback'), { status: 400 })
  const parse = (l) => {
    const m = String(l).match(/at (?:(\S+) )?\(?(https?:\/\/[^\s)]+?):(\d+):(\d+)\)?$/)
    return m ? { methodName: m[1] || '', file: m[2], lineNumber: +m[3], column: +m[4] } : null
  }
  const out = []
  const seen = new Set()
  for (const st of (stacks || []).slice(0, 12)) {
    const frames = (st.lines || []).slice(0, 30).map(parse).filter(Boolean)
    if (!frames.length) continue
    let j
    try {
      const r = await fetchImpl(new URL('/symbolicate', metroOrigin), {
        method: 'POST',
        body: JSON.stringify({ stack: frames }),
        signal: AbortSignal.timeout(5000),
      })
      j = await r.json()
    } catch (e) {
      out.push({ element: st.comp, error: 'symbolicate failed: ' + e.message })
      break
    }
    const u = (j.stack || []).find((f) => f.file && !/node_modules/.test(f.file))
    if (!u) continue
    const key = `${u.file}:${u.lineNumber}:${u.column}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ element: String(st.comp), createdIn: u.methodName || null, file: norm(u.file), line: u.lineNumber, column: u.column })
    if (out.length >= 8) break
  }
  return out
}

// Mã phiên: sinh ở máy người dùng (CLI) khi bắt đầu /tl-ui-feedback, in trong cuộc trò chuyện của agent, lưu file 0600.
// Trang web không đọc được file lẫn terminal nên không có mã; đây là bằng chứng "có người điều khiển phiên này".
// Chuẩn hóa đường dẫn để so sánh: gạch xuôi, bỏ gạch cuối; chỉ hạ chữ thường trên Windows/macOS (Linux phân biệt hoa thường).
const CASE_FOLD = process.platform === 'win32' || process.platform === 'darwin'
export const normPath = (d) => { const n = String(d || '').replace(/\\/g, '/').replace(/\/+$/, ''); return CASE_FOLD ? n.toLowerCase() : n }
const isProjectRoot = (p) => { try { return fs.existsSync(path.join(p, '.git')) || fs.existsSync(path.join(p, 'package.json')) } catch { return false } }
// Hai thư mục thuộc cùng một phiên agent khi trùng nhau, hoặc một bên là thư mục con của bên kia VÀ bên cha là gốc dự án (có .git/package.json).
// Cha là thư mục rộng (C:\Work, home) thì không khớp, để agent ở dự án khác bên trong không bị gộp nhầm.
export const sameSession = (hook, poller) => !!hook && !!poller && (hook === poller
  || (hook.startsWith(poller + '/') && isProjectRoot(poller))
  || (poller.startsWith(hook + '/') && isProjectRoot(hook)))
const sessionFile = (dir) => path.join(dir, 'session-codes.json')
const readSessions = (dir) => { try { const j = JSON.parse(fs.readFileSync(sessionFile(dir), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {} } catch { return {} } }
// Khóa thư mục ngắn hạn để hai CLI/MCP không ghi đè lẫn nhau (đọc-sửa-ghi). Khóa cũ hơn 5 giây coi là bỏ rơi.
function withLock(dir, fn) {
  const lock = path.join(dir, '.session.lock')
  const t0 = Date.now()
  let held = false
  for (;;) {
    try { fs.mkdirSync(lock); held = true; break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmdirSync(lock) } catch {}
      if (Date.now() - t0 > 3000) break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try { return fn() } finally { if (held) try { fs.rmdirSync(lock) } catch {} }
}
const newCode = () => crypto.randomBytes(5).toString('hex').slice(0, 8).toUpperCase()
// Trả về { code, isNew }. rotate=true: đổi mã mới (mã cũ mất hiệu lực, kể cả khi đã bị khóa vì nhập sai).
export function ensureSessionCode(cwd, { dir = stateDir(), rotate = false } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const k = normPath(cwd)
  return withLock(dir, () => {
    const f = sessionFile(dir)
    let all = readSessions(dir)
    if (fs.existsSync(f) && !Object.keys(all).length && fs.statSync(f).size > 2) {
      // File hỏng/bị cắt: giữ lại bản sao để không âm thầm mất mọi mã, rồi tạo mới.
      try { fs.copyFileSync(f, f + '.corrupt-' + Date.now()) } catch {}
    }
    if (all[k]?.code && !rotate) return { code: all[k].code, isNew: false }
    all = { ...all, [k]: { code: newCode(), cwd: String(cwd || ''), createdAt: new Date().toISOString() } }
    const tmp = f + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, f) // nguyên tử: người đọc không bao giờ thấy file dở dang
    return { code: all[k].code, isNew: true }
  })
}

// Lệnh/thao tác rủi ro không bao giờ được duyệt từ trang: server không tạo thẻ, agent hỏi ở terminal như thường.
// Đây là lưới an toàn theo mẫu, không phải sandbox: lệnh bị làm rối (vd $(echo r)m) có thể lọt, nên vẫn phải đọc kỹ thẻ trước khi bấm.
const RISKY = [
  ['xóa file/thư mục', /(?:^|[\s;&|(){`'"=])(?:rm|rmdir|unlink|shred|del|erase|rd|rimraf|remove-item)(?=\s|$)/i],
  ['git thao tác không hoàn tác / ra ngoài', /\bgit\b[^;&|\n]*\s(?:push|clean|rebase|filter-branch|update-ref|reset\s+--(?:hard|merge)|checkout\s+(?:-f|--force|--)|restore|branch\s+-[dD]|stash\s+(?:drop|clear)|reflog\s+(?:expire|delete)|gc\s+--prune|tag\s+-d)(?=\s|$)/i],
  ['publish/đăng nhập package registry', /\b(?:npm|pnpm|yarn|npx)\b[^;&|\n]*\s(?:publish|unpublish|deprecate|dist-tag|owner|token|adduser|login)(?=\s|$)/i],
  ['quyền hệ thống / đĩa / tiến trình', /(?:^|[\s;&|(){`'"=])(?:sudo|doas|su|chmod|chown|chgrp|mkfs|dd|fdisk|diskpart|format|shutdown|reboot|kill|killall|pkill|taskkill|stop-process|systemctl|launchctl|crontab|schtasks|setx|reg)(?=\s|$)/i],
  ['gửi dữ liệu ra ngoài (ssh/scp/rsync/nc)', /(?:^|[\s;&|(){`'"=])(?:ssh|scp|sftp|rsync|nc|ncat|telnet)(?=\s|$)/i],
  ['docker/k8s/terraform/cloud phá hủy hoặc triển khai', /\b(?:docker|podman)\b[^;&|\n]*\s(?:rm|rmi|push|system\s+prune|volume\s+rm|container\s+prune)(?=\s|$)|\b(?:kubectl|helm)\b[^;&|\n]*\s(?:delete|apply|exec|uninstall|upgrade|install)(?=\s|$)|\bterraform\b[^;&|\n]*\s(?:apply|destroy)(?=\s|$)|\b(?:aws|gcloud|az)\b[^;&|\n]*\s(?:delete|terminate|rm|remove|destroy|deploy|put[\w-]*)(?=\s|$)/i],
  ['tải rồi chạy mã', /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:sh|bash|zsh|iex|invoke-expression|python3?|node)\b|(?:^|[\s;&|(){`'"=])(?:iex|invoke-expression|eval)(?=\s|$)/i],
  ['ghi đè file hệ thống/khóa', /(?:>|tee\s)\s*(?:\/(?:etc|dev|usr|bin|boot)\b|~?\/?\.(?:ssh|bashrc|zshrc|profile|npmrc|netrc)\b)/i],
  ['interpreter chạy mã tùy ý (-c/-e)', /(?:^|[\s;&|(){`'"=])(?:python[\d.]*|py|node|deno|bun|perl|ruby|php|lua)(?:\.exe)?\s+(?:-\S+\s+)*?-(?:c|e|-eval)(?=\s|$)/i],
  ['shell/cmd/powershell chạy chuỗi lệnh', /(?:^|[\s;&|(){`'"=])(?:(?:ba|z|da|k)?sh|cmd(?:\.exe)?)\s+(?:-\S+\s+)*?(?:-c|\/c|\/k)(?=\s|$)|\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|ec|enc\w*|c|command)(?=\s|$)/i],
  ['xóa dữ liệu SQL', /\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+from\b/i],
  ['find -delete/-exec', /\bfind\b[^\n]*\s-(?:delete|exec(?:dir)?)\b/i],
]
const SENSITIVE_PATH = /(?:^|[\\/])(?:\.env[^\\/]*|\.ssh|\.aws|\.npmrc|\.netrc|id_rsa[^\\/]*|id_ed25519[^\\/]*|credentials[^\\/]*|\.git[\\/](?:hooks|config)|\.claude[\\/]settings[^\\/]*|\.codex)(?:[\\/]|$)/i
// Trả về lý do rủi ro (chuỗi) hoặc '' nếu có thể cho phép từ trang. Dùng chung cho hook (không in mã) và server (chặn thật).
export function riskyReason(tool, input, cwd) {
  const inp = input && typeof input === 'object' ? input : {}
  if (typeof inp.command === 'string' || typeof inp.cmd === 'string') {
    const cmd = String(inp.command ?? inp.cmd)
    for (const [why, re] of RISKY) if (re.test(cmd)) return why
  }
  const f = inp.file_path ?? inp.path ?? inp.notebook_path
  if (typeof f === 'string') {
    if (SENSITIVE_PATH.test(f)) return 'file nhạy cảm (khóa, .env, cấu hình agent)'
    const abs = /^(?:[a-z]:)?[\\/]/i.test(f) || f.startsWith('~')
    const n = normPath(f)
    const root = normPath(cwd)
    if (/(?:^|\/)\.\.(?:\/|$)/.test(n)) return 'đường dẫn thoát ra ngoài thư mục dự án'
    if (abs && (!root || !(n === root || n.startsWith(root + '/')))) return 'ghi ngoài thư mục dự án'
  }
  return ''
}

// Sau khi giao cho poller, agent phải xác nhận (ack) hoặc trả lời trong ngần này ms, nếu không tin về hàng đợi.
export const DEFAULT_ACK_MS = 60000
// Nhập mã đúng một lần thì mở khóa (origin của trang + thư mục agent) trong ngần này ms kể từ lần duyệt gần nhất.
export const DEFAULT_UNLOCK_MS = 60 * 60 * 1000

export function createBridge({ port = DEFAULT_PORT, dir = stateDir(), fetchImpl = fetch, ackMs = process.env.UIFB_ACK_MS != null ? +process.env.UIFB_ACK_MS : DEFAULT_ACK_MS, permMinMs = 5000, unlockMs = process.env.UIFB_UNLOCK_MS != null ? +process.env.UIFB_UNLOCK_MS : DEFAULT_UNLOCK_MS } = {}) {
  const token = loadOrCreateToken(dir)
  const queue = [] // {id,...}
  const items = new Map()
  const waiters = [] // {res, origin, timer}
  const sse = new Set()
  let seq = 0

  const sendEvent = (obj) => {
    for (const r of sse) r.write(`data: ${JSON.stringify(obj)}\n\n`)
  }
  // Presence theo origin: waiter không lọc origin nghe mọi site; waiter có origin chỉ nghe site đó.
  const listeningFor = (o) => waiters.some((w) => !w.origin || w.origin === o)
  const presenceState = () => ({
    type: 'presence',
    listening: waiters.length > 0, // tương thích cũ: có agent nào đang chờ
    any: waiters.some((w) => !w.origin),
    origins: [...new Set(waiters.filter((w) => w.origin).map((w) => w.origin))],
  })
  const presence = () => sendEvent(presenceState())

  // Lịch sử hội thoại (chỉ trong bộ nhớ, không ghi đĩa): yêu cầu của người dùng + phản hồi của agent.
  const thread = []
  const MAX_THREAD = 500
  const pushEntry = (e) => {
    thread.push(e)
    if (thread.length > MAX_THREAD) thread.shift()
    sendEvent({ type: 'message', entry: e })
  }
  const setStatus = (id, status, extra = {}) => {
    const e = thread.find((x) => x.id === id)
    if (!e) return
    // unacked chỉ có nghĩa khi tin đang nằm lại hàng đợi; sang trạng thái khác (đã giao/đã đọc/đã trả lời) thì về 0.
    const un = status === 'queued' ? extra.unacked ?? e.unacked ?? 0 : 0
    if (e.status === status && (e.unacked || 0) === un) return
    e.status = status
    e.unacked = un
    sendEvent({ type: 'status', id, status, origin: e.origin, unacked: un })
  }
  // Xin quyền từ agent (hook PermissionRequest của Claude Code / Codex): giữ kết nối tới khi người dùng quyết định trên trang.
  // Chỉ nhận khi đang có yêu cầu UI chưa được trả lời; không có thì hook rơi về hộp thoại xác nhận thường của agent.
  const perms = new Map() // id -> {id,tool,detail,cwd,who,origins,createdAt,expiresAt,status,res,timer}
  const pubPerm = (p) => ({ id: p.id, tool: p.tool, detail: p.detail, cwd: p.cwd, cwdKey: p.cwdKey, origins: p.origins, needsCode: !!p.code, unlockedOrigins: p.origins.filter((o) => isUnlocked(o, p.cwdKey)), createdAt: p.createdAt, expiresAt: p.expiresAt })
  const pendingPerms = (o) => [...perms.values()].filter((p) => p.status === 'pending' && (!o || p.origins.includes(o))).map(pubPerm)
  const finishPerm = (p, status, extra = {}) => {
    if (p.status !== 'pending') return false
    p.status = status
    clearTimeout(p.timer)
    sendEvent({ type: 'permission-done', id: p.id, status, origins: p.origins })
    if (p.res && !p.res.writableEnded) json(p.res, 200, { decision: status === 'allowed' ? 'allow' : status === 'denied' ? 'deny' : 'none', ...extra })
    setTimeout(() => perms.delete(p.id), 60000).unref?.()
    return true
  }
  // Chỉ các site có tin đang được CHÍNH agent đó xử lý mới nhận thẻ xin quyền: hook cài toàn cục nên mọi phiên agent khác
  // trên máy cũng gọi vào đây. Đối chiếu cwd của yêu cầu với cwd của poller (who = "pid N @ cwd"). Không khớp được thì bỏ qua.
  const cwdOf = (who) => { const i = String(who || '').indexOf(' @ '); return i < 0 ? '' : normPath(who.slice(i + 3)) }
  const activeOrigins = (cwd) => {
    const c = normPath(cwd)
    return [...new Set([...items.values()]
      .filter((i) => i.origin && (i.status === 'delivered' || i.status === 'received') && sameSession(c, cwdOf(i.deliveredTo?.who || i.receivedBy)))
      .map((i) => i.origin))]
  }
  const PERM_CODE = /^[A-Z0-9]{6,12}$/
  // Mở khóa theo phiên: mã nhập đúng một lần gắn với ĐÚNG origin của trang đã nhập + thư mục agent. Origin khác (site/cổng khác) không dùng được.
  const unlocks = new Map() // `${origin}|${cwdKey}` -> { origin, cwd, exp }
  const isUnlocked = (o, c) => {
    for (const [k, u] of unlocks) {
      if (u.exp < Date.now()) { unlocks.delete(k); continue }
      if (u.origin === o && sameSession(c, u.cwd)) return true
    }
    return false
  }
  // Còn bao nhiêu ms mở khóa của (origin, thư mục); 0 nếu chưa/đã hết.
  const unlockLeft = (o, c) => {
    let best = 0
    for (const u of unlocks.values()) if (u.origin === o && sameSession(c, u.cwd)) best = Math.max(best, u.exp - Date.now())
    return Math.max(0, best)
  }
  const MAX_SESSION_FAILS = 5
  const sessionFails = new Map() // mã phiên -> số lần nhập sai (toàn cục, không theo từng yêu cầu: trang có token có thể tạo yêu cầu giả để dò mã)
  // Mã phiên khớp thư mục của yêu cầu (cùng cây thư mục). Mã đã bị khóa vì nhập sai quá số lần thì không dùng được cho tới khi đổi mã.
  const sessionCodeFor = (cwdKey) => {
    // Nhiều phiên lồng nhau: trùng đúng thư mục thắng, rồi tới đường dẫn dài (cụ thể) nhất.
    let best = null
    for (const e of Object.values(readSessions(dir))) {
      if (!e?.code) continue
      const ec = normPath(e.cwd)
      if (!sameSession(cwdKey, ec)) continue
      const score = ec === cwdKey ? Infinity : ec.length
      if (!best || score > best.score) best = { score, code: e.code, locked: (sessionFails.get(e.code) || 0) >= MAX_SESSION_FAILS }
    }
    return best && { code: best.code, locked: best.locked }
  }
  const eqCode = (a, b) => a.length === b.length && a.length > 0 && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  const unlock = (o, c) => unlocks.set(o + '|' + c, { origin: o, cwd: c, exp: Date.now() + unlockMs })
  const MAX_CODE_TRIES = 3
  // Hẹn giờ chờ ack cho từng tin đã giao: quá hạn mà chưa ack/reply thì trả về hàng đợi để giao lại.
  const ackTimers = new Map()
  const clearAck = (id) => {
    clearTimeout(ackTimers.get(id))
    ackTimers.delete(id)
  }
  const armAck = (it) => {
    clearAck(it.id)
    if (!(ackMs > 0)) return
    const t = setTimeout(() => {
      ackTimers.delete(it.id)
      if (it.status !== 'delivered') return
      it.status = 'queued'
      it.unacked = (it.unacked || 0) + 1
      queue.unshift(it)
      setStatus(it.id, 'queued', { unacked: it.unacked })
      wake()
    }, ackMs)
    t.unref?.()
    ackTimers.set(it.id, t)
  }

  function cors(req, res) {
    const o = req.headers.origin
    if (o && ORIGIN_OK.test(o)) {
      res.setHeader('Access-Control-Allow-Origin', o)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
  }
  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let n = 0
      const chunks = []
      req.on('data', (c) => {
        n += c.length
        if (n > MAX_BODY) {
          reject(Object.assign(new Error('body too large'), { status: 413 }))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch {
          reject(Object.assign(new Error('invalid json'), { status: 400 }))
        }
      })
      req.on('error', reject)
    })
  const authed = (req, url) => {
    const h = req.headers.authorization || ''
    const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || ''
    const a = Buffer.from(t)
    const b = Buffer.from(token)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  function takeFor(origin) {
    const taken = []
    for (let i = 0; i < queue.length; ) {
      const it = queue[i]
      if (it.status !== 'queued') { queue.splice(i, 1); continue } // đã trả lời/đã nhận trong lúc nằm hàng đợi: không giao lại
      if (!origin || it.origin === origin) {
        queue.splice(i, 1)
        taken.push(it)
      } else i++
    }
    return taken
  }
  // canAck: poller (CLI/MCP) hứa sẽ gọi /api/ack. Poller gọi thẳng /api/poll không ack được nên coi như đã nhận ngay, tránh giao lặp.
  function deliver(res, list, who = '', canAck = false) {
    list.forEach((i) => {
      i.deliveredTo = { who, at: new Date().toISOString() }
      if (canAck) {
        i.status = 'delivered'
        setStatus(i.id, 'delivered')
        armAck(i)
      } else {
        i.status = 'received'
        i.receivedBy = who
        setStatus(i.id, 'received')
      }
    })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    // Nếu ghi thất bại (agent ngắt kết nối), đưa lại vào hàng đợi — không mất tin.
    res.end(JSON.stringify({ status: 'feedback', count: list.length, items: list }), (err) => {
      if (err) {
        list.forEach((i) => { clearAck(i.id); i.status = 'queued'; setStatus(i.id, 'queued') })
        queue.unshift(...list)
      }
    })
  }
  function wake() {
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]
      const list = takeFor(w.origin)
      if (list.length) {
        waiters.splice(i, 1)
        clearTimeout(w.timer)
        deliver(w.res, list, w.who, w.canAck)
        presence()
        return
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host || '').replace(/:\d+$/, '')
      if (!LOOPBACK.has(host)) return json(res, 403, { error: 'bad host' })
      const origin = req.headers.origin
      if (origin && !ORIGIN_OK.test(origin)) return json(res, 403, { error: 'origin not allowed' })
      cors(req, res)
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        return res.end()
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      const p = url.pathname

      if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, name: 'ui-feedback-bridge', listening: waiters.length })
      if (req.method === 'GET' && p === '/overlay.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(fs.readFileSync(OVERLAY_FILE))
      }
      if (req.method === 'GET' && p === '/api/handshake') {
        // Token chỉ cho trang loopback / extension (có header Origin do trình duyệt đặt).
        if (!origin) return json(res, 403, { error: 'browser origin required' })
        return json(res, 200, { token, listening: listeningFor(origin) })
      }
      if (!p.startsWith('/api/')) return json(res, 404, { error: 'not found' })
      if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' })

      if (req.method === 'GET' && p === '/api/status') return json(res, 200, {
        queued: queue.length,
        listening: waiters.length,
        pollers: waiters.map((w) => ({ origin: w.origin || null, who: w.who || null, since: w.since })),
        pending: [...items.values()].filter((i) => i.status === 'delivered' || i.status === 'received').map((i) => ({ id: i.id, status: i.status, origin: i.origin, who: i.deliveredTo?.who || null, at: i.deliveredTo?.at || null })),
      })

      if (req.method === 'GET' && p === '/api/history') {
        const o = url.searchParams.get('origin') || ''
        return json(res, 200, { permissions: pendingPerms(o), entries: thread.filter((e) => !o || e.origin === o || e.origin === ''), listening: o ? listeningFor(o) : waiters.length > 0 })
      }

      // Xóa lịch sử hội thoại của một origin (chỉ phần hiển thị; tin đang chờ giao vẫn được giao).
      if (req.method === 'POST' && p === '/api/history/clear') {
        const o = url.searchParams.get('origin') || ''
        let removed = 0
        for (let i = thread.length - 1; i >= 0; i--) {
          if (!o || thread[i].origin === o) { thread.splice(i, 1); removed++ } // tin origin '' dùng chung cho mọi site: không xóa khi chỉ xóa một site
        }
        // Dọn các tin đã xong của origin này khỏi bộ nhớ (tin đang chờ/đang xử lý giữ lại).
        for (const [id, it] of items) if ((!o || it.origin === o) && it.status === 'replied') items.delete(id)
        sendEvent({ type: 'clear', origin: o })
        return json(res, 200, { cleared: removed })
      }

      // Trạng thái mở khóa của (origin, thư mục): poll của CLI/MCP hỏi để agent tự đưa mã mới cho người dùng khi cần.
      if (req.method === 'GET' && p === '/api/permission/session') {
        const ck = normPath(url.searchParams.get('cwd') || '')
        const o = url.searchParams.get('origin') || ''
        const sess = sessionCodeFor(ck)
        const unlocked = !!o && isUnlocked(o, ck)
        const left = unlocked ? unlockLeft(o, ck) : 0
        // Sắp hết: còn dưới 10 phút (hoặc 1/6 thời hạn nếu cấu hình ngắn hơn) thì poll nhắc lại mã trước khi thẻ hiện lại.
        return json(res, 200, { unlocked, locked: !!sess?.locked, hasCode: !!sess, expiresInMs: left, expiring: unlocked && left < Math.min(10 * 60000, unlockMs / 6) })
      }

      if (req.method === 'GET' && p === '/api/permission/probe') return json(res, 200, { active: activeOrigins(url.searchParams.get('cwd') || '').length > 0 })

      if (req.method === 'POST' && p === '/api/permission') {
        const b = await readBody(req)
        const risk = riskyReason(b.tool, b.input, b.cwd)
        if (risk) return json(res, 200, { decision: 'none', reason: 'risky: ' + risk }) // không bao giờ duyệt từ trang
        const origins = activeOrigins(b.cwd)
        if (!origins.length) return json(res, 200, { decision: 'none', reason: 'no active ui feedback for this session' })
        const code = typeof b.code === 'string' && PERM_CODE.test(b.code.toUpperCase()) ? b.code.toUpperCase() : ''
        const input = b.input && typeof b.input === 'object' ? b.input : {}
        const detail = String(input.command ?? input.file_path ?? input.path ?? input.url ?? JSON.stringify(input) ?? '').slice(0, 1500)
        const waitMs = Math.min(Math.max(+b.timeoutMs || 100000, permMinMs), 600000)
        const id = 'pm_' + crypto.randomBytes(6).toString('hex')
        const pm = { id, tool: String(b.tool || '?').slice(0, 100), detail, cwd: String(b.cwd || '').slice(0, 300), cwdKey: normPath(b.cwd), who: String(b.who || '').slice(0, 200), origins, code, tries: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + waitMs).toISOString(), status: 'pending', res }
        pm.timer = setTimeout(() => finishPerm(pm, 'expired'), waitMs)
        perms.set(id, pm)
        // Hook bị tắt (người dùng đã trả lời ở terminal) thì gỡ thẻ xác nhận khỏi trang.
        res.on('close', () => { if (pm.status === 'pending') { pm.res = null; finishPerm(pm, 'cancelled') } })
        sendEvent({ type: 'permission', perm: pubPerm(pm) })
        return
      }

      if (req.method === 'POST' && p === '/api/permission/decide') {
        const b = await readBody(req)
        const pm = typeof b.id === 'string' ? perms.get(b.id) : null
        if (!pm) return json(res, 404, { error: 'unknown id' })
        if (pm.status !== 'pending') return json(res, 409, { error: 'already ' + pm.status })
        if (origin && !pm.origins.includes(origin)) return json(res, 403, { error: 'origin not allowed for this request' })
        if (b.decision !== 'allow' && b.decision !== 'deny') return json(res, 400, { error: 'decision must be allow or deny' })
        // Không đòi mã: lệnh rủi ro đã bị chặn ở /api/permission (không bao giờ có thẻ), còn lại overlay chỉ gửi quyết định từ click thật (isTrusted).
        finishPerm(pm, b.decision === 'allow' ? 'allowed' : 'denied', { message: b.decision === 'deny' ? 'Người dùng từ chối trên trang UI Feedback.' : undefined })
        return json(res, 200, { ok: true, status: pm.status })
      }

      if (req.method === 'POST' && p === '/api/feedback') {
        const b = await readBody(req)
        if (!b.note || typeof b.note !== 'string') return json(res, 400, { error: 'note required' })
        const pageOrigin = b.url ? new URL(b.url).origin : origin || ''
        let frames = []
        if (Array.isArray(b.stacks) && b.stacks.length) {
          try {
            frames = await symbolicate(b.metroOrigin || pageOrigin, b.stacks, fetchImpl)
          } catch (e) {
            frames = [{ error: e.message }]
          }
        }
        const id = 'fb_' + String(++seq).padStart(2, '0') + '_' + crypto.randomBytes(3).toString('hex')
        const el = b.element || {}
        const item = {
          id,
          createdAt: new Date().toISOString(),
          status: 'queued',
          url: b.url || null,
          origin: pageOrigin,
          viewport: b.viewport || null,
          note: b.note.slice(0, 4000),
          element: {
            tag: el.tag, testID: el.testID ?? null, text: el.text, selector: el.selector, rect: el.rect, style: el.style,
          },
          source: { components: Array.isArray(b.components) ? b.components.slice(0, 16) : [], frames },
        }
        items.set(id, item)
        const top = frames.find((f) => f.file)
        pushEntry({
          id, ts: item.createdAt, role: 'user', text: item.note, itemId: id, status: 'queued', origin: pageOrigin,
          element: el.tag ? { label: item.source.components.slice(0, 3).join(' › ') || String(el.tag).toLowerCase(), file: top ? `${top.file}:${top.line}` : null } : null,
        })
        queue.push(item)
        wake()
        return json(res, 200, { id, queued: true, listening: listeningFor(pageOrigin) })
      }

      if (req.method === 'GET' && p === '/api/poll') {
        const originFilter = url.searchParams.get('origin') || ''
        const timeout = Math.min(Math.max(+url.searchParams.get('timeout') || 600000, 0), 3600000)
        const who = String(url.searchParams.get('who') || '').slice(0, 200)
        const canAck = url.searchParams.get('ack') === '1'
        const list = takeFor(originFilter)
        if (list.length) return deliver(res, list, who, canAck)
        const w = { res, origin: originFilter, who, canAck, since: new Date().toISOString() }
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          json(res, 200, { status: 'timeout', count: 0, items: [] })
          presence()
        }, timeout)
        waiters.push(w)
        res.on('close', () => {
          const i = waiters.indexOf(w)
          if (i >= 0) {
            waiters.splice(i, 1)
            clearTimeout(w.timer)
            presence()
          }
        })
        presence()
        return
      }

      // Agent xác nhận đã nhận tin (poll của CLI/MCP tự gọi). Ack muộn sau khi tin bị trả về hàng đợi vẫn được nhận.
      if (req.method === 'POST' && p === '/api/ack') {
        const b = await readBody(req)
        const it = typeof b.id === 'string' ? items.get(b.id) : null
        if (!it) return json(res, 404, { error: 'unknown id' })
        if (it.status === 'queued') {
          const qi = queue.indexOf(it)
          if (qi >= 0) queue.splice(qi, 1)
        }
        // Ack muộn từ poller CŨ khi tin đã được giao lại cho poller khác: bỏ qua, không hủy hẹn giờ ack/trạng thái của poller hiện tại.
        const who = String(b.who || '').slice(0, 200)
        if (it.status === 'delivered' && who && it.deliveredTo?.who && it.deliveredTo.who !== who) return json(res, 200, { ok: true, status: it.status, stale: true })
        if (it.status === 'queued' || it.status === 'delivered') {
          clearAck(it.id)
          it.status = 'received'
          it.receivedBy = String(b.who || '').slice(0, 200)
          it.unacked = 0
          if (!it.deliveredTo) it.deliveredTo = { who: it.receivedBy, at: new Date().toISOString() }
          setStatus(it.id, 'received')
        }
        return json(res, 200, { ok: true, status: it.status })
      }

      if (req.method === 'POST' && p === '/api/reply') {
        const b = await readBody(req)
        if (!b.text || typeof b.text !== 'string') return json(res, 400, { error: 'text required' })
        const it = b.id ? items.get(b.id) : null
        if (b.id && !it) return json(res, 404, { error: 'unknown id' })
        if (it) {
          it.status = 'replied'
          clearAck(it.id)
          const qi = queue.indexOf(it) // ack timer có thể đã trả tin về hàng đợi: gỡ ra để không giao lại tin đã xong
          if (qi >= 0) queue.splice(qi, 1)
        }
        // Có id: theo origin của yêu cầu. Không id: theo origin agent khai báo (hợp lệ mới nhận), nếu không thì phát cho mọi site.
        const replyOrigin = it ? it.origin : typeof b.origin === 'string' && ORIGIN_OK.test(b.origin) ? b.origin : ''
        pushEntry({ id: 'msg_' + ++seq, ts: new Date().toISOString(), role: 'agent', text: b.text.slice(0, 4000), itemId: b.id || null, origin: replyOrigin })
        if (it) setStatus(b.id, 'replied')
        return json(res, 200, { ok: true })
      }

      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(`data: ${JSON.stringify(presenceState())}\n\n`)
        sse.add(res)
        const hb = setInterval(() => res.write(': hb\n\n'), 15000)
        res.on('close', () => {
          sse.delete(res)
          clearInterval(hb)
        })
        return
      }

      return json(res, 404, { error: 'not found' })
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'internal error' })
    }
  })

  return {
    token,
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve(server.address().port))
      }),
    close: () =>
      new Promise((resolve) => {
        for (const w of waiters) clearTimeout(w.timer)
        for (const pm of perms.values()) clearTimeout(pm.timer)
        for (const t of ackTimers.values()) clearTimeout(t)
        ackTimers.clear()
        for (const r of sse) r.end()
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
    _queue: queue,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = +process.env.UIFB_PORT || DEFAULT_PORT
  const b = createBridge({ port })
  b.listen()
    .then((p) => {
      fs.writeFileSync(path.join(stateDir(), 'server.json'), JSON.stringify({ port: p, pid: process.pid }))
      console.log(`ui-feedback-bridge listening on http://127.0.0.1:${p}`)
    })
    .catch((e) => {
      console.error('listen failed:', e.message)
      process.exit(1)
    })
  const bye = () => b.close().then(() => process.exit(0))
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
