/**
 * 读当前会话日志（zstd 压缩的 JSONL），确认 search_picture 的 tool/result 里到底有没有
 * 写入展示元数据（presentationMeta）。这决定「聊天里的卡片」是数据缺失还是渲染问题。
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const raw = readFileSync(file);
let text;
try {
  text = zlib.zstdDecompressSync(raw).toString('utf8');
} catch (error) {
  console.log('zstd 解压失败:', error.message);
  process.exit(2);
}
console.log(`解压后 ${String(text.length)} 字符`);

// 会话日志可能是「一行一事件」的 JSONL；也可能是长度前缀流，因此两种都试。
const lines = text.split('\n').filter((line) => line.trim() !== '');
console.log(`按行切分得到 ${String(lines.length)} 行`);

let parsed = 0;
const events = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
    parsed += 1;
  } catch {
    /* 非 JSON 行忽略 */
  }
}
console.log(`可解析为 JSON 的行：${String(parsed)}`);

const toolResults = events.filter((event) => typeof event?.type === 'string' && event.type.includes('tool') && event.type.includes('result'));
console.log(`tool/result 类事件：${String(toolResults.length)}`);
for (const event of toolResults.slice(-6)) {
  const name = event.data?.name ?? event.data?.toolName ?? event.name ?? '(未知)';
  const meta = event.data?.meta;
  console.log(`\n--- ${String(event.type)} name=${String(name)}`);
  console.log(`    有 meta: ${meta !== undefined}`);
  if (meta !== undefined) {
    const keys = typeof meta === 'object' && meta !== null ? Object.keys(meta) : [];
    console.log(`    meta 键: ${keys.join(', ') || '(空)'}`);
    if (Array.isArray(meta.images)) {
      console.log(`    meta.images 条数: ${String(meta.images.length)}`);
      const first = meta.images[0];
      if (first) console.log(`    第 1 张: fileName=${String(first.fileName)} 有 attachment=${first.attachment !== undefined} previewFolder=${String(meta.previewFolder)}`);
    }
  }
  const content = event.data?.content ?? event.data?.result?.content;
  if (Array.isArray(content)) {
    const kinds = content.map((block) => block?.type).join(',');
    console.log(`    content 块类型: ${kinds}`);
  }
}
