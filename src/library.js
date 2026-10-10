/**
 * dsh-search-picture —— 图库结构：总文件夹、按次请求的子文件夹、暂存区、确认后移动。
 *
 * 目录约定（都在会话工作区下的下载根目录里）：
 *
 *   downloads/                      总文件夹
 *   ├── .staging/<批次 id>/         暂存区：搜索结果先落这里，只是候选，不算交付
 *   │   └── STAGING.md              本批清单（用户可读的预览清单）
 *   └── <用户要求命名>/             用户确认后才移入的正式子文件夹
 *
 * 「先预览、确认后再入正式文件夹」就是这两个目录之间的移动：暂存区里的东西随时可以
 * 整批丢弃，正式文件夹里只会有用户认可过的图片。
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { sanitizeQuery } from './util.js';

/** 暂存区目录名（以点开头，不与用户的正式子文件夹混淆）。 */
export const STAGING_DIRNAME = '.staging';

/** 图源搜索与人工挑选都达不到要求时的媒体类型白名单。 */
const KEEP_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/**
 * 生成供人或模型使用的中文/英文皆可的安全名字：
 * 去掉路径分隔符与控制字符、压缩空白、截断长度、去掉结尾的点与空格（Windows 限制）。
 * @param raw 原始文本（查询词或用户指定的名字）。
 * @param fallback 清洗后为空时的兜底名字。
 * @param maxLength 最大字符数。
 * @returns 可用作目录名的字符串。
 */
export function folderNameFrom(raw, fallback = '图片', maxLength = 40) {
  const cleaned = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = cleaned === '' ? fallback : cleaned.slice(0, maxLength).trim();
  return clipped.replace(/[. ]+$/g, '') || fallback;
}

/** 批次 id 用的短随机串（避免同秒内两次搜索撞目录）。 */
function batchId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

/**
 * 清理预览区里的**历史批次**（用户要求：下一次搜索时自动清理上一次的残留）。
 *
 * 为什么需要：预览区是「待确认」的地方，但如果用户没确认就问了下一个问题，
 * 旧候选会一直堆着——实测曾累积 15 批 / 94 个文件 / 144 MB。所以每次新搜索开始前，
 * 先把上一次留下的批次删掉。
 *
 * ⚠️ 两个必须守住的安全边界：
 *   1. **绝不删当前批次**（`keepBatchId`）——否则会把用户正要看的候选清掉；
 *   2. 只删 `.staging/` 下**看起来像批次 id 的目录**（`<14位时间戳>-<4位随机>`），
 *      不碰任何其他名字的子目录/文件，避免误删。
 *
 * @param root 下载根目录。
 * @param keepBatchId 本次新建的批次 id（必须保留）。
 * @returns `{ removed, kept }`：删掉的批次名与保留的批次名。
 */
