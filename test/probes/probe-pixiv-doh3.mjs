/**
 * 决定性验证：对「TCP 能连通」的那些 IP 做完整 TLS 握手 + HTTP 请求。
 *
 * 上一轮脚本错在「取 IP 列表的第一个」——第一个恰好是污染结果。这一轮改成
 * **先筛出 TCP 可达的 IP，再对它们做 TLS**。
 *
 * 若能拿到 HTTP 200，就证明：Pixiv 只要用加密 DNS 解析 + 直连真实 IP 就能访问，
 * 那么「支持 Pixiv 图源」是可行的，不需要代理。
 */
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function doh(host, provider) {
  const urls = {
    tencent: `https://doh.pub/dns-query?name=${encodeURIComponent(host)}&type=A`,
    aliyun: `https://223.5.5.5/resolve?name=${encodeURIComponent(host)}&type=A`,
  };
  try {
    const res = await fetch(urls[provider], {
      headers: { accept: 'application/dns-json', 'user-agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json();
    return (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return [];
  }
}

function tcpProbe(ip, port = 443, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = connect({ host: ip, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 对指定 IP 用 SNI 发 HTTPS，返回响应首行与正文前若干字符。 */
function httpsViaIp(ip, host, path = '/') {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tlsConnect({ host: ip, port: 443, servername: host, rejectUnauthorized: false }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nAccept-Language: zh-CN,zh;q=0.9\r\nConnection: close\r\n\r\n`,
      );
    });
    let head = '';
    let total = 0;
    socket.setTimeout(15000);
    const finish = (note) => {
      socket.destroy();
      const firstLine = head.split('\r\n')[0] ?? '(无响应)';
      resolve(`${firstLine} | ${note} | ${String(total)}B | ${String(Date.now() - started)}ms`);
    };
    socket.on('data', (chunk) => {
      total += chunk.length;
      if (head.length < 600) head += chunk.toString('latin1');
    });
    socket.once('timeout', () => finish('TIMEOUT'));
    socket.once('error', (error) => {
      socket.destroy();
      resolve(`TLS-ERR ${error.code ?? error.message} | ${String(Date.now() - started)}ms`);
    });
    socket.once('end', () => finish('EOF'));
  });
}

/** 从候选里筛出 TCP 可达的 IP。 */
async function reachable(host, ips) {
  const ok = [];
  for (const ip of ips) {
    if (await tcpProbe(ip)) {
      ok.push(ip);
      console.log(`    ✅ ${ip} TCP 可达`);
    } else {
      console.log(`    ❌ ${ip} TCP 不可达`);
    }
  }
  return ok;
}

console.log('=== 1. pixiv.net ===');
{
  const ips = [...new Set([...(await doh('pixiv.net', 'tencent')), ...(await doh('pixiv.net', 'aliyun'))])];
  console.log(`  候选：${ips.join(', ')}`);
  const ok = await reachable('pixiv.net', ips);
  for (const ip of ok.slice(0, 2)) {
    console.log(`  HTTPS ${ip} → ${await httpsViaIp(ip, 'pixiv.net', '/')}`);
  }
}

console.log('\n=== 2. www.pixiv.net（Cloudflare 段） ===');
{
  const ips = [...new Set([...(await doh('www.pixiv.net', 'tencent')), ...(await doh('www.pixiv.net', 'aliyun'))])];
  console.log(`  候选：${ips.join(', ')}`);
  const ok = await reachable('www.pixiv.net', ips);
  for (const ip of ok.slice(0, 2)) {
    console.log(`  HTTPS ${ip} → ${await httpsViaIp(ip, 'www.pixiv.net', '/')}`);
  }
}

console.log('\n=== 3. i.pximg.net（图片 CDN，关键） ===');
{
  const ips = [...new Set([...(await doh('i.pximg.net', 'tencent')), ...(await doh('i.pximg.net', 'aliyun'))])];
  console.log(`  DoH 候选：${ips.join(', ')}`);
  // Pixiv 的图片 CDN 与主站同属日本段；把已知可用段一并探测。
  const extra = ['210.140.139.155', '210.140.139.158', '210.140.139.161', '210.140.139.164', '210.140.139.167'];
  const all = [...new Set([...ips, ...extra])];
  console.log(`  实际探测：${all.join(', ')}`);
  const ok = await reachable('i.pximg.net', all);
  for (const ip of ok.slice(0, 3)) {
    console.log(`  HTTPS ${ip} → ${await httpsViaIp(ip, 'i.pximg.net', '/')}`);
  }
}

console.log('\n=== 4. 官方 API 段（若可达，就能搜索） ===');
{
  for (const host of ['app-api.pixiv.net', 'oauth.secure.pixiv.net']) {
    const ips = [...new Set([...(await doh(host, 'tencent')), ...(await doh(host, 'aliyun'))])];
    console.log(`  ${host} 候选：${ips.join(', ') || '(空)'}`);
    const ok = await reachable(host, ips.slice(0, 4));
    for (const ip of ok.slice(0, 1)) {
      console.log(`    HTTPS ${ip} → ${await httpsViaIp(ip, host, '/')}`);
    }
  }
}
