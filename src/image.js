/**
 * dsh-search-picture —— 图片字节的媒体类型嗅探与尺寸解析。
 *
 * 只用字节签名判断格式（不信任 Content-Type：图床经常回 text/plain 或
 * application/octet-stream），并解析出像素尺寸，供清晰度排序与
 * `attachments.saveImage` 的准入校验使用。
 *
 * 支持 DSH 附件服务接受的四种格式：image/png、image/jpeg、image/webp、image/gif。
 */

/** PNG 签名。 */
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes, sig, offset = 0) {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

function ascii(bytes, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function u16be(bytes, offset) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u32be(bytes, offset) {
  return ((bytes[offset] ?? 0) * 0x1000000) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
}

function u32le(bytes, offset) {
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16) + ((bytes[offset + 3] ?? 0) * 0x1000000);
}

function u24le(bytes, offset) {
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16);
}

/**
 * PNG：IHDR 的宽高为大端 u32，位于签名 + 4(len) + 4(type) 之后。
 * @returns {{width:number,height:number}|undefined}
 */
function pngSize(bytes) {
  if (bytes.length < 24) return undefined;
  if (ascii(bytes, 12, 4) !== 'IHDR') return undefined;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * JPEG：逐段扫描 SOFn 帧头取宽高（高在宽之前，u16be）。
 * 段长包含自身两字节，遇到 SOS/EOI 即停止。
 * @returns {{width:number,height:number}|undefined}
 */
function jpegSize(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无载荷的标记：TEM、RSTn、SOI、EOI。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return undefined;
    // SOF0..SOF15，排除 DHT(0xc4)、JPG(0xc8)、DAC(0xcc)。
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return undefined;
      const height = u16be(bytes, offset + 5);
      const width = u16be(bytes, offset + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (marker === 0xda) return undefined; // 进入熵编码数据，不再有帧头。
    offset += 2 + length;
  }
  return undefined;
}

/**
 * GIF：逻辑屏幕描述符的宽高为小端 u16。
 * @returns {{width:number,height:number}|undefined}
 */
function gifSize(bytes) {
  if (bytes.length < 10) return undefined;
  const width = (bytes[6] ?? 0) + ((bytes[7] ?? 0) << 8);
  const height = (bytes[8] ?? 0) + ((bytes[9] ?? 0) << 8);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * WebP：VP8 / VP8L / VP8X 三种块各有自己的宽度布局。
 * @returns {{width:number,height:number}|undefined}
 */
function webpSize(bytes) {
  if (bytes.length < 30) return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8 ') {
    // 简单有损：帧头 0x9d012a 之后是 14 位宽高（小端，各取低 14 位）。
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return undefined;
    const width = ((bytes[26] ?? 0) + ((bytes[27] ?? 0) << 8)) & 0x3fff;
    const height = ((bytes[28] ?? 0) + ((bytes[29] ?? 0) << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === 'VP8L') {
    // 无损：1 字节签名 0x2f 之后，14 位宽-1 与 14 位高-1 位打包。
    if ((bytes[20] ?? 0) !== 0x2f) return undefined;
    const bits = u32le(bytes, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === 'VP8X') {
    // 扩展：24 位宽-1、24 位高-1。
    const width = u24le(bytes, 24) + 1;
    const height = u24le(bytes, 27) + 1;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  return undefined;
}

/**
 * 按字节签名识别图片格式。
 * @param bytes 下载到的原始字节。
 * @returns `image/png` / `image/jpeg` / `image/webp` / `image/gif`，或 undefined（不支持的格式）。
 */
export function sniffImageMediaType(bytes) {
  if (bytes.length < 12) return undefined;
  if (startsWith(bytes, PNG_SIG)) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

/**
 * 解析图片像素尺寸。
 * @param bytes 原始字节。
 * @param mediaType {@link sniffImageMediaType} 的结果。
 * @returns 尺寸，或 undefined（解析失败，调用方应退化为无序）。
 */
export function imageSize(bytes, mediaType) {
  switch (mediaType) {
    case 'image/png':
      return pngSize(bytes);
    case 'image/jpeg':
      return jpegSize(bytes);
    case 'image/gif':
      return gifSize(bytes);
    case 'image/webp':
      return webpSize(bytes);
    default:
      return undefined;
  }
}

/** 媒体类型对应的文件扩展名（落盘命名用）。 */
export function extensionFor(mediaType) {
  switch (mediaType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.img';
  }
}