export async function pruneStaging(root, keepBatchId) {
  const stagingRoot = join(root, STAGING_DIRNAME);
  const removed = [];
  const kept = [];
  let entries;
  try {
    entries = await readdir(stagingRoot, { withFileTypes: true });
  } catch {
    // 预览区还不存在（首次搜索）——不是错误。
    return { removed, kept };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // 顶层散落的文件不动
    const name = entry.name;
    if (name === keepBatchId) {
      kept.push(name);
      continue;
    }
    // 只清「批次 id」形态的目录；其他命名的目录一律保留，避免误删用户自己的东西。
    if (!/^\d{14}-[a-z0-9]{4}$/.test(name)) {
      kept.push(name);
      continue;
    }
    try {
      await rm(join(stagingRoot, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      kept.push(name);
    }
  }
  return { removed, kept };
}

/**
 * 生成一个批次：只创建**暂存区**（预览区），不创建任何正式目录。
 *
 * 用户要求「不建文件夹、确认后直接输出到相册」，所以落盘目标由确认那一刻决定
 * （见 {@link saveToAlbum}），搜索阶段在磁盘上只留暂存区。
 * `finalDir` 仅作为历史信息保留（清单与日志展示），不再是写入目标。
 *
 * @param root 下载根目录（总文件夹）的绝对路径。
 * @param query 本次查询词。
 * @param requestedName 调用方指定的名字（可空）。
 * @returns `{ id, stagingDir, folderName, finalDir }`。
 */
export async function createBatch(root, query, requestedName) {
  const id = batchId();
  const stagingDir = join(root, STAGING_DIRNAME, id);
  await mkdir(stagingDir, { recursive: true });
  const folderName = folderNameFrom(requestedName ?? query, '图片');
  return { id, stagingDir, folderName, finalDir: join(root, folderName) };
}

/**
 * 把清单写进暂存区，既是给人看的预览说明，也是移动时的依据。
 * @param stagingDir 暂存目录。
 * @param content Markdown 文本。
 */
export async function writeManifest(stagingDir, content) {
  await writeFile(join(stagingDir, 'STAGING.md'), content, 'utf8');
}

/**
 * 列出暂存目录里的图片文件（按文件名排序，忽略清单等非图片文件）。
 *
 * 目录不存在时返回空数组而不是抛错：调用方（确认/清理）需要把「预览区已被移除」
 * 当成正常状态处理，而不是变成一个未捕获的异常。
 *
 * @param stagingDir 暂存目录。
 * @returns 文件名数组。
 */
export async function listStaged(stagingDir) {
  let entries;
  try {
    entries = await readdir(stagingDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && KEEP_EXTENSIONS.has(extnameOf(entry.name)))
    .map((entry) => entry.name)
    .sort();
}

/** 小写扩展名。 */
function extnameOf(name) {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

/**
 * 在目标目录里找一个不冲突的文件名（同名时追加 `-2`、`-3`…）。
 * @param dir 目标目录。
 * @param fileName 期望文件名。
 * @returns 可用的文件名。
 */
async function availableName(dir, fileName) {
  const dot = fileName.lastIndexOf('.');
  const stem = dot <= 0 ? fileName : fileName.slice(0, dot);
  const ext = dot <= 0 ? '' : fileName.slice(dot);
  let candidate = fileName;
  for (let index = 2; ; index += 1) {
    try {
      await stat(join(dir, candidate));
    } catch {
      return candidate;
    }
    candidate = `${stem}-${String(index)}${ext}`;
  }
}

/**
 * 把用户认可的图片**写入相册**（一个固定目录，内部平铺、不再建子文件夹）。
 *
 * 与 {@link promotePictures} 的区别，都是用户明确要求带来的：
 *   - **目标固定**：相册目录由配置决定，不按「每次要求」建子文件夹；
 *   - **复制而非移动**：相册在工作区之外（系统图片文件夹），跨目录复制更稳，
 *     而且 `discard` 之外未被选中的候选**保持在预览区**，用户改主意时还能再要；
 *   - 相册内重名自动追加序号，绝不覆盖已有图片。
 *
 * @param options `{ stagingDir, albumDir, keep, discard }`。
 * @returns `{ saved, discarded, failures }`。
 */
export async function saveToAlbum(options) {
  const { stagingDir, albumDir, keep, discard = [] } = options;
  const staged = await listStaged(stagingDir);
  const stagedSet = new Set(staged);
  const failures = [];

  const keepNames = [];
  for (const raw of keep) {
    const name = basename(String(raw));
    if (!stagedSet.has(name)) {
      failures.push({ file: String(raw), reason: '预览区里没有这个文件（可能名字写错或已被处理）' });
      continue;
    }
    if (!keepNames.includes(name)) keepNames.push(name);
  }
  if (keepNames.length === 0) return { saved: [], discarded: [], failures };

  // 相册目录可能在工作区之外（系统图片文件夹），创建失败要如实报出来，
  // 而不是让后面的写入各自报一堆错。
  try {
    await mkdir(albumDir, { recursive: true });
  } catch (error) {
    return {
      saved: [],
      discarded: [],
      failures: [...failures, { file: '(相册)', reason: `无法创建相册目录 ${albumDir}：${error instanceof Error ? error.message : String(error)}` }],
    };
  }

  const saved = [];
  for (const name of keepNames) {
    const from = join(stagingDir, name);
    const target = await availableName(albumDir, name);
    const to = join(albumDir, target);
    try {
      const data = await readFile(from);
      await writeFile(to, data);
      const info = await stat(to);
      saved.push({ fileName: target, path: to, bytes: info.size });
    } catch (error) {
      failures.push({ file: name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const discarded = [];
  for (const raw of discard) {
    const name = basename(String(raw));
    if (!stagedSet.has(name)) {
      failures.push({ file: String(raw), reason: '预览区里没有这个文件，无法丢弃' });
      continue;
    }
    try {
      await rm(join(stagingDir, name), { force: true });
      discarded.push(name);
    } catch (error) {
      failures.push({ file: name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  // 预览区被清空时才移除批次目录，不留空壳。
  if ((await listStaged(stagingDir)).length === 0) {
    await rm(stagingDir, { recursive: true, force: true });
  }
  return { saved, discarded, failures };
}

/**
 * 把用户认可的图片从暂存区移入正式子文件夹。
 *
 * - 只接受暂存区里**确实存在**的图片文件名；未知名字会逐一报错，不会被静默忽略。
 * - 目标重名时自动追加序号，不覆盖已有图片。
 * - `discard` 里的图片从暂存区删除；未被选中也未标记丢弃的保持原样，方便用户改主意。
 * - 移完后若暂存区已空，整批目录被清掉，不留空壳。
 *
 * @param options `{ stagingDir, finalDir, keep, discard }`。
 * @returns `{ saved, discarded, failures, stagingRemoved }`。
 */
export async function promotePictures(options) {
  const { stagingDir, finalDir, keep, discard = [] } = options;
  const staged = await listStaged(stagingDir);
  const stagedSet = new Set(staged);
  const failures = [];

  const keepNames = [];
  for (const raw of keep) {
    const name = basename(String(raw));
    if (!stagedSet.has(name)) {
      failures.push({ file: String(raw), reason: '暂存区里没有这个文件（可能名字写错或已被处理）' });
      continue;
    }
    if (!keepNames.includes(name)) keepNames.push(name);
  }
  if (keepNames.length === 0) {
    return { saved: [], discarded: [], failures, stagingRemoved: false };
  }

  await mkdir(finalDir, { recursive: true });
  const saved = [];
  for (const name of keepNames) {
    const from = join(stagingDir, name);
    const target = await availableName(finalDir, name);
    const to = join(finalDir, target);
    try {
      try {
        await rename(from, to);
      } catch {
        // 跨设备（暂存区与目标不在同一卷）时 rename 会失败，退回「读—写—删」。
        const data = await readFile(from);
        await writeFile(to, data);
        await rm(from, { force: true });
      }
      const info = await stat(to);
      saved.push({ fileName: target, path: to, bytes: info.size });
    } catch (error) {
      failures.push({ file: name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const discarded = [];
  for (const raw of discard) {
    const name = basename(String(raw));
    if (!stagedSet.has(name) || !staged.includes(name)) {
      failures.push({ file: String(raw), reason: '暂存区里没有这个文件（可能名字写错或已被处理）' });
      continue;
    }
    try {
      await rm(join(stagingDir, name), { force: true });
      discarded.push(name);
    } catch (error) {
      failures.push({ file: name, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const remaining = await listStaged(stagingDir);
  let stagingRemoved = false;
  if (remaining.length === 0) {
    await rm(stagingDir, { recursive: true, force: true });
    stagingRemoved = true;
  }
  return { saved, discarded, failures, stagingRemoved };
}

/**
 * 解析暂存路径：允许调用方给绝对路径，也允许给相对下载根目录的路径或批次 id。
 * @param root 下载根目录。
 * @param reference 批次 id、相对路径或绝对路径。
 * @returns 稳定的绝对路径。
 */
export function resolveStaging(root, reference) {
  const text = String(reference ?? '').trim();
  if (text === '') return join(root, STAGING_DIRNAME);
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')) return text;
  if (text.startsWith(STAGING_DIRNAME)) return join(root, text);
  return join(root, STAGING_DIRNAME, text);
}
