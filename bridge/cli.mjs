#!/usr/bin/env node
// tl-ui-feedback: start | poll | reply | status | serve | install | uninstall | stop | token | url
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureServer, poll, reply, status, formatItem, nextStep, baseUrl, permissionHook, pendingCodes, permissionNotice } from './client.mjs'
import { stateDir, loadOrCreateToken, ensureSessionCode } from './server.mjs'
import { startServe, stopServe, listServes, runDevCommand } from './serve.mjs'
import * as inst from './install.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Đăng ký MCP ở phạm vi user của Claude Code.
function installMcp() {
  const mcp = path.join(ROOT, 'mcp', 'server.mjs')
  spawnSync('claude mcp remove --scope user ui-feedback', { shell: true, stdio: 'ignore' }) // dọn tên cũ
  spawnSync('claude mcp remove --scope user tl-ui-feedback', { shell: true, stdio: 'ignore' })
  // shell:true không tự bọc ngoặc: dùng `node` qua PATH và bọc đường dẫn script (có thể chứa khoảng trắng).
  const r = spawnSync(`claude mcp add --scope user tl-ui-feedback -- node "${mcp}"`, { shell: true, stdio: 'inherit' })
  if (r.status !== 0) throw new Error('claude mcp add thất bại; chạy tay: claude mcp add --scope user tl-ui-feedback -- node "' + mcp + '"')
}

function uninstallMcp() {
  spawnSync('claude mcp remove --scope user ui-feedback', { shell: true, stdio: 'ignore' }) // tên cũ
  const r = spawnSync('claude mcp remove --scope user tl-ui-feedback', { shell: true, stdio: 'ignore' })
  return r.status === 0
}
function installShim(addPath) {
  const bin = inst.defaultBinDir()
  inst.installShim({ root: ROOT, binDir: bin })
  console.log('lệnh `tl-ui-feedback` đã ghi vào:', bin)
  if (inst.onPath(bin)) return console.log('Thư mục này đã nằm trong PATH.')
  if (addPath) {
    const r = inst.addToUserPath(bin)
    if (!r.unsupported) return console.log(r.changed ? 'Đã thêm vào PATH người dùng. Mở terminal MỚI để dùng lệnh.' : 'PATH người dùng đã có thư mục này; mở terminal MỚI.')
  }
  console.log(inst.pathHint(bin) + (addPath ? '' : '\n(hoặc chạy lại với --path để tự thêm trên Windows)'))
}

const [cmd, ...rest] = process.argv.slice(2)

// In mã xác nhận của yêu cầu xin quyền đang chờ (dự phòng khi hook không hiện được mã ra terminal của agent).
// Mã phiên của thư mục hiện tại (cwd của agent): tạo nếu chưa có; --new để xin mã mới (mã cũ mất hiệu lực).
if (cmd === 'permission-code') {
  const { code, isNew } = ensureSessionCode(process.cwd(), { rotate: rest.includes('--new') })
  console.log(`Mã xác nhận phiên: ${code}${rest.includes('--new') ? ' (mã MỚI, mã cũ đã hết hiệu lực)' : isNew ? ' (mới tạo)' : ''}`)
  console.log('Nhập mã này một lần vào thẻ "Agent xin quyền" trên trang để mở khóa Cho phép cho cả phiên (60 phút kể từ lần duyệt gần nhất).')
  for (const per of pendingCodes()) console.log('Yêu cầu xin quyền đang chờ có mã riêng (chỉ cho đúng yêu cầu đó, không mở khóa phiên): ' + per)
  process.exit(0)
}

