/**
 * 最后一条线索：国内 DoH（阿里/腾讯）能通，那就看它们给的 Pixiv IP 是不是**真实**的。
 *
 * 如果给出的是真实日本 IP，说明污染只发生在本地 DNS 解析这一层，而到 Pixiv 的网络
 * 路径是通的 —— 那么「用加密 DNS 拿真实 IP + 直连」就能真的访问 Pixiv。
 * 如果给的也是污染结果或空记录，那就彻底没戏（只能靠代理/VPN）。
 *
 * 验证方式：拿到 IP 后直接对该 IP 建 TCP 连，并用 TLS SNI 指定 pixiv.net，
 * 看握手能不能完成、HTTP 能不能回 200。
 */
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 用国内 DoH 查询（JSON 接口）。 */
async function doh(host, provider) {
  const urls = {
    aliyun: `https://223.5.5.5/resolve?name=${encodeURIComponent(host)}&type=A`,
    tencent: `https://doh.pub/dns-query?name=${encodeURIComponent(host)}&type=A`,
  };
  try {
    const res = await fetch(urls[provider], {
      headers: { accept: 'application/dns-json', 'user-agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json();
    const answers = (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
    return answers;
  } catch (error) {
    return [`ERR ${error.message}`];
  }
}

/** TCP 建连测试。 */
function tcpProbe(ip, port = 443, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect({ host: ip, port });
    const done = (r) => {
      socket.destroy();
      resolve(`${r} ${String(Date.now() - started)}ms`);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('TCP OK'));
    socket.once('timeout', () => done('TCP TIMEOUT'));
    socket.once('error', (error) => done(`TCP ${error.code ?? error.message}`));
  });
}

/** 用指定的 SNI 对 IP 发一个 HTTPS 请求（绕开本地 DNS）。 */
function httpsViaIp(ip, host, path = '/') {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tlsConnect(
      { host: ip, port: 443, servername: host, rejectUnauthorized: false },
      () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      },
    );
    let data = '';
    socket.setTimeout(12000);
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(`TLS+TIMEOUT ${String(Date.now() - started)}ms ${data.split('\r\n')[0] ?? ''}`);
    });
    socket.once('error', (error) => {
      socket.destroy();
      resolve(`TLS ${error.code ?? error.message} ${String(Date.now() - started)}ms`);
    });
    socket.once('close', () => {
      const status = data.split('\r\n')[0] ?? '(无响应)';
      resolve(`${status} ${String(Date.now() - started)}ms`);
    });
  });
}

const HOSTS = ['pixiv.net', 'www.pixiv.net', 'i.pximg.net'];

console.log('=== 国内 DoH 返回的 IP ===');
const resolved = {};
for (const host of HOSTS) {
  const ali = await doh(host, 'aliyun');
  const tencent = await doh(host, 'tencent');
  resolved[host] = [...new Set([...ali, ...tencent])].filter((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
  console.log(`  ${host.padEnd(16)} 阿里=${ali.join(', ') || '(空)'}`);
  console.log(`  ${''.padEnd(16)} 腾讯=${tencent.join(', ') || '(空)'}`);
}

console.log('\n=== 对国内 DoH 给出的 IP 直连（绕开本地 DNS） ===');
for (const host of HOSTS) {
  for (const ip of resolved[host].slice(0, 3)) {
    const tcp = await tcpProbe(ip);
    console.log(`  ${host.padEnd(16)} → ${ip.padEnd(16)} ${tcp}`);
  }
}

console.log('\n=== 用 SNI 指定域名对真实 IP 发 HTTPS（关键验证） ===');
for (const host of HOSTS) {
  const ip = resolved[host][0];
  if (ip === undefined) {
    console.log(`  ${host} → 没有可用 IP，跳过`);
    continue;
  }
  console.log(`  ${host} @ ${ip}`);
  console.log(`    ${await httpsViaIp(ip, host, '/')}`);
}
