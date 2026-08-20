/**
 * Builds JPEG fixtures carrying a real EXIF APP1 segment (GPS position and
 * DateTimeOriginal) padded to the size of a typical phone photo, so that the
 * photo pipeline can be timed against files that behave like the real input.
 *
 * Only the three tags the pipeline actually reads are written; the payload
 * after the APP1 segment is incompressible filler, which is what makes the
 * chunked-read behaviour observable.
 */
import { mkdirSync, writeFileSync } from "node:fs";

function u16(v: number) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }

/** One 12-byte TIFF IFD entry. */
function entry(tag: number, type: number, count: number, value: Buffer) {
  return Buffer.concat([u16(tag), u16(type), u32(count), value]);
}

/** Degrees as the three EXIF RATIONALs (deg, min, sec). */
function dms(value: number) {
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = (abs - d - m / 60) * 3600;
  return Buffer.concat([
    u32(d), u32(1),
    u32(m), u32(1),
    u32(Math.round(s * 10000)), u32(10000),
  ]);
}

export function exifJpeg(lat: number, lng: number, when: Date, bytes: number): Buffer {
  const stamp =
    `${when.getFullYear()}:${String(when.getMonth() + 1).padStart(2, "0")}:` +
    `${String(when.getDate()).padStart(2, "0")} ` +
    `${String(when.getHours()).padStart(2, "0")}:` +
    `${String(when.getMinutes()).padStart(2, "0")}:` +
    `${String(when.getSeconds()).padStart(2, "0")}\0`;

  // TIFF header, then IFD0 -> {Exif IFD, GPS IFD}. All offsets are measured
  // from the first byte of the TIFF header.
  const tiffHeader = Buffer.concat([Buffer.from("II"), u16(42), u32(8)]);

  const ifd0Offset = 8;
  const ifd0Size = 2 + 2 * 12 + 4;
  const exifIfdOffset = ifd0Offset + ifd0Size;
  const exifIfdSize = 2 + 1 * 12 + 4;
  const gpsIfdOffset = exifIfdOffset + exifIfdSize;
  const gpsIfdSize = 2 + 4 * 12 + 4;
  const dataOffset = gpsIfdOffset + gpsIfdSize;

  const stampOffset = dataOffset;
  const latOffset = stampOffset + stamp.length;
  const lngOffset = latOffset + 24;

  const ifd0 = Buffer.concat([
    u16(2),
    entry(0x8769, 4, 1, u32(exifIfdOffset)),   // ExifIFDPointer
    entry(0x8825, 4, 1, u32(gpsIfdOffset)),    // GPSInfoIFDPointer
    u32(0),
  ]);

  const exifIfd = Buffer.concat([
    u16(1),
    entry(0x9003, 2, stamp.length, u32(stampOffset)), // DateTimeOriginal
    u32(0),
  ]);

  const latRef = Buffer.from(lat >= 0 ? "N\0\0\0" : "S\0\0\0");
  const lngRef = Buffer.from(lng >= 0 ? "E\0\0\0" : "W\0\0\0");
  const gpsIfd = Buffer.concat([
    u16(4),
    entry(0x0001, 2, 2, latRef),               // GPSLatitudeRef
    entry(0x0002, 5, 3, u32(latOffset)),       // GPSLatitude
    entry(0x0003, 2, 2, lngRef),               // GPSLongitudeRef
    entry(0x0004, 5, 3, u32(lngOffset)),       // GPSLongitude
    u32(0),
  ]);

  const tiff = Buffer.concat([
    tiffHeader, ifd0, exifIfd, gpsIfd,
    Buffer.from(stamp, "latin1"), dms(lat), dms(lng),
  ]);

  const app1Body = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.from([(app1Body.length + 2) >> 8, (app1Body.length + 2) & 0xff]),
    app1Body,
  ]);

  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), app1]);
  const tail = Buffer.from([0xff, 0xd9]);
  const fillerLength = Math.max(0, bytes - head.length - tail.length);
  const filler = Buffer.alloc(fillerLength);
  for (let i = 0; i < fillerLength; i += 4) filler.writeUInt32LE((i * 2654435761) >>> 0, i);
  return Buffer.concat([head, filler, tail]);
}

if (process.argv[1]?.endsWith("make-exif-fixtures.mts")) {
  const dir = ".eval-fixtures";
  const count = Number(process.argv[2] ?? 100);
  const megabytes = Number(process.argv[3] ?? 4);
  mkdirSync(dir, { recursive: true });
  const base = new Date(2026, 6, 14, 9, 0, 0);
  for (let i = 0; i < count; i++) {
    const when = new Date(base.getTime() + i * 137_000);
    const lat = 52.5163 + (i % 20) * 0.0009;
    const lng = 13.3777 + (i % 17) * 0.0012;
    writeFileSync(
      `${dir}/photo-${String(i).padStart(3, "0")}.jpg`,
      exifJpeg(lat, lng, when, megabytes * 1024 * 1024)
    );
  }
  console.log(`wrote ${count} fixtures of ~${megabytes} MB each to ${dir}/`);
}
