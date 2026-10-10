/**
 * B 站图源专项自测：确认「专栏正文配图 / 图文图片集」这条路真的能拿到图并落盘。
 *
 * 与总自测分开，因为 B 站接口会限流，需要独立观察退避是否生效。
 * 用法：node .work/selftest-bilibili.mjs ["查询词"] [张数]
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { downloadCandidates } from '../src/download.js';
import { imageSize, sniffImageMediaType } from '../src/image.js';
import { runEngine } from '../src/providers.js';
import { sanitizeQuery } from '../src/util.js';

const query = process.argv[2] ?? '终末地';
const count = Number(process.argv[3] ?? 4);
const outDir = join(process.cwd(), '.work', 'bilibili-downloads');

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

console.log(`== B 站图源：query="${query}" ==`);
const started = Date.now();
const result = await runEngine('bilibili', query, { timeoutMs: 25000 });
console.log(`  候选 ${String(result.candidates.length)} 条，error=${result.error ?? '-'}，用时 ${String(Date.now() - started)}ms`);

// 限流是瞬时状态，不是图源失效：如实记录，但不算失败。
if (result.error !== undefined && /rate limited/.test(result.error)) {
  console.log(`  ⚠ B 站瞬时限流（${result.error}）；退避已尽力，稍后重试即可。`);
  process.exit(0);
}
check('B 站返回候选', result.candidates.length > 0, result.error ?? '');

const withTier = result.candidates.filter((c) => c.tier === 'cover').length;
console.log(`  其中标记为「视频封面（低优先）」的：${withTier} 条`);
const byPage = new Map();
for (const candidate of result.candidates) {
  const key = candidate.pageUrl ?? '(无出处)';
  byPage.set(key, (byPage.get(key) ?? 0) + 1);
}
console.log(`  出处页面 ${String(byPage.size)} 个，例如：`);
for (const [page, n] of [...byPage.entries()].slice(0, 5)) console.log(`    ${String(n)} 张 <- ${page}`);
for (const candidate of result.candidates.slice(0, 3)) {
  console.log(`    图: ${candidate.imageUrl.slice(0, 110)}`);
}

const { files, failures } = await downloadCandidates(result.candidates, {
  directory: outDir,
  query: sanitizeQuery(query),
  count,
  minPixels: 921600,
  minLongEdge: 1000,
  maxAspectRatio: 2.6,
  minBytes: 4096,
  concurrency: 4,
  timeoutMs: 30000,
});
console.log(`\n  下载：成功 ${String(files.length)} 张，失败/淘汰 ${String(failures.length)} 条`);
for (const failure of failures.slice(0, 5)) console.log(`    - ${failure.reason} :: ${failure.url.slice(0, 80)}`);
for (const file of files) {
  const bytes = new Uint8Array(await readFile(file.path));
  const info = await stat(file.path);
  check(
    `${file.fileName} (${String(file.width)}x${String(file.height)}, ${String(file.bytes)}B) 校验一致`,
    info.size === file.bytes && sniffImageMediaType(bytes) === file.mediaType && imageSize(bytes, file.mediaType)?.width === file.width,
    `stat=${String(info.size)}`,
  );
}
check('下载到至少 1 张', files.length > 0);

console.log(`\n目录：${outDir}`);
console.log(`断言失败数：${String(failed)}`);
process.exit(failed === 0 ? 0 : 1);
