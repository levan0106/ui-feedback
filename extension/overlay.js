/* UI Feedback Bridge — overlay chạy trong trang (MAIN world).
 * Dùng chung cho extension (content script) và dòng dev-only (<script src=".../overlay.js">).
 * Nút nổi "Feedback" mở khung chat: lịch sử yêu cầu của bạn + phản hồi của agent + trạng thái.
 * Chọn phần tử: nút "Chọn phần tử" hoặc Alt+Shift+K → rê (khung xanh) → click (chọn lại bao nhiêu lần tùy ý, chế độ chọn giữ bật) → gõ ghi chú → Gửi. Esc, nút hoặc Alt+Shift+K để tắt chế độ chọn.
 * Cũng có thể gửi tin nhắn tự do không kèm phần tử.
 */
;(function () {
  'use strict'
  if (window.__UIFB_LOADED__) return
  window.__UIFB_LOADED__ = true
  if (window.top !== window) return // chỉ khung chính

  var BRIDGE = (window.__UIFB__ && window.__UIFB__.bridge) || 'http://127.0.0.1:47831'
  var token = null
  var es = null
  var listening = false
  var picking = false
  var current = null // phần tử đang rê
  var picked = null // dữ liệu phần tử đã chọn, chờ gửi cùng ghi chú
  var open = false
  var unread = 0
  var entries = [] // lịch sử hội thoại của origin này
  var perms = [] // yêu cầu xin quyền của agent đang chờ bạn quyết định
  var connecting = null

  var STATUS = { queued: 'Đang chờ agent', delivered: 'Đã giao cho agent, chờ xác nhận', received: 'Agent đã đọc, đang xử lý', replied: 'Đã trả lời' }

  // ---------- UI (shadow DOM để không lẫn với app) ----------
  var host = document.createElement('div')
  host.setAttribute('data-uifb', '1')
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'
  var root = host.attachShadow({ mode: 'open' })
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font:13px/1.45 system-ui,Segoe UI,sans-serif}' +
    '.fab{position:fixed;right:14px;bottom:14px;pointer-events:auto;display:flex;align-items:center;gap:6px;padding:7px 11px;border-radius:99px;border:1px solid #c9ced8;background:#fff;color:#1d2433;cursor:pointer;box-shadow:0 2px 8px #0003;opacity:.9}' +
    '.fab:hover,.fab.on{opacity:1}.fab.on{background:#2f5bd8;color:#fff;border-color:#2f5bd8}' +
    '.badge{display:none;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#b3261e;color:#fff;font-size:11px;line-height:18px;text-align:center}' +
    '.dot{width:8px;height:8px;border-radius:50%;background:#9aa3b5}.dot.live{background:#22a06b}.dot.work{background:#e0a100;animation:pulse 1.2s ease-in-out infinite}' +
    '@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}@keyframes bounce{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}' +
    '.typing{align-self:flex-start;display:flex;align-items:center;gap:8px;background:#eef1f7;border-radius:10px;border-bottom-left-radius:3px;padding:8px 12px;color:#5d6678;white-space:nowrap;max-width:100%}' +
    '.typing .d{width:6px;height:6px;border-radius:50%;background:#8a93a6;animation:bounce 1.2s infinite}.typing .d:nth-child(2){animation-delay:.15s}.typing .d:nth-child(3){animation-delay:.3s}' +
    '@media (prefers-reduced-motion:reduce){.dot.work,.typing .d{animation:none;opacity:1}}' +
    '.box{position:fixed;border:2px solid #2f5bd8;background:#2f5bd822;border-radius:3px;display:none}' +
    '.tag{position:fixed;background:#2f5bd8;color:#fff;padding:1px 6px;border-radius:3px;font-size:11px;display:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}' +
    '.chat{position:fixed;right:14px;bottom:56px;width:360px;max-width:calc(100vw - 28px);height:min(480px,calc(100vh - 80px));pointer-events:auto;display:none;flex-direction:column;background:#fff;color:#1d2433;border:1px solid #c9ced8;border-radius:12px;box-shadow:0 8px 30px #0004;overflow:hidden}' +
    '.chat.open{display:flex}' +
    '.hd{display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid #e3e6ee;background:#f6f7fa;white-space:nowrap}' +
    '.hd .t{font-weight:600;flex:none}.hd .pres{font-size:11px;color:#5d6678;margin-right:auto;display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden;text-overflow:ellipsis}.hd button{flex:none}' +
    'button.b{border:1px solid #c9ced8;background:#fff;color:#1d2433;border-radius:6px;padding:3px 9px;cursor:pointer}' +
    'button.b:hover{background:#eef1f7}button.b.p{background:#2f5bd8;border-color:#2f5bd8;color:#fff}button.b.p:disabled{opacity:.5;cursor:default}' +
    'button.b.on{background:#2f5bd8;color:#fff;border-color:#2f5bd8}' +
    '.list{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:9px;background:#fff}' +
    '.list{scrollbar-width:thin;scrollbar-color:transparent transparent}.list:hover{scrollbar-color:#c9ced8 transparent}' +
    '.list::-webkit-scrollbar{width:6px}.list::-webkit-scrollbar-thumb{background:transparent;border-radius:3px}.list:hover::-webkit-scrollbar-thumb{background:#c9ced8}' +
    '.rz{position:absolute;left:0;top:0;width:16px;height:16px;cursor:nwse-resize;z-index:1;touch-action:none;background:linear-gradient(135deg,#8a93a688 0 2px,transparent 2px 4px,#8a93a688 4px 6px,transparent 6px)}' +
    '.perm{align-self:stretch;border:1px solid #e0a100;background:#fff8e6;border-radius:10px;padding:9px 10px;color:#1d2433}.perm .ph{font-weight:600;margin-bottom:4px}' +
    '.perm pre{margin:4px 0 8px;max-height:140px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;border:1px solid #ecd9a6;border-radius:6px;padding:6px;font:11.5px/1.4 ui-monospace,Consolas,monospace}.perm .pw{font-size:11px;color:#5d6678;margin-bottom:6px}.perm .pb{display:flex;gap:6px;justify-content:flex-end}.perm .pc{flex:1;min-width:0;border:1px solid #ecd9a6;border-radius:6px;padding:4px 6px;font:12px ui-monospace,Consolas,monospace;text-transform:uppercase}' +
    'button.b.ok{background:#1e7a4a;border-color:#1e7a4a;color:#fff}button.b.no{color:#b3261e;border-color:#e5b5b1}' +
    '.empty{margin:auto;text-align:center;color:#8a93a6;padding:0 14px}' +
    '.g{display:flex;flex-direction:column;max-width:88%}.g.u{align-self:flex-end;align-items:flex-end}.g.a{align-self:flex-start;align-items:flex-start}' +
    '.m{max-width:100%;padding:7px 10px;border-radius:10px;overflow-wrap:anywhere;white-space:pre-wrap}' +
    '.m.u{background:#2f5bd8;color:#fff;border-bottom-right-radius:3px}' +
    '.m.a{background:#eef1f7;border-bottom-left-radius:3px}' +
    '.meta{font-size:11px;margin-top:3px;color:#5d6678;white-space:normal}.g.u .meta{text-align:right}' +
    '.chip{display:block;max-width:100%;margin-top:4px;padding:0 6px;border-radius:4px;background:#ffffff30;font:11px ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.st.replied{color:#1e7a4a}' +
    '.cmp{border-top:1px solid #e3e6ee;padding:8px;background:#f6f7fa}' +
    '.sel{display:none;align-items:center;gap:6px;margin-bottom:6px;font-size:12px;color:#1d2433}.sel.show{display:flex}' +
    '.sel .lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#e3ebff;border-radius:5px;padding:2px 7px}' +
    'textarea{width:100%;height:58px;resize:none;border:1px solid #c9ced8;border-radius:6px;padding:6px;color:#1d2433;background:#fff}' +
    '.row{display:flex;gap:6px;justify-content:flex-end;margin-top:6px;align-items:center}.row .msg{flex:1;font-size:11px;color:#b3261e;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row button{flex:none;white-space:nowrap}' +
    '</style>' +
    '<div class="box"></div><div class="tag"></div>' +
    '<div class="chat"><div class="rz" title="Kéo để đổi kích thước"></div><div class="hd"><span class="t">UI Feedback</span><span class="pres"><span class="dot"></span><span class="ptxt">Chưa kết nối</span></span>' +
    '<button class="b" data-a="clear" title="Xóa lịch sử hội thoại">Xóa</button><button class="b" data-a="close" title="Đóng">×</button></div>' +
    '<div class="list"></div>' +
    '<div class="cmp"><div class="sel"><span class="lbl"></span><button class="b" data-a="unpick" title="Bỏ phần tử đã chọn">×</button></div>' +
    '<textarea placeholder="Ghi chú: sai ở đâu? (Ctrl+Enter để gửi)"></textarea>' +
    '<div class="row"><button class="b" data-a="pick" title="Chọn phần tử trên trang (Alt+Shift+K)">Chọn phần tử</button><span class="msg"></span><button class="b p" data-a="send">Gửi cho agent</button></div></div></div>' +
    '<button class="fab" title="Mở khung chat phản hồi UI"><span class="dot"></span><span>Feedback</span><span class="badge"></span></button>'
  var $ = function (s) { return root.querySelector(s) }
  var box = $('.box'), tag = $('.tag'), chat = $('.chat'), list = $('.list'), ta = $('textarea'), msg = $('.msg')
  var fab = $('.fab'), fabDot = $('.fab .dot'), badge = $('.badge'), pres = $('.pres .dot'), ptxt = $('.ptxt')
  var selBox = $('.sel'), selLbl = $('.sel .lbl'), pickBtn = $('[data-a="pick"]')
  function mount() { (document.body || document.documentElement).appendChild(host) }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)

  // ---------- Kết nối bridge ----------
  function auth() { return { authorization: 'Bearer ' + token } }
  function connect() {
    if (token) return Promise.resolve(token)
    if (connecting) return connecting
    connecting = fetch(BRIDGE + '/api/handshake').then(function (r) {
      if (!r.ok) throw new Error('handshake ' + r.status)
      return r.json()
    }).then(function (j) {
      token = j.token
      setPresence(j.listening)
      openEvents()
      return loadHistory().then(function () { return token })
    }).catch(function (e) { connecting = null; throw e })
    return connecting
  }
  function loadHistory() {
    return fetch(BRIDGE + '/api/history?origin=' + encodeURIComponent(location.origin), { headers: auth() })
      .then(function (r) { return r.json() })
      .then(function (j) { entries = j.entries || []; perms = j.permissions || []; setPresence(j.listening); render() })
      .catch(function () {})
  }
  // Agent "đang làm việc" = có yêu cầu đã giao cho agent nhưng chưa được trả lời.
  function isWorking() { return entries.some(function (e) { return e.role === 'user' && e.status === 'received' }) }
  function updateHeader() {
    var w = isWorking() || perms.length > 0
    var cls = 'dot' + (w ? ' work' : listening ? ' live' : '')
    fabDot.className = cls
    pres.className = cls
    ptxt.textContent = perms.length ? 'Chờ bạn cho phép' : w ? 'Agent đang làm việc…' : listening ? 'Agent đang nghe' : 'Chưa có agent'
  }
  function setPresence(on) {
    listening = !!on
    updateHeader()
    if (open) render()
  }
  function mine(e) { return !e.origin || e.origin === location.origin }
  function openEvents() {
    if (es || !token) return
    es = new EventSource(BRIDGE + '/api/events?token=' + encodeURIComponent(token))
    es.onmessage = function (ev) {
      var d; try { d = JSON.parse(ev.data) } catch (_) { return }
      if (d.type === 'presence') setPresence(d.origins ? d.any || d.origins.indexOf(location.origin) >= 0 : d.listening)
      else if (d.type === 'clear') {
        if (!d.origin || d.origin === location.origin) { entries = entries.filter(function (e) { return d.origin && e.origin === '' }); render() } // tin origin '' dùng chung, server giữ lại
      } else if (d.type === 'permission') {
        if (d.perm && d.perm.origins.indexOf(location.origin) >= 0 && !perms.some(function (x) { return x.id === d.perm.id })) {
          perms.push(d.perm)
          if (!open) setOpen(true, true)
          render(true)
        }
      } else if (d.type === 'permission-unlock') {
        // Đã nhập mã đúng cho (origin, thư mục): các thẻ đang chờ cùng phiên không cần nhập thêm.
        if (d.origin === location.origin) {
          perms.forEach(function (x) { if (x.cwdKey === d.cwdKey && (x.unlockedOrigins || []).indexOf(d.origin) < 0) (x.unlockedOrigins = x.unlockedOrigins || []).push(d.origin) })
          render()
        }
      } else if (d.type === 'permission-done') {
        perms = perms.filter(function (x) { return x.id !== d.id }); render()
      } else if (d.type === 'message' && mine(d.entry)) {
        var i = entries.findIndex(function (x) { return x.id === d.entry.id })
        if (i >= 0) entries[i] = d.entry
        else {
          entries.push(d.entry)
          if (d.entry.role === 'agent' && !open) { unread++; updateBadge() }
        }
        render()
      } else if (d.type === 'status') {
        var e = entries.find(function (x) { return x.id === d.id })
        if (e) { e.status = d.status; e.unacked = d.unacked || 0; render() }
      }
    }
  }
  function updateBadge() {
    badge.style.display = unread > 0 ? 'inline-block' : 'none'
    badge.textContent = String(unread)
  }

  // ---------- Hiển thị hội thoại ----------
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) }
  function render(stick) {
    updateHeader()
    if (!open) return
    var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    list.textContent = ''
    if (!entries.length) {
      var em = document.createElement('div')
      em.className = 'empty'
      em.textContent = 'Chưa có hội thoại. Bấm "Chọn phần tử" rồi click vào phần UI cần sửa, hoặc gõ tin nhắn bên dưới.'
      list.appendChild(em)
    }
    entries.forEach(function (e) {
      var side = e.role === 'user' ? 'u' : 'a'
      var g = document.createElement('div')
      g.className = 'g ' + side
      var m = document.createElement('div')
      m.className = 'm ' + side
      var t = document.createElement('div')
      t.textContent = e.text
      m.appendChild(t)
      if (e.element) {
        var c = document.createElement('span')
        c.className = 'chip'
        c.textContent = e.element.label + (e.element.file ? ' · ' + e.element.file.split('/').slice(-2).join('/') : '')
        c.title = e.element.file || ''
        m.appendChild(c)
      }
      g.appendChild(m)
      var meta = document.createElement('div')
      meta.className = 'meta'
      var s = document.createElement('span')
      s.className = 'st' + (e.status === 'replied' ? ' replied' : '')
      s.textContent = hhmm(e.ts) + (e.role === 'user' && e.status ? ' · ' + (e.status === 'queued' && e.unacked ? 'Agent chưa xác nhận, đang chờ giao lại' : e.status === 'queued' && !listening ? 'Chưa có agent nghe, đang nằm trong hàng đợi' : STATUS[e.status] || e.status) : '')
      meta.appendChild(s)
      g.appendChild(meta)
      list.appendChild(g)
    })
    perms.forEach(function (p) {
      var c = document.createElement('div')
      c.className = 'perm'
      var h = document.createElement('div'); h.className = 'ph'; h.textContent = 'Agent xin quyền chạy: ' + p.tool
      var pre = document.createElement('pre'); pre.textContent = p.detail || '(không có chi tiết)'
      var w = document.createElement('div'); w.className = 'pw'; w.textContent = (p.cwd ? 'Thư mục: ' + p.cwd + ' · ' : '') + 'hết hạn lúc ' + hhmm(p.expiresAt) + ' thì agent hỏi lại ở terminal'
      var bar = document.createElement('div'); bar.className = 'pb'
      var code = null
      ;[['deny', 'Từ chối', 'no'], ['allow', 'Cho phép', 'ok']].forEach(function (x) {
        var b = document.createElement('button'); b.className = 'b ' + x[2]; b.textContent = x[1]
        b.addEventListener('click', function (ev) {
          if (!ev.isTrusted) return
          if (x[0] === 'allow' && code && !code.value.trim()) { msg.textContent = 'Nhập mã xác nhận hiện ở terminal của agent (hoặc chạy tl-ui-feedback permission-code).'; code.focus(); return }
          decide(p.id, x[0], b, code ? code.value : '')
        })
        bar.appendChild(b)
      })
      c.appendChild(h); c.appendChild(pre); c.appendChild(w); c.appendChild(bar)
      list.appendChild(c)
    })
    if (isWorking()) {
      var ty = document.createElement('div')
      ty.className = 'typing'
      ty.setAttribute('data-uifb-working', '1')
      ty.innerHTML = '<span class="d"></span><span class="d"></span><span class="d"></span>'
      var tt = document.createElement('span')
      tt.textContent = 'Agent đang xử lý…'
      ty.appendChild(tt)
      list.appendChild(ty)
    }
    if (atBottom || stick || !render.once) list.scrollTop = list.scrollHeight
    render.once = true
  }
  // Chỉ click thật của người dùng (isTrusted) mới quyết định được; trang không tự duyệt bằng click giả.
  function decide(id, decision, btn, code) {
    btn.disabled = true
    fetch(BRIDGE + '/api/permission/decide', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ id: id, decision: decision, code: code || '' }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok && r.status !== 409) throw new Error(j.error || r.status) }) })
      .then(function () { perms = perms.filter(function (x) { return x.id !== id }); render() })
      .catch(function (e) { btn.disabled = false; msg.textContent = 'Không gửi được quyết định: ' + e.message })
  }
  function setOpen(v, noPick) {
    open = v
    chat.classList.toggle('open', v)
    fab.classList.toggle('on', v)
    if (!v && picking) stopPicking()
    if (v) {
      unread = 0
      updateBadge()
      connect().then(function () { clampChat(); render(); list.scrollTop = list.scrollHeight; if (open && !noPick && !picking && !picked) startPicking() }).catch(function () {
        list.textContent = ''
        var em = document.createElement('div')
        em.className = 'empty'
        em.textContent = 'Không kết nối được bridge (' + BRIDGE + '). Chạy: node bridge/cli.mjs start'
        list.appendChild(em)
      })
      render()
    }
  }

  // ---------- Trích xuất thông tin phần tử ----------
  function nameOf(t) {
    return t && (t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && nameOf(t.type))) || null
  }
  function fiberOf(el) {
    var k = Object.keys(el).find(function (x) { return x.indexOf('__reactFiber$') === 0 })
    return k ? el[k] : null
  }
  function cssPath(el) {
    var parts = []
    for (var n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      var tid = n.getAttribute('data-testid')
      if (tid) { parts.unshift('[data-testid="' + tid.replace(/"/g, '\\"') + '"]'); break }
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift('#' + n.id); break }
      var s = n.tagName.toLowerCase()
      var p = n.parentElement
      if (p) {
        var same = Array.prototype.filter.call(p.children, function (c) { return c.tagName === n.tagName })
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'
      }
      parts.unshift(s)
    }
    return parts.join(' > ')
  }
  function extract(el) {
    var r = el.getBoundingClientRect()
    var cs = getComputedStyle(el)
    var isSecret = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
    var out = {
      element: {
        tag: el.tagName,
        testID: el.getAttribute('data-testid'),
        text: isSecret ? '' : (el.innerText || '').trim().slice(0, 120),
        selector: cssPath(el),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        style: {
          color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
          padding: cs.padding, margin: cs.margin, border: cs.border, display: cs.display,
        },
      },
      components: [], stacks: [],
    }
    var f = fiberOf(el)
    for (var g = f, i = 0; g && i < 14; g = g.return, i++) {
      var n = typeof g.type !== 'string' ? nameOf(g.type) : null
      if (n && out.components.length < 14) out.components.push(n)
      if (i < 10 && g._debugStack && g._debugStack.stack) {
        out.stacks.push({ comp: n || String(g.tag), lines: String(g._debugStack.stack).split('\n').slice(1, 14) })
      }
    }
    return out
  }

  // ---------- Chọn phần tử ----------
  function elementAt(x, y) {
    var el = document.elementFromPoint(x, y)
    return el && el !== host && !host.contains(el) ? el : null
  }
  function drawBox(el) {
    if (!el) { box.style.display = tag.style.display = 'none'; return }
    var r = el.getBoundingClientRect()
    box.style.cssText = 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px'
    var f = fiberOf(el), label = el.tagName.toLowerCase()
    for (var g = f; g; g = g.return) { var n = typeof g.type !== 'string' && nameOf(g.type); if (n && n !== 'View' && n !== 'Text') { label = n + ' · ' + label; break } }
    tag.textContent = label + '  ' + Math.round(r.width) + '×' + Math.round(r.height)
    tag.style.cssText = 'display:block;left:' + Math.max(0, r.left) + 'px;top:' + Math.max(0, r.top - 20) + 'px'
  }
  function onMove(e) { if (!picking) return; current = elementAt(e.clientX, e.clientY); drawBox(current) }
  function inHost(e) { return e.composedPath && e.composedPath().indexOf(host) >= 0 }
  function swallow(e) {
    if (!picking || inHost(e)) return
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
  }
  function pickEl(el) {
    if (!el) return
    picked = extract(el) // chế độ chọn giữ nguyên: click tiếp sẽ thay phần tử đã chọn; tắt bằng Esc, nút hoặc Alt+Shift+K
    showSelected()
    ta.focus()
  }
  function onClick(e) {
    if (!picking || inHost(e)) return
    swallow(e)
    pickEl(elementAt(e.clientX, e.clientY) || current)
  }
  // Cảm ứng (kể cả giả lập mobile của Chrome): touchstart/touchend gắn ở document bị Chrome coi là passive nên KHÔNG được preventDefault ở touchstart
  // (báo "[Intervention] Unable to preventDefault inside passive event listener"). Cách làm: touchstart/touchmove chỉ cập nhật khung và chặn lan ra site
  // (cho phép cuộn trang), còn touchend (đăng ký passive:false) chốt một cú chạm: chặn click giả của trình duyệt và chọn phần tử tại điểm chạm.
  var touchStart = null
  function touchPoint(e) { return (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]) || null }
  function onTouchStart(e) {
    if (!picking || inHost(e)) return
    var t = touchPoint(e)
    touchStart = t ? { x: t.clientX, y: t.clientY } : null
    if (t) { current = elementAt(t.clientX, t.clientY); drawBox(current) }
    e.stopPropagation(); e.stopImmediatePropagation()
  }
  function onTouchMove(e) {
    if (!picking || inHost(e)) return
    var t = touchPoint(e)
    if (touchStart && t && Math.abs(t.clientX - touchStart.x) + Math.abs(t.clientY - touchStart.y) > 10) touchStart = null // kéo để cuộn, không phải chạm chọn
    e.stopPropagation(); e.stopImmediatePropagation()
  }
  function onTouchEnd(e) {
    if (!picking || inHost(e)) return
    e.stopPropagation(); e.stopImmediatePropagation()
    var t = touchPoint(e), tap = touchStart
    touchStart = null
    if (!tap || !t) return
    if (e.cancelable) e.preventDefault() // chặn click giả sau cú chạm để site không nhận
    pickEl(elementAt(t.clientX, t.clientY) || current)
  }
  function showSelected() {
    if (!picked) { selBox.classList.remove('show'); return }
    selLbl.textContent = (picked.components.slice(0, 3).join(' › ') || picked.element.tag.toLowerCase()) + '  ·  ' + picked.element.selector.slice(-50)
    selBox.classList.add('show')
  }
  function startPicking() {
    picking = true; pickBtn.classList.add('on'); pickBtn.textContent = 'Đang chọn… (Esc)'
    document.documentElement.style.cursor = 'crosshair'
  }
  function stopPicking() {
    picking = false; pickBtn.classList.remove('on'); pickBtn.textContent = 'Chọn phần tử'
    document.documentElement.style.cursor = ''
    drawBox(null)
  }
  function togglePick() {
    if (picking) return stopPicking()
    if (!open) setOpen(true)
    connect().then(startPicking).catch(function () { msg.textContent = 'Không kết nối được bridge.' })
  }

  // ---------- Gửi ----------
  function send() {
    var note = ta.value.trim()
    if (!note) { msg.textContent = 'Hãy gõ ghi chú trước.'; return }
    var body = { note: note, url: location.href, metroOrigin: location.origin, viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio } }
    if (picked) { body.element = picked.element; body.components = picked.components; body.stacks = picked.stacks }
    msg.textContent = 'Đang gửi…'
    connect().then(function () {
      return fetch(BRIDGE + '/api/feedback', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) }).then(function (x) {
      if (!x.ok) throw new Error(x.j.error || 'lỗi')
      ta.value = ''; picked = null; showSelected(); msg.textContent = ''
      return loadHistory().then(function () { render(true) }) // đồng bộ chắc chắn kể cả khi SSE chưa kịp tới; render(true) cuộn xuống cuối để thấy tin vừa gửi
    }).catch(function (e) { msg.textContent = 'Lỗi: ' + e.message })
  }
  chat.addEventListener('click', function (e) {
    var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a')
    if (a === 'send') send()
    else if (a === 'pick') togglePick()
    else if (a === 'unpick') { picked = null; showSelected() }
    else if (a === 'close') setOpen(false)
    else if (a === 'clear') clearHistory()
  })
  function clearHistory() {
    if (!entries.length) return
    if (!window.confirm('Xóa toàn bộ lịch sử hội thoại của site này?')) return
    connect().then(function () {
      return fetch(BRIDGE + '/api/history/clear?origin=' + encodeURIComponent(location.origin), { method: 'POST', headers: auth() })
    }).then(function (r) { if (!r.ok) throw new Error(r.status); entries = []; render() })
      .catch(function (e) { msg.textContent = 'Không xóa được: ' + e.message })
  }

  // Nút Feedback đi theo khung chat khi khung đã kéo/đổi cỡ: canh mép phải, nằm ngay dưới khung (hết chỗ thì nằm ngay trên).
  function syncFab() {
    if (!chat.style.left || chat.style.left === 'auto' || chat.style.display === 'none' || !chat.offsetWidth) return
    var r = chat.getBoundingClientRect(), fw = fab.offsetWidth, fh = fab.offsetHeight
    var x = Math.min(Math.max(0, r.right - fw), Math.max(0, window.innerWidth - fw))
    var y = r.bottom + 8 + fh <= window.innerHeight ? r.bottom + 8 : Math.max(0, r.top - 8 - fh)
    fab.style.left = x + 'px'; fab.style.top = y + 'px'; fab.style.right = 'auto'; fab.style.bottom = 'auto'
  }

  // ---------- Kéo di chuyển khung chat (nắm thanh tiêu đề) ----------
  var hd = $('.hd'), dragOff = null
  hd.style.cursor = 'move'
  hd.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return
    var r = chat.getBoundingClientRect()
    dragOff = { x: e.clientX - r.left, y: e.clientY - r.top }
    chat.style.left = r.left + 'px'; chat.style.top = r.top + 'px'
    chat.style.right = 'auto'; chat.style.bottom = 'auto'
    try { hd.setPointerCapture(e.pointerId) } catch (_) {}
    e.preventDefault()
  })
  hd.addEventListener('pointermove', function (e) {
    if (!dragOff) return
    var w = chat.offsetWidth, h = chat.offsetHeight
    var x = Math.min(Math.max(0, e.clientX - dragOff.x), Math.max(0, window.innerWidth - w))
    var y = Math.min(Math.max(0, e.clientY - dragOff.y), Math.max(0, window.innerHeight - h))
    chat.style.left = x + 'px'; chat.style.top = y + 'px'
    syncFab()
  })
  function endDrag(e) { if (dragOff) { dragOff = null; try { hd.releasePointerCapture(e.pointerId) } catch (_) {} } }
  hd.addEventListener('pointerup', endDrag)
  hd.addEventListener('pointercancel', endDrag)

  // ---------- Kéo góc trên-trái để đổi kích thước (cạnh phải/dưới đứng yên) ----------
  var rz = $('.rz'), rzFrom = null
  rz.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return
    var r = chat.getBoundingClientRect()
    rzFrom = { right: r.right, bottom: r.bottom }
    chat.style.left = r.left + 'px'; chat.style.top = r.top + 'px'
    chat.style.width = r.width + 'px'; chat.style.height = r.height + 'px'
    chat.style.right = 'auto'; chat.style.bottom = 'auto'; chat.style.maxWidth = 'none'
    try { rz.setPointerCapture(e.pointerId) } catch (_) {}
    e.preventDefault()
  })
  rz.addEventListener('pointermove', function (e) {
    if (!rzFrom) return
    var w = Math.min(Math.max(300, rzFrom.right - Math.max(0, e.clientX)), Math.min(window.innerWidth, 900))
    var h = Math.min(Math.max(240, rzFrom.bottom - Math.max(0, e.clientY)), window.innerHeight)
    chat.style.width = w + 'px'; chat.style.height = h + 'px'
    chat.style.left = Math.max(0, rzFrom.right - w) + 'px'; chat.style.top = Math.max(0, rzFrom.bottom - h) + 'px'
    syncFab()
  })
  function endRz(e) { if (rzFrom) { rzFrom = null; try { rz.releasePointerCapture(e.pointerId) } catch (_) {} } }
  rz.addEventListener('pointerup', endRz)
  rz.addEventListener('pointercancel', endRz)
  // Khung đã kéo/đổi cỡ có left/top cố định: kẹp lại khi cửa sổ thu nhỏ hoặc xoay màn hình để thanh tiêu đề luôn kéo được.
  function clampChat() {
    if (!chat.style.left || chat.style.left === 'auto') return
    var w = Math.min(chat.offsetWidth, window.innerWidth), h = Math.min(chat.offsetHeight, window.innerHeight)
    if (chat.style.width && chat.offsetWidth > window.innerWidth) chat.style.width = w + 'px'
    if (chat.style.height && chat.offsetHeight > window.innerHeight) chat.style.height = h + 'px'
    chat.style.left = Math.min(Math.max(0, parseFloat(chat.style.left) || 0), Math.max(0, window.innerWidth - w)) + 'px'
    chat.style.top = Math.min(Math.max(0, parseFloat(chat.style.top) || 0), Math.max(0, window.innerHeight - h)) + 'px'
    syncFab()
  }
  window.addEventListener('resize', clampChat)
  ;['keydown', 'keyup', 'keypress'].forEach(function (t) {
    ta.addEventListener(t, function (e) {
      e.stopPropagation()
      if (t === 'keydown' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
      else if (t === 'keydown' && e.key === 'Escape' && picking) stopPicking()
    })
  })

  // Tương tác với khung chat không được lọt ra trang: modal/popup của site coi click hoặc focus ngoài nó là "bấm ra ngoài" và tự đóng.
  ;['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'focusin', 'focusout', 'keydown', 'keyup', 'keypress'].forEach(function (t) {
    host.addEventListener(t, function (e) { e.stopPropagation() })
  })

  // Bẫy focus của modal (vd react-native-web: document.addEventListener('focus', trap, true)) giật focus khỏi khung chat về ô của modal,
  // nên gõ ghi chú lại chui vào ô của site. Chặn sự kiện focus của khung chat ngay ở window (pha capture chạy trước document).
  ;['focus', 'focusin', 'blur', 'focusout'].forEach(function (t) {
    window.addEventListener(t, function (e) {
      if (e.composedPath && e.composedPath().indexOf(host) >= 0) e.stopPropagation()
    }, true)
  })

  // ---------- Sự kiện toàn cục ----------
  document.addEventListener('mousemove', onMove, true)
  ;['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) { document.addEventListener(t, swallow, true) })
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true })
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false })
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', function (e) {
    if (e.altKey && e.shiftKey && (e.key === 'K' || e.key === 'k')) { e.preventDefault(); togglePick() }
    else if (e.key === 'Escape' && picking) stopPicking()
  }, true)
  fab.addEventListener('click', function (e) { e.stopPropagation(); setOpen(!open) })
})()
