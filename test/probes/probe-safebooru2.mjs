/**
 * 补两个决定实现方式的细节：
 *   1. 空结果/异常时 Safebooru 到底返回什么（决定解析器怎么写）；
 *   2. 「标签字面匹配」这个坑有多大——对比「正确标签」与「英文自然语言」的搜索结果。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function raw(label, tags, limit = 5) {
  const url = `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=${String(limit)}&tags=${encodeURIComponent(tags)}`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let parsed;
    let note;
    try {
      parsed = JSON.parse(text);
      note = Array.isArray(parsed) ? `array(${String(parsed.length)})` : `typeof=${typeof parsed}`;
    } catch {
      note = `非 JSON：${text.slice(0, 70).replace(/\s+/g, ' ')}`;
    }
    console.log(`  ${label.padEnd(38)} HTTP ${String(res.status)} ${note}`);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.log(`  ${label.padEnd(38)} ERR ${error.message}`);
    return [];
  }
}

console.log('=== 1. 边界返回形态 ===');
await raw('不存在的标签（应空）', 'zzz_this_tag_does_not_exist_zzz', 3);
await sleep(500);
await raw('中文标签（应空或报错）', '可塑性记忆', 3);
await sleep(500);
await raw('空标签（等于全站最新）', '', 3);
await sleep(500);
await raw('两个标签组合', 'arknights 1girl', 3);
await sleep(500);
await raw('带空格的自然语言（booru 会当标签）', 'plastic memories isla', 3);

console.log('\n=== 2. 「标签字面匹配」的坑有多大 ===');
const pairs = [
  ['正确标签', 'isla_(plastic_memories)'],
  ['自然语言', 'Plastic Memories Isla'],
  ['大类标签', 'plastic_memories'],
];
for (const [label, tags] of pairs) {
  const rows = await raw(`${label}: ${tags}`, tags, 4);
  const first = rows[0];
  if (first) {
    const tags0 = String(first.tags ?? '').split(' ').slice(0, 10).join(' ');
    console.log(`      → 首条标签：${tags0}`);
  } else {
    console.log('      → 无结果');
  }
  await sleep(600);
}

console.log('\n=== 3. 中文查询怎么办：能否用拼音/罗马字 ===');
for (const tags of ['tifulos', 'tiflos', 'endfield', 'arknights:_endfield']) {
  await raw(`tags=${tags}`, tags, 3);
  await sleep(500);
}
