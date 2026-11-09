import test from 'node:test'
import assert from 'node:assert/strict'
import { injectOverlay, overlayTag, OVERLAY_PATH } from '../bridge/inject.mjs'

const B = 'http://127.0.0.1:47831'

test('chèn trước </body>', () => {
  const out = injectOverlay('<html><body><p>x</p></body></html>', B)
  assert.match(out, /<p>x<\/p><script>window\.__UIFB__=.*<\/script><script src="\/__uifb\/overlay\.js"><\/script><\/body><\/html>$/)
})

test('không có </body> thì nối vào cuối', () => {
  const out = injectOverlay('<p>x</p>', B)
  assert.ok(out.startsWith('<p>x</p>\n<script>'))
  assert.ok(out.endsWith(`src="${OVERLAY_PATH}"></script>`))
})

test('</BODY > hoa thường và khoảng trắng', () => {
  const out = injectOverlay('<BODY>a</BODY >', B)
  assert.ok(out.indexOf(OVERLAY_PATH) < out.indexOf('</BODY >'))
})

test('chỉ chèn ở </body> cuối, không vào chuỗi trong script', () => {
  const html = '<body><script>var s="</body>"</script>x</body>'
  const out = injectOverlay(html, B)
  assert.equal(out.indexOf('var s="</body>"'), html.indexOf('var s="</body>"'))
  assert.ok(out.indexOf(OVERLAY_PATH) > out.indexOf('x'))
})

test('không chèn hai lần', () => {
  const once = injectOverlay('<body></body>', B)
  assert.equal(injectOverlay(once, B), once)
})

test('cấu hình không thể thoát khỏi thẻ script', () => {
  const tag = overlayTag('http://127.0.0.1:1/</script><img src=x>')
  assert.equal(tag.match(/<\/script>/g).length, 2)
  assert.ok(!tag.includes('</script><img'))
})
