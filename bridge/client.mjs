// Client dùng chung cho CLI và MCP: tự khởi động bridge nền, gọi API bằng token trong file.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, stateDir, loadOrCreateToken, riskyReason, ensureSessionCode } from './server.mjs'
import { listServes } from './serve.mjs'

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs')

export function baseUrl() {
  if (process.env.UIFB_URL) return process.env.UIFB_URL
  let port = +process.env.UIFB_PORT || DEFAULT_PORT
  try {
    port = JSON.parse(fs.readFileSync(path.join(stateDir(), 'server.json'), 'utf8')).port || port
  } catch {}
  return `http://127.0.0.1:${port}`
}

async function healthy(base) {
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) })
    return r.ok && (await r.json()).name === 'ui-feedback-bridge'
  } catch {
    return false
  }
}

export async function ensureServer() {
  const base = baseUrl()
  if (await healthy(base)) return base
  if (process.env.UIFB_URL) throw new Error('bridge không chạy tại ' + base)
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150))
    const b = baseUrl()
    if (await healthy(b)) return b
  }
  throw new Error('không khởi động được bridge')
}

export async function api(method, route, body, { signal } = {}) {
  const base = await ensureServer()
  const token = loadOrCreateToken()
  const r = await fetch(base + route, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`bridge ${r.status}: ${j.error || 'error'}`)
  return j
}

export const ack = (id, who) => api('POST', '/api/ack', { id, who })
export const pollerId = () => `pid ${process.pid} @ ${process.cwd()}`

// Có site đang chạy qua `serve` mà poll không lọc origin sẽ cướp tin của agent khác: bắt buộc khai origin.
export async function poll({ origin, timeoutMs, allowAny = false } = {}) {
  if (!origin && !allowAny) {
    const l = listServes()
    if (l.length) throw new Error(`thiếu origin. Đang có site: ${l.map((s) => 'http://localhost:' + s.port).join(', ')}. Truyền origin của site bạn phụ trách (hoặc --any để nhận mọi site).`)
  }
  const who = pollerId()
  const q = new URLSearchParams({ who, ack: '1' }) // ack=1: client này sẽ gọi /api/ack bên dưới
  if (origin) q.set('origin', origin)
  if (timeoutMs != null) q.set('timeout', String(timeoutMs))
  const r = await api('GET', '/api/poll?' + q)
  // Nhận được tin ở đây là bằng chứng tiến trình agent đã cầm tin: báo lại để trang hiện "Agent đã đọc".
  await Promise.all((r.items || []).map((it) => ack(it.id, who).catch(() => {})))
  // Khi có tin tới mà phiên chưa mở khóa (lần đầu, hết hạn 60 phút, hoặc mã bị khóa), tự chuẩn bị mã để agent nói cho người dùng NGAY
  // trước khi sửa code: lúc agent đang chạy công cụ bị hỏi quyền thì không còn làm được gì (đang chờ hook).
  return r
}

// origins: một hay nhiều origin (poll --any có thể nhận tin của nhiều site). Mã phiên là MỘT mã theo thư mục, còn mở khóa tính riêng từng origin,
// nên chỉ lấy/đổi mã một lần rồi liệt kê các origin còn phải nhập.
export async function permissionSession(origins, cwd = process.cwd()) {
  const list = [...new Set([].concat(origins).filter(Boolean))]
  if (!list.length) return null
  try {
    const sts = await Promise.all(list.map((o) => api('GET', '/api/permission/session?origin=' + encodeURIComponent(o) + '&cwd=' + encodeURIComponent(cwd)).then((st) => ({ o, st }))))
    const need = sts.filter((x) => !x.st.unlocked)
    const expiring = sts.filter((x) => x.st.unlocked && x.st.expiring)
    if (!need.length && !expiring.length) return { unlocked: true }
    if (!need.length) return { unlocked: true, expiring: true, minutesLeft: Math.max(1, Math.ceil(Math.min(...expiring.map((x) => x.st.expiresInMs)) / 60000)), code: ensureSessionCode(cwd).code, origins: expiring.map((x) => x.o) }
    const locked = sts.some((x) => x.st.locked)
    const { code, isNew } = ensureSessionCode(cwd, { rotate: locked })
    return { unlocked: false, code, rotated: locked, isNew, origins: need.map((x) => x.o) }
  } catch { return null }
}

// Đoạn chữ đưa vào kết quả poll để agent chuyển tiếp mã cho người dùng.
export function permissionNotice(p) {
  if (!p || !p.code) return ''
  const where = (p.origins || []).length > 1 ? ` Áp dụng cho các site: ${p.origins.join(', ')}.` : ''
  if (p.unlocked) return `permission_code: ${p.code}  (mở khóa còn khoảng ${p.minutesLeft} phút)
Nhắc người dùng một câu: phiên xin quyền sắp hết hạn, nếu thẻ hiện lại thì nhập lại mã ${p.code} (không đổi). Không cần làm gì khác.${where}`
  const why = p.rotated ? 'mã cũ bị khóa vì nhập sai nhiều lần nên đã đổi MÃ MỚI' : p.isNew ? 'mã mới tạo' : 'phiên chưa mở khóa hoặc đã hết hạn 60 phút'
  return `permission_code: ${p.code}  (${why})\nVIỆC CẦN LÀM NGAY, trước khi sửa code: nói nguyên văn mã này cho người dùng ("nếu thẻ xin quyền hiện, nhập mã ${p.code} một lần"). Khi bạn đang chạy công cụ bị hỏi quyền thì không còn kịp nói.${where}`
}

