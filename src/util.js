/**
 * dsh-search-picture —— 通用小工具：超时、限流、HTML/JSON 取值、文件名清洗。
 *
 * 本模块不依赖 DSH，便于离线自测。
 */

/** 默认浏览器 User-Agent（图源站与图床普遍拒绝非浏览器 UA）。 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 构造一个「外部信号 + 自身超时」的组合 AbortSignal。
 * @param signal 调用方信号（可空）。
 * @param timeoutMs 超时毫秒。
 * @returns `{ signal, dispose }`；调用方必须在 finally 里 dispose。
 */
export function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', forward, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener('abort', forward);
    },
  };
}

/**
 * 带超时与浏览器 UA 的 HTTP GET。
 * @param url 目标 URL。
 * @param options `{ signal, timeoutMs, headers, referer }`。
 * @returns `{ status, contentType, bytes, finalUrl }`；HTTP 状态不抛错，网络错误抛错。
 */
export async function httpGet(url, options = {}) {
  const { signal, timeoutMs = 20000, headers = {}, referer } = options;
  const scoped = withTimeout(signal, timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: scoped.signal,
      headers: {
        'user-agent': headers['user-agent'] ?? BROWSER_UA,
        accept: headers.accept ?? '*/*',
        'accept-language': headers['accept-language'] ?? 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
        ...(referer === undefined ? {} : { referer }),
      },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      bytes,
      finalUrl: response.url === '' ? url : response.url,
    };
  } finally {
    scoped.dispose();
  }
}

/**
 * 带超时与浏览器 UA 的 HTTP GET。
 * @param url 目标 URL。
 * @param options `{ signal, timeoutMs, headers, referer, maxBytes }`。
 * @returns `{ status, contentType, bytes, truncated, tooLarge, finalUrl }`；HTTP 状态不抛错，网络错误抛错。
 *   响应体在超过 `maxBytes` 时截断（`tooLarge` 表示声明的 Content-Length 已超限）。
 */
export async function httpGetCapped(url, options = {}) {
  const {
    signal,
    timeoutMs = 20000,
    headers = {},
    referer,
    maxBytes = 12 * 1024 * 1024,
  } = options;
  const scoped = withTimeout(signal, timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: scoped.signal,
      headers: {
        // 图床普遍按 UA 放行；`referer` 只在显式传入时发送 —— 不少站点的
        // 防盗链恰好是「有第三方 Referer 就拒绝」，不发送反而拿到原图。
        'user-agent': BROWSER_UA,
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
        ...(referer === undefined ? {} : { referer }),
      },
    });
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        bytes: new Uint8Array(0),
        truncated: true,
        tooLarge: true,
        finalUrl: response.url === '' ? url : response.url,
      };
    }
    if (response.body === null) {
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        bytes: new Uint8Array(0),
        truncated: false,
        finalUrl: response.url === '' ? url : response.url,
      };
    }
    const chunks = [];
    let total = 0;
    let truncated = false;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        const remaining = maxBytes - total;
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
          truncated = true;
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      bytes,
      truncated,
      finalUrl: response.url === '' ? url : response.url,
    };
  } finally {
    scoped.dispose();
  }
}

/**
 * 以固定并发上限逐个执行任务，返回与输入等长的结果数组（永不抛错）。
 * @param items 输入项。
 * @param limit 并发上限（至少 1）。
 * @param worker `(item, index) => Promise<T>`。
 * @returns 每项的成功值或抛出的错误。
 */
export async function mapLimit(items, limit, worker) {
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { __error: error };
      }
    }
  }
  await Promise.all(Array.from({ length: width }, run));
  return results;
}

/**
 * 解码 HTML 实体（图源把 JSON 塞进属性时会转义引号与 &）。
 * @param text 原始文本。
 * @returns 解码后的文本。
 */
export function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?34;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#0?38;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 把可能在 URL 里重复编码的地址规范化为 URL 字符串。
 * 图床常见 `http://` 与 `https://` 混用、`//host/path` 协议相对写法。
 * @param raw 原始候选地址。
 * @param base 协议相对地址的补全基准。
 * @returns 规范化后的 URL，或 undefined（无法解析）。
 */
export function normalizeUrl(raw, base = 'https://example.invalid/') {
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim();
  if (text === '') return undefined;
  if (text.startsWith('//')) text = `https:${text}`;
  if (text.startsWith('data:')) return undefined;
  try {
    const url = new URL(text, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * 清洗查询词，用于目录/文件名：去掉路径分隔符与控制字符，压缩空白。
 * @param query 原始查询词。
 * @param maxLength 最大字符数。
 * @returns 可安全用于 Windows 文件名或目录名的片段。
 */
export function sanitizeQuery(query, maxLength = 40) {
  const cleaned = String(query ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = cleaned.length === 0 ? 'picture' : cleaned.slice(0, maxLength).trim();
  // Windows 不允许目录名以点或空格结尾。
  return clipped.replace(/[. ]+$/g, '') || 'picture';
}

/** 人类可读的字节数（渲染结果文本用）。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
