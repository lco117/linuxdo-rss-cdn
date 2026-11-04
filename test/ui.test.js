import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { JSDOM } from "jsdom";

import { BASE62_ALPHABET, CDN_BASE_PATH } from "../public/core.js";

function encodeBase62(hex) {
  let value = BigInt(`0x${hex}`);
  if (value === 0n) return "0";

  let output = "";
  while (value > 0n) {
    output = BASE62_ALPHABET[Number(value % 62n)] + output;
    value /= 62n;
  }
  return output;
}

function makeFeed() {
  const mainHash = "0123456789abcdef0123456789abcdef01234567";
  const commentHash = "abcdef0123456789abcdef0123456789abcdef01";
  const mainShort = encodeBase62(mainHash);
  const commentShort = encodeBase62(commentHash);

  return {
    mainCdn: `${CDN_BASE_PATH}/0/1/2/${mainHash}.webp`,
    commentCdn: `${CDN_BASE_PATH}/a/b/c/${commentHash}.png`,
    xml: `<?xml version="1.0" encoding="UTF-8" ?>
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>测试主帖</title>
  <link>https://linux.do/t/topic/3109398</link>
  <description>主帖正文。&lt;img src=&quot;upload://${mainShort}.webp&quot; alt=&quot;main&quot;&gt; 主帖结尾。</description>
  <lastBuildDate>Wed, 04 Nov 2026 15:01:03 +0000</lastBuildDate>
  <item>
    <title>测试主帖</title>
    <dc:creator><![CDATA[评论者A]]></dc:creator>
    <description><![CDATA[<p>应该被剥离的评论一</p><img src="upload://${commentShort}.png">]]></description>
    <link>https://linux.do/t/topic/3109398/172</link>
  </item>
  <item>
    <title>测试主帖</title>
    <dc:creator><![CDATA[评论者B]]></dc:creator>
    <description><![CDATA[<p>应该被剥离的评论二</p>]]></description>
    <link>https://linux.do/t/topic/3109398/171</link>
  </item>
</channel>
</rss>`,
  };
}

let appLoadCount = 0;

async function loadApp() {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:8799/",
    pretendToBeVisual: true,
  });
  dom.window.Element.prototype.scrollIntoView = () => {};

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.XMLSerializer = dom.window.XMLSerializer;
  globalThis.Blob = dom.window.Blob;
  globalThis.URL = dom.window.URL;

  appLoadCount += 1;
  await import(`../public/app.js?ui-test=${appLoadCount}`);
  return dom;
}

test("default output strips comment items and can include them on demand", async () => {
  const dom = await loadApp();
  const { mainCdn, commentCdn, xml } = makeFeed();
  const document = dom.window.document;

  document.getElementById("pasteInput").value = xml;
  document.getElementById("parsePasteButton").click();

  let feedXml = document.getElementById("feedOutput").value;
  let markdown = document.getElementById("markdownOutput").value;

  assert.match(feedXml, /主帖正文/);
  assert.equal(feedXml.split("<?xml").length - 1, 1);
  assert.ok(feedXml.includes(mainCdn));
  assert.doesNotMatch(feedXml, /<item>/);
  assert.doesNotMatch(feedXml, /应该被剥离/);
  assert.doesNotMatch(feedXml, /upload:\/\//);
  assert.ok(!feedXml.includes(commentCdn));

  assert.match(markdown, /## 主帖/);
  assert.doesNotMatch(markdown, /## 评论/);
  assert.equal(document.getElementById("imageTabCount").textContent, "1");
  assert.equal(
    document.querySelector('input[name="outputScope"][value="main"]').checked,
    true,
  );
  assert.match(document.getElementById("scopeHint").textContent, /2 条评论/);

  const allRadio = document.querySelector(
    'input[name="outputScope"][value="all"]',
  );
  allRadio.checked = true;
  allRadio.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

  feedXml = document.getElementById("feedOutput").value;
  markdown = document.getElementById("markdownOutput").value;

  assert.match(feedXml, /<item>/);
  assert.match(feedXml, /应该被剥离的评论一/);
  assert.match(feedXml, /应该被剥离的评论二/);
  assert.ok(feedXml.includes(commentCdn));
  assert.match(markdown, /## 评论 #1/);
  assert.match(markdown, /## 评论 #2/);
  assert.equal(document.getElementById("imageTabCount").textContent, "2");
  assert.equal(
    document.querySelector('input[name="outputScope"][value="all"]').checked,
    true,
  );

  const parsed = new dom.window.DOMParser().parseFromString(feedXml, "text/xml");
  assert.equal(parsed.getElementsByTagName("parsererror").length, 0);
});

test("client displays the server's real fetch error and attempt details", async () => {
  const dom = await loadApp();
  const document = dom.window.document;
  const errorPayload = {
    error: "UPSTREAM_FETCH_FAILED",
    message:
      "无法从 Linux.do 获取 RSS（direct: HTTP 403；jina-reader: HTTP 429）。请改用粘贴 RSS 模式。",
    attempts: [
      { source: "direct", status: 403, contentType: "text/html" },
      { source: "jina-reader", status: 429, contentType: "application/json" },
    ],
  };

  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify(errorPayload), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  };

  document
    .getElementById("urlForm")
    .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

  for (let i = 0; i < 20; i += 1) {
    if (document.getElementById("errorDetails").hidden === false) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(requestedUrl, "/api/rss?topic=3109398&v=20261105-2");
  assert.match(document.getElementById("status").textContent, /获取失败/);
  assert.match(document.getElementById("status").textContent, /HTTP 403/);
  assert.equal(document.getElementById("errorDetails").hidden, false);
  assert.match(document.getElementById("errorDetails").textContent, /UPSTREAM_FETCH_FAILED/);
  assert.match(document.getElementById("errorDetails").textContent, /jina-reader/);
  assert.match(document.getElementById("errorDetails").textContent, /HTTP 429/);
});
