/**
 * dsh-search-picture —— 候选下载：抓字节、验格式、量尺寸、按清晰度筛选、落盘。
 *
 * 刻意不复用 `ctx.web.fetch`：该 seam 的 body 是 `html | text` 闭合联合，
 * 图片的 Content-Type 会被 provider 直接以 `WEB_UNSUPPORTED_CONTENT_TYPE` 拒绝，
 * 因此图片字节必须由插件自己取。这里的下载遵循两条约束：
 *   1. 每个响应体有字节上限，超限截断（不把一张巨图整个读进内存）；
 *   2. 格式以字节签名为准（图床常把 JPEG 标成 text/plain）。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extensionFor, imageSize, sniffImageMediaType } from './image.js';
import { httpGetCapped, mapLimit, normalizeUrl } from './util.js';

/** 单个响应的默认字节上限（12 MiB）。 */
export const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

/** 诊断用：设置环境变量 DSH_SEARCH_PICTURE_TRACE=1 时输出每次下载尝试的明细。 */
const traceEnabled = process.env.DSH_SEARCH_PICTURE_TRACE === '1';

/**
 * 用户点名的优先站点（知乎、哔哩哔哩）。
 * 按**站点**判定而不是按引擎：百度和必应都会索引知乎与 B 站的图，
 * 用户在意的是「图最终来自哪个站」，不是「我从哪个搜索引擎发现它」。
 */
const PREFERRED_HOSTS = ['zhimg.com', 'hdslb.com', 'bilibili.com'];

/**
 * 已知会给图片**自动叠加水印**的图库站（用户明确要求不要这类图）。
 *
 * 判据说明：本插件没有视觉模型，**无法通用地「看出」一张图有没有水印**。
 * 但这类站点的水印是**产品行为**——它们给所有预览图统一加水印/运营标识，
 * 所以按**域名**排除是确定可行的判据，比猜测像素靠谱得多。
 *
 * 想补充就改这个列表（或通过配置 `watermarkHosts` 追加）。
 */
const WATERMARK_HOSTS = [
  // 国内图库/素材站：预览图统一带水印
  '58pic.com', '699pic.com', 'ibaotu.com', '51miz.com', 'tukuppt.com',
  'zhituwang.com', 'veer.com', 'huitu.com', 'tupian114.com', '616pic.com',
  'qiantucdn.com', 'csdnimg.cn', 'zhimg.com.cn',
  // 国外图库：带 stock 水印
  'gettyimages.com', 'shutterstock.com', 'dreamstime.com', '123rf.com',
  'depositphotos.com', 'istockphoto.com', 'adobe.com', 'alamy.com',
  'bigstockphoto.com', 'vectorstock.com', 'stock.adobe.com',
];

/** 文件名/地址里**显式带水印标记**的，直接排除。 */
const WATERMARK_NAME_PATTERN = /(watermark|water_mark|shuiyin|水印|带水印|_wm\d*\.|_mark\.)/i;

/**
 * 判断一个图片地址是否应当因**水印风险**被排除。
 *
 * 两条判据都是确定性的（不依赖视觉识别）：
 *   1. **域名**属于已知自动加水印的图库站；
 *   2. **地址或文件名**里显式带 `watermark` / `水印` 等标记。
 *
 * @param url 图片地址。
 * @param extraHosts 额外要排除的域名（来自配置）。
 * @returns `{ blocked, reason }`。
 */
export function isWatermarkRisk(url, extraHosts = []) {
  const text = String(url ?? '');
  if (WATERMARK_NAME_PATTERN.test(text)) {
    return { blocked: true, reason: '文件名/地址带水印标记' };
  }
  let host;
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    return { blocked: false };
  }
  const hosts = [...WATERMARK_HOSTS, ...extraHosts.map((h) => String(h).toLowerCase().trim()).filter(Boolean)];
  for (const domain of hosts) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return { blocked: true, reason: `图库站自动加水印（${domain}）` };
    }
  }
  return { blocked: false };
}

/**
 * 候选排序。规则（每一条都是踩过坑之后定下来的）：
 *   1. 受限代理图、标题图降档——它们本身就是缩略图/标题图；
 *   2. 其余按**像素面积**降序（真正的质量信号，只对已解码、尺寸已知的图有意义）；
 *   3. 面积相同时，**用户点名的优先站点**（知乎 / B 站）在前；
 *   4. 再相同则官网素材优先。
 *
 * ⚠️ 教训：曾经让「官网素材」升到最高档，结果 6 张候选全是官网横幅
 * （1600x900、带大字），把 4000x3000 的同人插画全挤掉——**用来源代替质量判断是错的**。
 * 所以这里的站点偏好只在**质量相当**时起作用，绝不越级。
 *
 * @param candidates 候选列表。
 * @returns 新数组。
 */
