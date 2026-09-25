/**
 * A minimal ZIP writer **and reader**.
 *
 * Why hand-rolled: the server has **no dependencies**, and "download these ten
 * images" has to produce one file rather than ten downloads the browser will
 * likely block. ZIP's stored (uncompressed) form is a handful of fixed headers
 * plus a CRC — small enough to own, and PNG data is already deflated, so
 * compressing it again would buy almost nothing.
 *
 * 读的那一半是给**自助更新**用的：更新包是别人打的 zip，可能是 deflate 也可能是 stored，
 * 还可能被人动过。所以读的时候按**中央目录**来（本地头里的长度在流式写法下会是 0），
 * 并且逐条核对 CRC 与解压后长度 —— 一个坏包必须当场被拒，不能解出一半再发现。
 */
import { crc32, inflateRawSync } from 'node:zlib'

/** One file to put in the archive. */
export interface ZipEntry {
  /** Path inside the archive. */
  name: string
  /** File bytes. */
  bytes: Buffer
}

/** Little-endian writer for the handful of fields ZIP needs. */
class Writer {
  private readonly parts: Buffer[] = []

  u16(value: number): this {
    const buffer = Buffer.alloc(2)
    buffer.writeUInt16LE(value & 0xffff, 0)
    this.parts.push(buffer)
    return this
  }

  u32(value: number): this {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(value >>> 0, 0)
    this.parts.push(buffer)
    return this
  }

  raw(bytes: Buffer): this {
    this.parts.push(bytes)
    return this
  }

  done(): Buffer {
    return Buffer.concat(this.parts)
  }
}

/** MS-DOS date/time, because that is what the ZIP header stores. */
function dosStamp(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

/** Non-ASCII names (Chinese, mostly) have to be flagged as UTF-8. */
const FLAG_UTF8 = 0x0800

/**
 * Build a ZIP archive.
 * @param entries - files to include, in order.
 * @param stamp - timestamp recorded for every entry.
 * @returns the archive bytes.
 */
export function makeZip(entries: ZipEntry[], stamp = new Date()): Buffer {
  const { time, date } = dosStamp(stamp)
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const sum = crc32(entry.bytes) >>> 0

    const header = new Writer()
      .u32(0x04034b50) // local file header
      .u16(20) // version needed
      .u16(FLAG_UTF8)
      .u16(0) // stored, no compression
      .u16(time)
      .u16(date)
      .u32(sum)
      .u32(entry.bytes.length)
      .u32(entry.bytes.length)
      .u16(name.length)
      .u16(0) // no extra field
      .raw(name)
      .done()
    local.push(header, entry.bytes)

    const record = new Writer()
      .u32(0x02014b50) // central directory header
      .u16(20) // version made by
      .u16(20) // version needed
      .u16(FLAG_UTF8)
      .u16(0)
      .u16(time)
      .u16(date)
      .u32(sum)
      .u32(entry.bytes.length)
      .u32(entry.bytes.length)
      .u16(name.length)
      .u16(0) // extra
      .u16(0) // comment
      .u16(0) // disk number
      .u16(0) // internal attributes
      .u32(0) // external attributes
      .u32(offset)
      .raw(name)
      .done()
    central.push(record)

    offset += header.length + entry.bytes.length
  }

  const directory = Buffer.concat(central)
  const end = new Writer()
    .u32(0x06054b50) // end of central directory
    .u16(0)
    .u16(0)
    .u16(entries.length)
    .u16(entries.length)
    .u32(directory.length)
    .u32(offset)
    .u16(0)
    .done()

  return Buffer.concat([...local, directory, end])
}

/** 解压出来的一个文件。 */
export interface ReadZipEntry {
  /** 包里的路径（还没做任何清理，调用方必须自己防目录穿越）。 */
  name: string
  /** 文件字节。 */
  bytes: Buffer
}

/** 一个条目最多解出多大（防一个坏包把内存吃光）。 */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024

/**
 * Read a ZIP archive.
 *
 * 按中央目录读，而不是顺着本地头走：流式写出来的包（`Compress-Archive` 就是）
 * 本地头里的 `csize`/`usize` 是 0，真正的长度只写在中央目录里。
 * @param bytes - the archive.
 * @returns the files, or undefined when the archive is malformed or corrupt.
 */
export function readZip(bytes: Buffer): ReadZipEntry[] | undefined {
  // End of central directory：从尾部往前找（注释最长 65535 字节）。
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (bytes.readUInt32LE(at) === 0x06054b50) { eocd = at; break }
  }
  if (eocd === -1) return undefined
  const count = bytes.readUInt16LE(eocd + 10)
  let cursor = bytes.readUInt32LE(eocd + 16)
  if (cursor + 46 * count > bytes.length) return undefined

  const entries: ReadZipEntry[] = []
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) return undefined
    const method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20)
    const size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const external = bytes.readUInt32LE(cursor + 38)
    const localAt = bytes.readUInt32LE(cursor + 42)
    // 路径分隔符统一成 `/`：**Windows 的 Compress-Archive 写的是反斜杠**
    // （条目名形如 `apps\server\src\index.ts`），不归一化的话
    // 「目录条目」会被当成文件、`..` 检查也会漏 —— 而这个函数的下游是解包。
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replace(/\\/gu, '/')
    cursor += 46 + nameLength + extraLength + commentLength

    // 目录条目跳过：名字以 `/` 结尾，或者带着 MS-DOS 的目录属性位
    // （.NET 打包器两种都有可能出现）。
    if (name.endsWith('/') || (external & 0x10) !== 0) continue
    if (size > MAX_ENTRY_BYTES) return undefined
    if (localAt + 30 > bytes.length || bytes.readUInt32LE(localAt) !== 0x04034b50) return undefined
    const localName = bytes.readUInt16LE(localAt + 26)
    const localExtra = bytes.readUInt16LE(localAt + 28)
    const start = localAt + 30 + localName + localExtra
    if (start + compressed > bytes.length) return undefined
    const raw = bytes.subarray(start, start + compressed)

    let body: Buffer
    if (method === 0) body = raw
    else if (method === 8) {
      try {
        body = inflateRawSync(raw)
      } catch {
        return undefined
      }
    } else return undefined // 别的压缩方法（bzip2/zstd…）不支持，宁可整包拒绝。

    // 坏包必须当场拒绝：更新包解出一半比根本不更新更糟。
    if (body.length !== size || (crc32(body) >>> 0) !== crc) return undefined
    entries.push({ name, bytes: body })
  }
  return entries
}
