# linuxdo-rss-cdn

把 Linux.do 主题链接自动转换为 RSS，解码正文中的 `upload://` 短链，并输出替换后的 `feed.xml` 或 Markdown。页面与代理都部署在 Cloudflare Workers 上，不依赖第三方 CORS 代理。

## 功能

- 输入 `https://linux.do/t/topic/3109398`，自动拼出 `https://linux.do/t/topic/3109398.rss`
- 通过同源 Worker API 拉取 RSS，避开浏览器 CORS 限制
- 解析 RSS 2.0 / Atom 基本结构，展示主帖与回复内容
- 将 `upload://<Base62>.<ext>` 解码为：
  `https://cdn3.ldstatic.com/original/4X/<h0>/<h1>/<h2>/<sha1-hex>.<ext>`
- 一键复制 / 下载替换后的 `feed.xml`
- 一键复制 / 下载整理后的 Markdown（包含作者、时间、原帖链接和 CDN 图片）
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

页面只替换 `upload://` token，XML 声明、CDATA、实体和其他内容保持原样。

## 本地开发

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

打开终端里 Wrangler 输出的地址（通常是 `http://localhost:8787`）。

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

`/api/rss` 只接受 Linux.do 主题链接、RSS 链接或纯数字 topic id，并只请求固定格式的 Linux.do RSS 地址，避免成为任意 URL 代理。返回内容为原始 RSS XML，带 5 分钟缓存头。

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
wrangler.jsonc     Workers 静态资源与入口配置
```

## 已知限制

- 如果 Linux.do 对 Cloudflare 出口或 `linux.do` 的 RSS 路径启用登录 / 风控，Worker 代理可能收到非 RSS 内容。页面会提示，并可直接粘贴浏览器里打开的 RSS 原文继续处理。
- CDN 路径按 Linux.do 当前使用的 `cdn3.ldstatic.com/original/4X` 规则生成；如果站点以后更换 CDN 布局，需要调整 `public/core.js` 中的 `CDN_BASE_PATH`。
- 预览会移除脚本、内联事件、内联样式和危险 URL；下载的 `feed.xml` 保留原始 XML，仅做短链替换。

## 隐私

应用不设置账号、数据库或日志收集。用户输入只用于当前 Worker 请求的 RSS 拉取；Worker 不主动持久化输入或 RSS 内容，页面解析结果只存在当前浏览器标签页中。