export function rankCandidates(candidates) {
  const penaltyOf = (candidate) => (candidate.tier === 'cover' ? 2 : 0) + (candidate.proxied === true ? 1 : 0);
  const hostOf = (candidate) => {
    try {
      return new URL(candidate.imageUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  };
  const preferredOf = (candidate) => {
    const host = hostOf(candidate);
    return PREFERRED_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`)) ? 0 : 1;
  };
  return [...candidates].sort((a, b) => {
    const penaltyA = penaltyOf(a);
    const penaltyB = penaltyOf(b);
    if (penaltyA !== penaltyB) return penaltyA - penaltyB;
    const areaA = (a.width ?? 0) * (a.height ?? 0);
    const areaB = (b.width ?? 0) * (b.height ?? 0);
    if (areaA !== areaB) return areaB - areaA;
    const preferredA = preferredOf(a);
    const preferredB = preferredOf(b);
    if (preferredA !== preferredB) return preferredA - preferredB;
    const officialA = a.tier === 'official' ? 0 : 1;
    const officialB = b.tier === 'official' ? 0 : 1;
    return officialA - officialB;
  });
}

/**
 * 无防盗链、可安全直接贴进回复的图床。
 *
 * **知乎（`zhimg.com`）是实测确认的一个**，而且用户明确要求优先用知乎的来源。
 * 实测（`.work/probe-zhihu2.mjs`）：知乎的页面与 API 全部封死——
 *   · 搜索页 / 问题页：**HTTP 403**（换移动 UA、伪造 cookie、Baiduspider/Googlebot UA 全都是 403）；
 *   · `api/v4/search_v3`：**HTTP 400**（各种参数组合都是 400）；
 *   · 热榜 / 推荐 / 收藏夹：**HTTP 401「身份未经过验证」**；
 *   · 文章 API 403(err 10003)、答案 API 403(err 40353)。
 * 但 **`pic*.zhimg.com` 图床本身完全没有防盗链：无 referer 与带 referer 都返回 200**。
 *
 * 所以「优先知乎」的正确做法不是去爬知乎站内，而是**走搜索引擎（百度对知乎收录最好）
 * 命中 zhimg.com 的图，再直接从图床取原图**——并且因为无防盗链，这些直链可以
 * **直接嵌进回复正文显示给用户**（这是本插件唯一被验证能显示图片的形式）。
 */
const HOTLINK_FRIENDLY_HOSTS = ['zhimg.com', 'hdslb.com', 'safebooru.org'];

/**
 * 判断一个图片地址是否来自「可安全直贴」的图床。
 * @param url 图片地址。
 * @returns 是否可直贴。
 */
export function isHotlinkFriendly(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HOTLINK_FRIENDLY_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/** Windows 下非法的文件名字符集合。 */
const ILLEGAL_FILENAME = /[\\/:*?"<>|]/g;

/**
 * 组装落盘文件名：`<查询词>-<序号>.<扩展名>`。
 * @param query 已清洗的查询词。
 * @param index 1 起的序号。
 * @param mediaType 媒体类型。
 * @returns 文件名。
 */
export function buildFileName(query, index, mediaType) {
  const safe = query.replace(ILLEGAL_FILENAME, ' ').replace(/\s+/g, ' ').trim();
  const stem = safe === '' ? 'picture' : safe;
  return `${stem}-${String(index).padStart(2, '0')}${extensionFor(mediaType)}`;
}

/**
 * 下载一个候选图片。
 *
 * 尝试顺序很关键：**先不带 Referer**。实测多数图床（bilibili / 百科 / 堆糖）
 * 只在「带第三方 Referer」时才触发防盗链，裸请求反而给原图；带上来源页 Referer
 * 的重试留给少数确实需要的站点。原图失败后再退化到搜索结果里的缩略图地址。
 *
 * @param candidate 候选（含 imageUrl / thumbnailUrl / pageUrl）。
 * @param options `{ signal, timeoutMs, maxBytes }`。
 * @returns `{ bytes, mediaType, width, height, sourceUrl, truncated }`，或抛出错误。
 */
async function fetchImage(candidate, options) {
  const primary = normalizeUrl(candidate.imageUrl);
  const fallback = normalizeUrl(candidate.thumbnailUrl);
  const referer = candidate.pageUrl;
  const attempts = [];
  if (primary !== undefined) {
    attempts.push({ url: primary, referer: undefined });
    if (referer !== undefined) attempts.push({ url: primary, referer });
  }
  if (fallback !== undefined && fallback !== primary) {
    attempts.push({ url: fallback, referer: undefined });
    if (referer !== undefined) attempts.push({ url: fallback, referer });
  }

  let lastError;
  for (const attempt of attempts) {
    let response;
    let startedAt = 0;
    if (traceEnabled) {
      startedAt = Date.now();
      console.error(`[trace]   GET ${attempt.url.slice(0, 90)} referer=${attempt.referer ?? '-'}`);
    }
    try {
      response = await httpGetCapped(attempt.url, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        referer: attempt.referer,
        maxBytes: options.maxBytes,
      });
      if (traceEnabled) console.error(`[trace]   -> ${String(response.status)} ${String(response.bytes.length)}B ${String(Date.now() - startedAt)}ms`);
    } catch (error) {
      if (traceEnabled) console.error(`[trace]   -> ERR ${error instanceof Error ? error.message : String(error)} ${String(Date.now() - startedAt)}ms`);
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      lastError = `HTTP ${String(response.status)}`;
      continue;
    }
    if (response.bytes.length === 0) {
      lastError = response.tooLarge === true ? 'response exceeds the byte cap' : 'empty body';
      continue;
    }
    const mediaType = sniffImageMediaType(response.bytes);
    if (mediaType === undefined) {
      lastError = `unsupported image format (content-type ${response.contentType || 'unknown'})`;
      continue;
    }
    const size = imageSize(response.bytes, mediaType);
    return {
      bytes: response.bytes,
      mediaType,
      width: size?.width,
      height: size?.height,
      sourceUrl: attempt.url,
      truncated: response.truncated,
    };
  }
  throw new Error(lastError ?? 'download failed');
}

/**
 * 下载并落盘最多 `count` 张图片。
 *
 * 按清晰度排序后并发尝试，命中配额即停止；被清晰度阈值淘汰或下载失败的候选
 * 会记录在 `failures` 里，但不影响已成功的图片。
 *
 * @param candidates 候选列表（来自各引擎，已合并去重）。
 * @param options `{ directory, query, count, signal, minPixels, minLongEdge, minBytes, maxBytes, concurrency, timeoutMs }`。
 * @returns `{ files, failures }`；`files[].path` 是绝对路径。
 */
export async function downloadCandidates(candidates, options) {
  const {
    directory,
    query,
    count,
    signal,
    minPixels = 720000,
    minLongEdge = 1000,
    maxAspectRatio = 2.6,
    minBytes = 4096,
    maxBytes = DEFAULT_MAX_BYTES,
    concurrency = 6,
    timeoutMs = 30000,
    watermarkHosts = [],
  } = options;

  // 水印预筛：在排序之前把「已知水印站 / 带水印标记」的候选剔除，
  // 这样它们既不占用下载配额，也不会在 failures 里淹没真正的失败原因。
  const watermarkBlocked = [];
  const clean = [];
  for (const candidate of candidates) {
    const verdict = isWatermarkRisk(candidate.imageUrl, watermarkHosts);
    if (verdict.blocked) {
      watermarkBlocked.push({ url: candidate.imageUrl, engine: candidate.engine, reason: `watermark: ${verdict.reason}` });
    } else {
      clean.push(candidate);
    }
  }

  const ranked = rankCandidates(clean);
  const failures = [...watermarkBlocked];
  const files = [];
  /** 本批次已决定的文件名，避免并发下重名覆盖。 */
  const usedNames = new Set();
  /** 下一个落盘序号；只在写盘前的同步区段自增，无竞态。 */
  let sequence = 0;
  /** 已认领但尚未落盘的配额；进入写盘前的同步区段自增，因此并发下也不会超额。 */
  let inFlight = 0;
  // 候选池放宽：图床失效、尺寸不足的比例很高，池子太窄会白白浪费配额。
  // 下载仍有并发上限与单响应字节上限，放宽的只是「最多试几个」。
  const pool = ranked.slice(0, Math.max(count * 6, count + 30));

  await mapLimit(pool, concurrency, async (candidate) => {
    // 落盘成功的数量 + 正在处理的 worker 达到配额时不再认领新候选。
    // 校验失败的候选会在 finally 里归还配额，因此坏图不会挤掉后面的好图。
    if (files.length + inFlight >= count) return undefined;
    inFlight += 1;
    if (traceEnabled) {
      console.error(`[trace] claim files=${String(files.length)} inFlight=${String(inFlight)} ${candidate.engine} ${String(candidate.width)}x${String(candidate.height)} ${candidate.imageUrl.slice(0, 80)}`);
    }

    try {
      let image;
      try {
        image = await fetchImage(candidate, { signal, timeoutMs, maxBytes });
      } catch (error) {
        failures.push({
          url: candidate.imageUrl,
          engine: candidate.engine,
          reason: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }

      const pixels = (image.width ?? 0) * (image.height ?? 0);
      const longEdge = Math.max(image.width ?? 0, image.height ?? 0);
      const shortEdge = Math.min(image.width ?? 0, image.height ?? 0);
      // 三重判据，各挡一类废图：
      //   1. 像素面积 —— 小缩略图；
      //   2. 长边 —— 面积够但实际很窄的切片；
      //   3. 长宽比 —— 专栏/网页里的装饰横幅与拼图条（实测 B 站图文里很常见，
      //      例如 1921x563 就是把几张图并排的裁剪条，对「找一张图」毫无价值）。
      if (image.width !== undefined && image.height !== undefined && pixels < minPixels) {
        failures.push({
          url: image.sourceUrl,
          engine: candidate.engine,
          reason: `too small (${String(image.width)}x${String(image.height)} = ${String(pixels)} < ${String(minPixels)} px²)`,
          width: image.width,
          height: image.height,
        });
        return undefined;
      }
      if (image.width !== undefined && image.height !== undefined && minLongEdge > 0 && longEdge < minLongEdge) {
        failures.push({
          url: image.sourceUrl,
          engine: candidate.engine,
          reason: `long edge too short (${String(longEdge)} < ${String(minLongEdge)} px)`,
          width: image.width,
          height: image.height,
        });
        return undefined;
      }
      if (shortEdge > 0 && maxAspectRatio > 0 && longEdge / shortEdge > maxAspectRatio) {
        failures.push({
          url: image.sourceUrl,
          engine: candidate.engine,
          reason: `aspect ratio too extreme (${String(image.width)}x${String(image.height)} = ${(longEdge / shortEdge).toFixed(1)} > ${String(maxAspectRatio)})`,
          width: image.width,
          height: image.height,
        });
        return undefined;
      }
      if (image.bytes.length < minBytes) {
        failures.push({
          url: image.sourceUrl,
          engine: candidate.engine,
          reason: `too few bytes (${String(image.bytes.length)} < ${String(minBytes)})`,
        });
        return undefined;
      }

      // 文件名在这里同步决定（其后没有 await），保证并发下不重名。
      sequence += 1;
      let fileName = buildFileName(query, sequence, image.mediaType);
      while (usedNames.has(fileName)) {
        sequence += 1;
        fileName = buildFileName(query, sequence, image.mediaType);
      }
      usedNames.add(fileName);
      const filePath = join(directory, fileName);
      try {
        await writeFile(filePath, image.bytes);
      } catch (error) {
        failures.push({
          url: image.sourceUrl,
          engine: candidate.engine,
          reason: `write failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return undefined;
      }
      files.push({
        path: filePath,
        fileName,
        mediaType: image.mediaType,
        bytes: image.bytes.length,
        width: image.width,
        height: image.height,
        sourceUrl: image.sourceUrl,
        pageUrl: candidate.pageUrl,
        title: candidate.title,
        engine: candidate.engine,
        // 授权与作者（Commons 提供）：必须原样带到落盘结果，否则上层清单里丢失，
        // 用户只能回站点自己翻——那正是商业频道最容易踩版权坑的地方。
        license: candidate.license,
        artist: candidate.artist,
        // 图床无防盗链 → 这条直链可以直接嵌进回复正文显示（详见该函数的说明）。
        hotlinkFriendly: isHotlinkFriendly(image.sourceUrl),
      });
      return undefined;
    } finally {
      inFlight -= 1;
    }
  });

  // 并发完成顺序不等于清晰度顺序，落盘序号保持稳定可读。
  files.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  return { files, failures };
}
