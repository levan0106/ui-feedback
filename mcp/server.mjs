#!/usr/bin/env node
// MCP stdio (JSON-RPC, mỗi dòng một message). Hai tool: tl_ui_feedback_poll, tl_ui_feedback_reply.
import readline from 'node:readline'
import { poll, reply, formatItem, nextStep, permissionNotice } from '../bridge/client.mjs'

const TOOLS = [
  {
    name: 'tl_ui_feedback_poll',
    description:
      'Chờ phản hồi UI mà người dùng vừa chỉ trên trình duyệt (UI Feedback Bridge). Trả về ghi chú, phần tử, selector, style và file:dòng nguồn để sửa. Sau khi sửa, gọi tl_ui_feedback_reply rồi gọi lại tool này để chờ tiếp.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'number', description: 'Thời gian chờ tối đa (mặc định 300, tối đa 3600)' },
        origin: { type: 'string', description: 'Chỉ nhận phản hồi từ origin này, vd http://localhost:8081. Bắt buộc khi có site chạy qua serve.' },
        any: { type: 'boolean', description: 'Cố ý nhận tin của mọi site (không khuyến khích)' },
      },
    },
  },
  {
    name: 'tl_ui_feedback_reply',
    description: 'Báo lại cho người dùng (hiện trên trang) bạn đã sửa gì. Truyền id của phản hồi nếu có. Tin tiến độ không có id thì truyền origin của site để chỉ hiện ở đúng site đó.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        id: { type: 'string' },
        origin: { type: 'string', description: 'Origin của site, vd http://localhost:55153 (dùng khi không có id)' },
      },
      required: ['text'],
    },
  },
]

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const ok = (id, result) => send({ jsonrpc: '2.0', id, result })
const err = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function callTool(name, args = {}) {
  if (name === 'tl_ui_feedback_poll') {
    const secs = Math.min(Math.max(+args.timeout_seconds || 300, 1), 3600)
    const r = await poll({ origin: args.origin, timeoutMs: secs * 1000, allowAny: !!args.any })
    const body = r.items.map(formatItem).join('\n\n')
    const pn = permissionNotice(r.permission)
    return `status: ${r.status}  count: ${r.count}\n\n${body}\n\n${pn ? pn + '\n\n' : ''}next_step: ${nextStep(r.count).replaceAll('tl-ui-feedback reply', 'tl_ui_feedback_reply').replaceAll('tl-ui-feedback poll', 'tl_ui_feedback_poll')}`
  }
  if (name === 'tl_ui_feedback_reply') {
    await reply(String(args.text || ''), args.id, args.origin)
    return 'đã gửi trả lời lên trang'
  }
  throw Object.assign(new Error('unknown tool ' + name), { code: -32602 })
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let m
  try { m = JSON.parse(line) } catch { return err(null, -32700, 'parse error') }
  const { id, method, params } = m
  try {
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'ui-feedback-bridge', version: '0.1.0' },
      })
    }
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return
    if (method === 'ping') return ok(id, {})
    if (method === 'tools/list') return ok(id, { tools: TOOLS })
    if (method === 'tools/call') {
      try {
        const text = await callTool(params.name, params.arguments)
        return ok(id, { content: [{ type: 'text', text }] })
      } catch (e) {
        if (e.code === -32602) return err(id, -32602, e.message)
        return ok(id, { content: [{ type: 'text', text: 'lỗi: ' + e.message }], isError: true })
      }
    }
    if (id !== undefined) err(id, -32601, 'method not found: ' + method)
  } catch (e) {
    if (id !== undefined) err(id, -32603, e.message)
  }
})
