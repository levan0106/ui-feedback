import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkManifest, buildZip, crc32 } from '../scripts/pack-extension.mjs'

const ext = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension')

test('manifest đạt yêu cầu store (icon, version, không permissions thừa)', () => {
  const { errs } = checkManifest()
  assert.deepEqual(errs, [])
})

test('zip chứa manifest + overlay + icons, giải nén khớp nguồn, build lặp lại cùng byte', () => {
  const { zip, count } = buildZip()
  assert.equal(count, 6)
  assert.ok(zip.equals(buildZip().zip), 'build phải tái lập được')
  // đọc central directory
  const eocd = zip.length - 22
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50)
  let p = zip.readUInt32LE(eocd + 16)
  const names = []
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
    const crc = zip.readUInt32LE(p + 16), csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24)
    const nl = zip.readUInt16LE(p + 28), off = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nl).toString()
    const data = inflateRawSync(zip.subarray(off + 30 + zip.readUInt16LE(off + 26), off + 30 + zip.readUInt16LE(off + 26) + csize))
    assert.equal(data.length, usize)
    assert.equal(crc32(data), crc)
    assert.ok(data.equals(readFileSync(join(ext, name))), name)
    names.push(name)
    p += 46 + nl
  }
  assert.deepEqual(names.sort(), ['icons/icon128.png', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'manifest.json', 'overlay.js'])
})
