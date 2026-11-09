// Chèn overlay vào HTML do `tl-ui-feedback serve` phục vụ (Node thuần, không dependency).
export const OVERLAY_PATH = '/__uifb/overlay.js'

// Dùng JSON.stringify và thay "<" để chuỗi cấu hình không thể đóng thẻ script.
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c')

export function overlayTag(bridgeUrl) {
  return `<script>window.__UIFB__=${safeJson({ bridge: bridgeUrl })}</script><script src="${OVERLAY_PATH}"></script>`
}

export function alreadyInjected(html) {
  return html.includes(OVERLAY_PATH)
}

// Chèn trước </body> cuối cùng (không đụng tới "</body>" nằm trong chuỗi script ở giữa trang);
// không có thì nối vào cuối. Trả nguyên văn nếu đã chèn.
export function injectOverlay(html, bridgeUrl) {
  if (alreadyInjected(html)) return html
  const tag = overlayTag(bridgeUrl)
  let at = -1
  const re = /<\/body\s*>/gi
  for (let m; (m = re.exec(html)); ) at = m.index
  return at < 0 ? html + '\n' + tag : html.slice(0, at) + tag + html.slice(at)
}
