# 自测

这些脚本**不依赖 DSH 运行时**，可以直接用 Node 跑。它们只读取插件源码，不修改它。

## 运行方式

**从仓库根目录**执行（推荐）：

```bash
node test/selftest.mjs "可塑性记忆 艾拉" 4
```

也可以 `cd test` 后直接跑（脚本按自身位置定位仓库根，两种方式都可以）：

```bash
cd test && node selftest.mjs "可塑性记忆 艾拉" 4
```

## 全部套件

```bash
node test/selftest.mjs "可塑性记忆 艾拉" 4      # 图源解析 + 端到端下载
node test/selftest-host.mjs                    # 预览 → 确认 → 写相册 全流程、输出形状
node test/selftest-client.mjs                  # Client 半注册与渲染输入
node test/selftest-bilibili.mjs "终末地" 4      # B 站图源（含限流观察）
node test/selftest-official.mjs                # 官网通路专项
node test/selftest-safebooru.mjs               # Safebooru 解析边界 + 端到端
node test/selftest-safebooru-e2e.mjs           # Safebooru 下载 → 落盘 → 写相册（逐字节校验）
node test/selftest-related.mjs                 # 相关站点（萌娘百科）+ 水印过滤
node test/selftest-prune.mjs                   # 预览区自动清理（含安全边界）
node test/selftest-schema.mjs                  # 真实输出 vs 声明 schema
node test/selftest-readme.mjs                  # README 与代码一致性
```

每个脚本都是「断言 + 计数」，**结尾打印「断言失败数：N」并用退出码表示结果**（0 = 全过）。串起来跑：

```bash
for f in test/selftest*.mjs; do node "$f" || echo "FAILED: $f"; done
```

## 注意

- 部分用例**依赖网络**（会真实访问图源）。图源波动会让个别断言失败——例如 B 站限流返回 HTTP 412、某个图源偶发超时；重跑通常就过。`selftest-readme` 与 `selftest-schema` 是纯本地检查，最稳定，适合当快速验收。
- 用例会在当前目录下建临时目录（`.work/` 之类）存下载的图片，可以直接删；`.gitignore` 已排除。
- 用例**不会**写入你的系统图片文件夹——涉及相册的用例都把相册指向测试临时目录。
- `test/probes/` 是开发期用来**实测各站点可行性**的脚本（例如「知乎为什么不能直连」「Pixiv 为什么本机不可达」「biligame 的 WAF 阈值」）。README 里引用的实测结论都由它们得出。它们不是断言式测试，而是把探测结果打印出来。
