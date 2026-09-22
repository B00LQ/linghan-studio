/**
 * A minimal ZIP writer.
 *
 * Why hand-rolled: the server has **no dependencies**, and "download these ten
 * images" has to produce one file rather than ten downloads the browser will
 * likely block. ZIP's stored (uncompressed) form is a handful of fixed headers
 * plus a CRC — small enough to own, and PNG data is already deflated, so
 * compressing it again would buy almost nothing.
 */
import { crc32 } from 'node:zlib'

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
