# linuxdo-rss-cdn

把 Linux.do 主题链接自动转换为 RSS，解码正文中的 `upload://` 短链，并输出替换后的 `feed.xml` 或 Markdown。页面与代理都部署在 Cloudflare Workers 上，不依赖第三方 CORS 代理。

## 功能

- 输入 `https://linux.do/t/topic/3109398`，自动拼出 `https://linux.do/t/topic/3109398.rss`
- 通过同源 Worker API 拉取 RSS，避开浏览器 CORS 限制
- Linux.do 直连被 Cloudflare 挑战拦截时，自动回退到 Jina Reader / Browser Rendering 获取原始 RSS
- 支持 `?topic=<Linux.do 主题 URL>` 深链：浏览器扩展右键可带当前 topic 打开并自动解析
- 解析 RSS 2.0 / Atom 基本结构，识别频道主帖与评论 item
- **默认剥离评论 item，并始终生成一个主帖 `<item>`**，即使原 RSS 只有一个正文；也可随时切换为「主帖 + 评论」
- 将 `upload://<Base62>.<ext>` 解码为：
  `https://cdn3.ldstatic.com/original/4X/<h0>/<h1>/<h2>/<sha1-hex>.<ext>`
- 一键复制 / 下载替换后的 `feed.xml`
- 一键复制 / 下载整理后的 Markdown（默认只含主帖；包含作者、时间、原帖链接和 CDN 图片）
- 可查看图片短链与 CDN 直链映射，并复制单条或全部直链
- 代理不可用时，支持直接粘贴 RSS 原文离线解析
- 响应式布局，支持浅色 / 深色系统主题

## 原理

Discourse 的短上传 URL 形如：

```text
upload://1aBcDeFg.webp
```

短链中的上传 ID 使用 Discourse 自己的 Base62 字母表：

```text
0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ
```

解码后得到 40 位 SHA-1 十六进制值，拼成 CDN 地址：

```text
https://cdn3.ldstatic.com/original/4X/<h[0]>/<h[1]>/<h[2]>/<40-hex>.<ext>
```

页面只替换 `upload://` token。Linux.do 的 RSS 把主帖正文放在 `channel > description`，把每条评论放在 `channel > item`；“仅主帖”模式会移除评论 item，并把 `channel > description` 中的正文重新封装成一个标准主帖 `<item>`（title/link/guid/pubDate/description）。`channel > description` 会缩成摘要，避免正文重复。

抓取顺序：先直接请求 Linux.do RSS；如果返回 Cloudflare 挑战或非 RSS，再通过 `r.jina.ai` 的纯文本模式获取同一份 RSS。前端会显示实际使用的数据源。

## 本地开发

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

打开终端里 Wrangler 输出的地址（通常是 `http://localhost:8787`）。

也支持直接带 topic 打开并自动拉取：

```text
http://localhost:8787/?topic=https%3A%2F%2Flinux.do%2Ft%2Ftopic%2F3109398
```

运行测试和 Worker 打包检查：

```bash
npm run check
```

## 部署到 Cloudflare Workers

1. 登录 Cloudflare：

   ```bash
   npx wrangler login
   ```

2. 部署：

   ```bash
   npm run deploy
   ```

3. Wrangler 会输出 `https://linuxdo-rss-cdn.<你的子域>.workers.dev` 一类的地址。

项目使用 Workers Static Assets：`public/` 下的静态页面由同一个 Worker 提供，`/api/*` 由 `src/index.js` 处理。Worker 名称、静态资源目录等配置在 `wrangler.jsonc`。

## Worker API

```text
GET /api/rss?topic=3109398
GET /api/rss?topic=https%3A%2F%2Flinux.do%2Ft%2Ftopic%2F3109398
GET /api/health
```

`/api/rss` 只接受 Linux.do 主题链接、RSS 链接或纯数字 topic id，并只请求固定格式的 Linux.do RSS 地址，避免成为任意 URL 代理。返回内容为原始 RSS XML，带 5 分钟缓存头；响应头 `x-fetch-source` 表示本次使用的抓取方式（`direct` 或 `jina-reader`）。失败时返回 JSON，内含每次抓取的 HTTP 状态、内容类型和响应片段。

## 项目结构

```text
public/
  index.html       页面结构
  styles.css       响应式样式与深色主题
  app.js           拉取、解析、Markdown 生成、预览、复制与下载
  core.js          浏览器和 Worker 共用的 Base62 / URL 工具
src/
  index.js         Cloudflare Worker 入口和 RSS 代理
test/
  core.test.js     Base62、upload:// 替换和 topic URL 解析测试
  ui.test.js       评论剥离、范围切换、错误展示与输出生成的 DOM 级测试
  worker.test.js   直连失败回退与错误详情测试
wrangler.jsonc     Workers 静态资源与入口配置
```

## 已知限制

- Linux.do 对普通 Worker 出口启用 Cloudflare 挑战时，直连会返回 HTTP 403。项目会自动使用 Jina Reader 备用抓取；如果备用服务也不可用，页面会显示真实错误、每次请求状态和响应片段，并保留「粘贴 RSS 原文」模式。
- “仅主帖”通过移除评论 item 并重建一个主帖 item 实现；如果未来 Linux.do 改变 RSS 结构，需要同步调整 `public/app.js` 中的 `buildScopedFeedXml()`。
- CDN 路径按 Linux.do 当前使用的 `cdn3.ldstatic.com/original/4X` 规则生成；如果站点以后更换 CDN 布局，需要调整 `public/core.js` 中的 `CDN_BASE_PATH`。
- 预览会移除脚本、内联事件、内联样式和危险 URL；下载的 `feed.xml` 保留原始 XML，仅做短链替换。

## 隐私

应用不设置账号、数据库或日志收集。用户输入只用于当前 Worker 请求的 RSS 拉取；Worker 不主动持久化输入或 RSS 内容，页面解析结果只存在当前浏览器标签页中。直连失败时，RSS 地址会发送给 Jina Reader（`r.jina.ai`）作为备用抓取；如果不想使用第三方备用服务，可使用粘贴 RSS 模式。
- Jina Reader 偶尔会在原始 XML 前再附加一个 XML 声明，导致浏览器报 `XML declaration allowed only at the start of the document`。`normalizeRssXmlText()` 会把声明收敛为一个并移动到文档最前面。
- Jina Reader 无鉴权请求有速率限制；遇到 429 时页面会显示真实的 429 响应和重试建议，也可以改用粘贴 RSS 模式。

## 可选：Browser Rendering 与 Jina API Key

- Worker 配置了 `BROWSER` binding。直连和 Jina Reader 都失败时，会启动 Cloudflare Browser Rendering 在真实浏览器中打开 RSS，再取回 XML。Browser Rendering 可能产生相应用量。
- 如果 Jina Reader 的共享 IP 经常 429，可以设置 `JINA_API_KEY` Secret 提高限额：

  ```bash
  npx wrangler secret put JINA_API_KEY
  ```
