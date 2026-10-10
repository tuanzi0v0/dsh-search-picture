/**
 * 量出 B 站搜索接口在被限流后的恢复时间。
 *
 * 已知：无 cookie 时突发请求会返回 -412 request was banned，但它不是永久封禁。
 * 之前探针里 2.5 秒退避就能偶尔成功，说明窗口不长；这里用递增等待实测恢复点，
 * 据此决定插件该退避多久（而不是拍一个秒数）。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://search.bilibili.com/';
const url = (type, keyword) => `https://api.bilibili.com/x/web-interface/search/type?search_type=${type}&keyword=${encodeURIComponent(keyword)}&page=1`;

async function probe(label, type, keyword) {
  const started = Date.now();
  try {
    const res = await fetch(url(type, keyword), {
      headers: { 'user-agent': UA, accept: 'application/json', referer: REFERER },
      signal: AbortSignal.timeout(20000),
    });
    const body = JSON.parse(await res.text());
    const count = Array.isArray(body.data?.result) ? body.data.result.length : 0;
    console.log(`  ${label.padEnd(26)} code=${String(body.code).padStart(5)} items=${String(count).padStart(3)} ${String(Date.now() - started)}ms ${body.code !== 0 ? String(body.message) : ''}`);
    return body.code === 0 && count > 0;
  } catch (error) {
    console.log(`  ${label.padEnd(26)} ERR ${error.message}`);
    return false;
  }
}

console.log('=== 先确认当前状态 ===');
await probe('现在的状态', 'video', '终末地');

console.log('\n=== 连续请求（模拟插件行为：4 个图源并发里的 B 站那一路） ===');
for (let index = 1; index <= 4; index += 1) {
  await probe(`连发第 ${String(index)} 次`, 'video', `终末地${'x'.repeat(index)}`);
}

console.log('\n=== 递增等待，找恢复点 ===');
for (const waitMs of [2000, 4000, 8000, 15000, 30000]) {
  console.log(`  等待 ${String(waitMs / 1000)}s ...`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const ok = await probe(`等 ${String(waitMs / 1000)}s 后`, 'video', '终末地');
  if (ok) {
    console.log(`\n  恢复点：约 ${String(waitMs / 1000)}s（距上一次请求）`);
    break;
  }
}