// Hook xin quyền: phải im lặng và thoát 0 khi có bất kỳ lỗi nào để agent hỏi người dùng như thường.
if (cmd === 'permission-hook') {
  try {
    let text = ''
    for await (const ch of process.stdin) text += ch
    const out = await permissionHook(JSON.parse(text || '{}'))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch {}
  process.exit(0)
}

const flag = (n) => {
  const i = rest.indexOf('--' + n)
  return i >= 0 ? rest[i + 1] : undefined
}
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')))

const HELP = `tl-ui-feedback <lệnh>
  start                     chạy bridge ở nền (tự chạy khi cần)
  poll [--origin URL | --any] [--timeout-ms N] [--json]   chờ phản hồi (có serve đang chạy thì bắt buộc --origin)
  reply "<văn bản>" [--id fb_..] [--origin URL]  trả lời, hiện trên trang (không id thì nên truyền --origin)
  status                    số phản hồi đang chờ / agent đang nghe
  serve [cổng] <thư-mục|file.html|http://localhost:PORT> [--spa] [--no-open] [--allow-remote-upstream]
                            phục vụ site (hoặc proxy tới dev server) kèm overlay; bỏ cổng thì tự chọn cổng trống
                            --cmd "<lệnh>" (với URL): tự chạy dev server, chờ sẵn sàng rồi mới mở proxy; --wait <giây> (mặc định 60)
  serve --list | serve --stop <cổng>
  install [--path] | install-skill | install-mcp | install-shim [--path]   (--path: tự thêm thư mục lệnh vào PATH người dùng, Windows) cài skill, MCP (phạm vi user) và lệnh tl-ui-feedback vào máy
  install-hooks | uninstall-hooks   thêm/gỡ hook xin quyền (PermissionRequest) vào Claude Code (~/.claude/settings.json) và Codex (~/.codex/hooks.json)
  permission-code [--new]   in mã xác nhận phiên của thư mục hiện tại (nhập một lần vào thẻ xin quyền trên trang); --new để xin mã mới
  permission-hook           (do agent gọi) chuyển yêu cầu xin quyền lên trang để bạn bấm Cho phép/Từ chối
  uninstall                 gỡ skill, MCP và shim (chỉ những gì install đã cài)
  url | token | stop`

try {
  if (cmd === 'start') {
    console.log('bridge:', await ensureServer())
  } else if (cmd === 'poll') {
    const r = await poll({ origin: flag('origin'), timeoutMs: flag('timeout-ms') != null ? +flag('timeout-ms') : undefined, allowAny: rest.includes('--any') })
    if (rest.includes('--json')) console.log(JSON.stringify(r, null, 2))
    else {
      console.log(`status: ${r.status}  count: ${r.count}`)
      for (const it of r.items) console.log('\n' + formatItem(it))
      if (permissionNotice(r.permission)) console.log('\n' + permissionNotice(r.permission))
      console.log('\nnext_step: ' + nextStep(r.count))
    }
  } else if (cmd === 'reply') {
    if (!positional[0]) throw new Error('thiếu nội dung trả lời')
    console.log(JSON.stringify(await reply(positional[0], flag('id'), flag('origin'))))
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await status()))
  } else if (cmd === 'install' || cmd === 'install-skill' || cmd === 'install-mcp' || cmd === 'install-shim') {
    if (cmd === 'install' || cmd === 'install-skill') console.log('skill đã cài:', inst.installSkill({ root: ROOT }))
    if (cmd === 'install' || cmd === 'install-mcp') installMcp()
    if (cmd === 'install' || cmd === 'install-shim') installShim(rest.includes('--path'))
    if (cmd !== 'install-shim') {
      const dup = inst.enabledPlugins()
      if (dup.length) console.log(`CẢNH BÁO: plugin ${dup.join(', ')} đang bật cùng bản install này, skill và MCP sẽ bị nạp trùng. Chọn MỘT: gỡ plugin (claude plugin uninstall ${dup[0]}) hoặc chạy \`tl-ui-feedback uninstall\`.`)
      console.log('Mở phiên Claude Code MỚI để nạp skill và tool MCP.')
    }
  } else if (cmd === 'install-hooks') {
    for (const r of inst.installHooks({ root: ROOT })) console.log(r.error ? r.agent + ': LỖI, không sửa ' + r.file + ' (' + r.error + ')' : r.skipped ? r.agent + ': bỏ qua (chưa có thư mục cấu hình)' : r.agent + ': đã thêm hook vào ' + r.file)
    console.log('Mở phiên agent MỚI để nạp hook. Codex có thể hỏi bạn tin cậy hook mới ở lần chạy đầu (/hooks). Hook chỉ hoạt động khi đang có yêu cầu UI chưa được trả lời; còn lại agent hỏi như thường.')
  } else if (cmd === 'uninstall-hooks') {
    for (const r of inst.uninstallHooks()) console.log(r.agent + ': ' + (r.changed ? 'đã gỡ hook khỏi ' + r.file : 'không có hook của tl-ui-feedback'))
  } else if (cmd === 'uninstall') {
    console.log(inst.uninstallSkill() ? 'đã gỡ skill' : 'không có skill tl-ui-feedback của chúng ta để gỡ')
    console.log(uninstallMcp() ? 'đã gỡ MCP tl-ui-feedback' : 'không gỡ được MCP (chưa đăng ký, hoặc chưa có lệnh claude)')
    console.log(inst.removeShim() ? 'đã gỡ lệnh tl-ui-feedback' : 'không có shim để gỡ')
    console.log('Nếu đã thêm thư mục bin vào PATH, hãy tự bỏ dòng đó. Trạng thái trong ~/.ui-feedback-bridge/ được giữ nguyên.')
  } else if (cmd === 'serve') {
    if (rest[0] === '--list') {
      const l = listServes()
      console.log(l.length ? l.map((s) => `${s.port}  ${s.mode}  ${s.site}  pid ${s.pid}`).join('\n') : 'không có site nào đang chạy')
    } else if (rest[0] === '--stop') {
      if (!rest[1]) throw new Error('thiếu cổng: serve --stop <cổng>')
      console.log(stopServe(rest[1]) ? `đã dừng ${rest[1]}` : `không có site nào ở cổng ${rest[1]}`)
    } else {
      const valueFlags = new Set(['cmd', 'wait'])
      const args = []
      const opts = {}
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]
        if (!a.startsWith('--')) args.push(a)
        else if (valueFlags.has(a.slice(2))) opts[a.slice(2)] = rest[++i]
        else opts[a.slice(2)] = true
      }
      const USAGE = 'dùng: serve [cổng] <thư-mục|file.html|URL> [--cmd "<lệnh dev server>"] [--wait <giây>] [--spa] [--no-open] [--allow-remote-upstream]  (bỏ cổng thì tự chọn cổng trống)'
      // Một đối số là site (cổng tự chọn); hai đối số thì đối số đầu phải là cổng.
      if (args.length === 1 && /^\d+$/.test(args[0])) throw new Error('thiếu site sau cổng ' + args[0] + '. ' + USAGE)
      if (args.length < 1 || args.length > 2 || (args.length === 2 && !/^\d+$/.test(args[0]))) throw new Error(USAGE)
      const [port, site] = args.length === 2 ? [+args[0], args[1]] : [0, args[0]]
      const isUrl = /^https?:\/\//i.test(site)
      if ('cmd' in opts && (!opts.cmd || opts.cmd.startsWith('--'))) throw new Error('--cmd cần một lệnh, vd --cmd "npx expo start --web --port 8081"')
      if (opts.cmd && !isUrl) throw new Error('--cmd chỉ dùng với site là URL của dev server mà lệnh sẽ mở, vd http://localhost:8081')
      const waitS = opts.wait !== undefined ? +opts.wait : 60
      if (!(waitS > 0)) throw new Error('--wait phải là số giây > 0')
      let dev = null
      if (opts.cmd) {
        console.error(`đang chạy: ${opts.cmd}  (chờ ${site} tối đa ${waitS} giây)`)
        dev = await runDevCommand({ command: opts.cmd, upstream: site, timeoutMs: waitS * 1000 })
      }
      let s
      try {
        const bridgeUrl = await ensureServer()
        s = await startServe({ port, site, bridgeUrl, spa: !!opts.spa, allowRemote: !!opts['allow-remote-upstream'], childPid: dev ? dev.pid : null })
      } catch (e) {
        dev?.stop()
        throw e
      }
      const url = `http://localhost:${s.port}`
      console.log(`đang phục vụ ${isUrl ? 'proxy tới ' + site : path.resolve(site)} tại ${url}  (Ctrl+C để dừng)`)
      if (!opts['no-open']) {
        const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
        spawnSync(c, a, { stdio: 'ignore' })
      }
      const bye = () => { dev?.stop(); return s.close().then(() => process.exit(0)) }
      process.on('SIGINT', bye)
      process.on('SIGTERM', bye)
      dev?.child.on('exit', (code) => {
        console.error(`lệnh dev server đã thoát (mã ${code}); dừng serve`)
        s.close().then(() => process.exit(1))
      })
      await new Promise(() => {}) // giữ tiến trình sống tới khi nhận tín hiệu
    }
  } else if (cmd === 'url') {
    console.log(baseUrl())
  } else if (cmd === 'token') {
    console.log(loadOrCreateToken())
  } else if (cmd === 'stop') {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(stateDir(), 'server.json'), 'utf8'))
      process.kill(pid)
      console.log('stopped', pid)
    } catch {
      console.log('bridge không chạy')
    }
  } else {
    console.log(HELP)
  }
} catch (e) {
  console.error('lỗi:', e.message)
  process.exit(1)
}