export const reply = (text, id, origin) => api('POST', '/api/reply', { text, id, origin })
export const status = () => api('GET', '/api/status')

export function formatItem(it) {
  const f = (it.source?.frames || []).filter((x) => x.file)
  const lines = [
    `# ${it.id}  ${it.url || ''}`,
    `note: ${it.note}`,
    it.element?.tag ? `element: <${(it.element.tag || '?').toLowerCase()}> text=${JSON.stringify(it.element?.text || '')}${it.element?.testID ? ` testID=${it.element.testID}` : ''}` : 'element: (tin nhắn tự do, không kèm phần tử)',
    `selector: ${it.element?.selector || ''}`,
    `rect: ${JSON.stringify(it.element?.rect || {})}  style: ${JSON.stringify(it.element?.style || {})}`,
    `components: ${(it.source?.components || []).join(' > ')}`,
    `source (mở các file này để sửa):`,
    ...(f.length ? f.map((x) => `  - ${x.element}${x.createdIn ? ' <- ' + x.createdIn : ''}  ${x.file}:${x.line}:${x.column}`) : ['  (không lấy được file nguồn; dùng selector/text/components)']),
  ]
  return lines.join('\n')
}

export function nextStep(count) {
  return count
    ? 'Sửa code theo các phản hồi trên, rồi chạy `tl-ui-feedback reply "<tóm tắt đã sửa>" --id <id>` cho từng phản hồi, sau đó chạy lại `tl-ui-feedback poll` để chờ tiếp. Không dừng vòng lặp trừ khi người dùng bảo dừng.'
    : 'Chưa có phản hồi. Chạy lại `tl-ui-feedback poll`; hàng đợi không mất tin.'
}

// Hook PermissionRequest (Claude Code và Codex dùng chung định dạng). Trả về JSON để in ra stdout, hoặc null = để agent hỏi như thường.
// Không tự khởi động bridge: bridge không chạy nghĩa là không có phiên UI nào để hỏi.
export async function permissionHook(input, { timeoutMs = 100000 } = {}) {
  const base = baseUrl()
  if (riskyReason(input.tool_name, input.tool_input, input.cwd)) return null // rủi ro (rm, git push...): luôn hỏi ở terminal, không in mã
  if (!(await healthy(base))) return null
  // Mã xác nhận một lần: chỉ in ra terminal của agent, trang web không đọc được. Người dùng gõ mã vào thẻ trên trang mới "Cho phép" được.
  const code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase()
  const auth = { authorization: 'Bearer ' + loadOrCreateToken() }
  const probe = await fetch(base + '/api/permission/probe?cwd=' + encodeURIComponent(input.cwd || ''), { headers: auth, signal: AbortSignal.timeout(5000) }).then((x) => x.json()).catch(() => ({}))
  if (!probe.active) return null // không có yêu cầu UI nào của phiên này: không in mã, để agent hỏi như thường
  let r
  try {
    r = await fetch(base + '/api/permission', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + loadOrCreateToken(), 'content-type': 'application/json' },
      body: JSON.stringify({ tool: input.tool_name, input: input.tool_input, cwd: input.cwd, who: pollerId(), code, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10000),
    })
  } catch {
    // Mất kết nối giữa chừng: thẻ không còn chờ, mã vừa in không còn dùng được. Nói rõ rồi để agent hỏi ở terminal.
    try { process.stderr.write('[tl-ui-feedback] yêu cầu quyền không còn chờ trên trang; bỏ qua mã vừa in, hãy trả lời ở terminal.\n') } catch {}
    return null
  } finally { try { fs.rmSync(codeFile(), { force: true }) } catch {} }
  const j = await r.json().catch(() => ({}))
  if (j.decision === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  if (j.decision === 'deny') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: j.message || 'Người dùng từ chối trên trang UI Feedback.' } } }
  return null
}

// In mã ra terminal của agent: stderr (hook hiển thị) và, nếu mở được, thẳng thiết bị tty để không bị agent nuốt.
export const codeFile = () => path.join(stateDir(), 'perm-code-' + process.pid + '.txt')
// Các yêu cầu đang chờ (mỗi hook một file, nên chạy song song không ghi đè nhau). File quá 10 phút là của hook đã chết: dọn đi.
export function pendingCodes() {
  const out = []
  let names = []
  try { names = fs.readdirSync(stateDir()).filter((n) => /^perm-code-\d+\.txt$/.test(n)) } catch {}
  for (const n of names) {
    const f = path.join(stateDir(), n)
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > 10 * 60000) { fs.rmSync(f, { force: true }); continue }
      out.push(fs.readFileSync(f, 'utf8').trim())
    } catch {}
  }
  return out.filter(Boolean)
}
// Mã cũng ghi vào file 0600 (trang web không đọc được file) để `tl-ui-feedback permission-code` in lại nếu hook không hiện được ra terminal.
function showCode(code, tool) {
  try { fs.writeFileSync(codeFile(), code + '  (' + (tool || '?') + ')\n', { mode: 0o600 }) } catch {}
  const line = `[tl-ui-feedback] Agent xin quyền chạy ${tool || '?'}. Muốn Cho phép từ trang web, nhập mã: ${code}\n`
  try { process.stderr.write(line) } catch {}
  try { fs.appendFileSync(process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty', line) } catch {}
}
