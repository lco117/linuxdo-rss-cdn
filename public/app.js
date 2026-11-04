import {
  LINUXDO_ORIGIN,
  decodeUploadUrls,
  extractTopicId,
  normalizeRssXmlText,
  topicToRssUrl,
} from "./core.js";

const elements = {
  urlForm: document.getElementById("urlForm"),
  topicUrl: document.getElementById("topicUrl"),
  rssPreview: document.getElementById("rssPreview"),
  fetchButton: document.getElementById("fetchButton"),
  status: document.getElementById("status"),
  errorDetails: document.getElementById("errorDetails"),
  pasteInput: document.getElementById("pasteInput"),
  parsePasteButton: document.getElementById("parsePasteButton"),
  result: document.getElementById("result"),
  feedTitle: document.getElementById("feedTitle"),
  feedMeta: document.getElementById("feedMeta"),
  resetButton: document.getElementById("resetButton"),
  metrics: document.getElementById("metrics"),
  imageTabCount: document.getElementById("imageTabCount"),
  feedOutput: document.getElementById("feedOutput"),
  markdownOutput: document.getElementById("markdownOutput"),
  feedOutputHint: document.getElementById("feedOutputHint"),
  markdownOutputHint: document.getElementById("markdownOutputHint"),
  scopeHint: document.getElementById("scopeHint"),
  imageGrid: document.getElementById("imageGrid"),
  previewList: document.getElementById("previewList"),
  copyFeedButton: document.getElementById("copyFeedButton"),
  downloadFeedButton: document.getElementById("downloadFeedButton"),
  copyMarkdownButton: document.getElementById("copyMarkdownButton"),
  downloadMarkdownButton: document.getElementById("downloadMarkdownButton"),
  copyAllImagesButton: document.getElementById("copyAllImagesButton"),
  toast: document.getElementById("toast"),
};

const state = {
  topicId: "",
  rssUrl: "",
  sourceLabel: "",
  feed: null,
  decoded: null,
  mappings: [],
  markdown: "",
  feedXml: "",
  rawXml: "",
  totalComments: 0,
  scope: "main",
};

let toastTimer = 0;

function clearErrorDetails() {
  if (!elements.errorDetails) return;
  elements.errorDetails.textContent = "";
  elements.errorDetails.hidden = true;
}

function textExcerpt(value, limit = 800) {
  return String(value || "")
    .trim()
    .slice(0, limit);
}

function detailText(detail) {
  if (!detail) return "";
  return typeof detail === "string"
    ? detail
    : JSON.stringify(detail, null, 2);
}

function showError(prefix, error) {
  const message = error?.message || String(error);
  setStatus(`${prefix}：${message}`, "error");
  const detail = detailText(error?.detail);
  if (elements.errorDetails && detail) {
    elements.errorDetails.textContent = detail;
    elements.errorDetails.hidden = false;
  }
  showToast(message, true);
}

function setStatus(message, type = "info") {
  elements.status.textContent = message;
  elements.status.className = "status";
  if (type === "error") elements.status.classList.add("is-error");
  if (type === "success") elements.status.classList.add("is-success");
  if (type === "warning") elements.status.classList.add("is-warning");
  if (type !== "error") clearErrorDetails();
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 2200);
}

function setLoading(isLoading) {
  elements.fetchButton.disabled = isLoading;
  elements.fetchButton.classList.toggle("is-loading", isLoading);
}

function updateRssPreview() {
  const value = elements.topicUrl.value.trim();
  try {
    elements.rssPreview.textContent = `RSS: ${topicToRssUrl(value)}`;
    elements.rssPreview.classList.remove("is-error");
  } catch {
    elements.rssPreview.textContent = "尚未识别出有效的 Linux.do topic id";
  }
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(date);
}

function formatGeneratedAt() {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date());
}

function absoluteUrl(value) {
  if (!value) return "";
  try {
    return new URL(value, LINUXDO_ORIGIN).href;
  } catch {
    return value;
  }
}

async function fetchRssThroughWorker(input) {
  const requestUrl = `/api/rss?topic=${encodeURIComponent(input)}`;
  let response;
  try {
    response = await fetch(requestUrl, {
      headers: {
        accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
      },
      cache: "no-store",
    });
  } catch (error) {
    const wrapped = new Error(`请求 Worker 失败：${error.message || error}`);
    wrapped.detail = { requestUrl, error: String(error) };
    throw wrapped;
  }

  const contentType = response.headers.get("content-type") || "";
  const source = response.headers.get("x-fetch-source") || "";
  const body = await response.text();
  const trimmed = body.trimStart();
  const lower = trimmed.slice(0, 200).toLowerCase();
  const looksXml =
    lower.startsWith("<?xml") ||
    lower.startsWith("<rss") ||
    lower.startsWith("<feed");

  if (!response.ok) {
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      // Keep the raw response below when the server did not return JSON.
    }

    const message =
      payload?.message || `Worker 请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.detail = {
      requestUrl,
      status: response.status,
      contentType,
      source,
      responsePreview: textExcerpt(body, 1600),
      payload,
    };
    throw error;
  }

  if (!looksXml) {
    const htmlHint = lower.startsWith("<!doctype html") || lower.startsWith("<html");
    const error = new Error(
      htmlHint
        ? "Worker 返回了 HTML 页面而不是 RSS XML，可能命中了错误页面或风控页。"
        : "Worker 返回的内容不是 RSS XML。",
    );
    error.detail = {
      requestUrl,
      status: response.status,
      contentType,
      source,
      responsePreview: textExcerpt(body, 1600),
    };
    throw error;
  }

  return {
    xml: body,
    source,
    sourceLabel:
      source === "jina-reader"
        ? "Jina Reader 备用抓取"
        : source === "browser-rendering"
          ? "Cloudflare Browser Rendering"
          : source === "direct"
            ? "Worker 直连 Linux.do"
            : "Worker 代理",
  };
}

function uniqueMappings(entries) {
  const mapping = new Map();
  for (const entry of entries) {
    if (!mapping.has(entry.original)) mapping.set(entry.original, entry.cdn);
  }
  return [...mapping.entries()].map(([original, cdn]) => ({ original, cdn }));
}

function summaryStatus(summary, prefix) {
  const scopeText =
    summary.scope === "main"
      ? `仅主帖（已剥离 ${summary.removedComments} 条评论）`
      : `主帖 + ${summary.keptComments} 条评论`;
  const unresolvedNote = summary.unresolved
    ? ` 另有 ${summary.unresolved} 个 upload:// 无法解析，已保持原样。`
    : "";
  const source = summary.sourceLabel ? `数据源：${summary.sourceLabel}；` : "";
  return `${prefix}：${source}${scopeText}，${summary.mappingCount} 个图片直链，替换 ${summary.replacements} 处。${unresolvedNote}`;
}

async function handleFetch(event) {
  event.preventDefault();
  clearErrorDetails();
  const input = elements.topicUrl.value.trim();

  let rssUrl;
  try {
    rssUrl = topicToRssUrl(input);
  } catch (error) {
    showError("链接无效", error);
    return;
  }

  setLoading(true);
  setStatus(`正在通过 Worker 获取 ${rssUrl} …`);

  try {
    const result = await fetchRssThroughWorker(input);
    const summary = renderFeed(result.xml, {
      rssUrl,
      sourceLabel: result.sourceLabel,
    });
    setStatus(
      summaryStatus(summary, "完成"),
      summary.unresolved ? "warning" : "success",
    );
    elements.result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    error.message = `${error.message}。可以展开下方「直接粘贴 RSS 原文」继续处理。`;
    showError("获取失败", error);
  } finally {
    setLoading(false);
  }
}

function handlePaste() {
  clearErrorDetails();
  const xmlText = elements.pasteInput.value.trim();
  if (!xmlText) {
    setStatus("粘贴框为空，请先粘贴 RSS XML。", "error");
    return;
  }

  let rssUrl = "";
  try {
    rssUrl = topicToRssUrl(elements.topicUrl.value.trim());
  } catch {
    // A pasted feed is still useful without a known source URL.
  }

  try {
    const summary = renderFeed(xmlText, {
      rssUrl,
      sourceLabel: "粘贴内容",
    });
    setStatus(
      summaryStatus(summary, "解析完成"),
      summary.unresolved ? "warning" : "success",
    );
    elements.result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showError("解析失败", error);
  }
}

function directChildren(parent, localName) {
  const wanted = localName.toLowerCase();
  return [...parent.children].filter(
    (child) => child.localName.toLowerCase() === wanted,
  );
}

function firstDirectChild(parent, localName) {
  return directChildren(parent, localName)[0] || null;
}

function childText(parent, localName) {
  const child = firstDirectChild(parent, localName);
  return child ? child.textContent.trim() : "";
}

function extractLink(parent) {
  const link = firstDirectChild(parent, "link");
  if (link) {
    const href = link.getAttribute("href");
    if (href) return absoluteUrl(href);
    const text = link.textContent.trim();
    if (text) return absoluteUrl(text);
  }

  for (const candidate of directChildren(parent, "link")) {
    const href = candidate.getAttribute("href");
    if (href) return absoluteUrl(href);
  }
  return "";
}

function extractAuthor(parent) {
  for (const child of parent.children) {
    const name = child.localName.toLowerCase();
    if (name !== "creator" && name !== "author") continue;

    const nestedName = firstDirectChild(child, "name");
    const value = nestedName ? nestedName.textContent.trim() : child.textContent.trim();
    if (value) return value;
  }
  return "";
}

function extractContent(parent) {
  for (const name of ["encoded", "content", "description"]) {
    for (const child of directChildren(parent, name)) {
      const value = child.textContent.trim();
      if (value) return value;
    }
  }
  return "";
}

function extractDate(parent) {
  for (const name of ["pubDate", "published", "updated", "date"]) {
    const value = childText(parent, name);
    if (value) return value;
  }
  return "";
}

function extractCategories(parent) {
  return directChildren(parent, "category")
    .map((category) => category.getAttribute("term") || category.textContent.trim())
    .filter(Boolean);
}

function parseItem(itemNode, index, isAtom) {
  const title =
    childText(itemNode, "title") ||
    (isAtom ? `条目 #${index + 1}` : `回复 #${index + 1}`);
  const link = extractLink(itemNode);
  const author = extractAuthor(itemNode);
  const date = extractDate(itemNode);
  const content = extractContent(itemNode);
  const id = childText(itemNode, "guid") || childText(itemNode, "id");
  const categories = extractCategories(itemNode);

  return {
    index: index + 1,
    title,
    link,
    author,
    date,
    content,
    id,
    categories,
  };
}

function parseXmlDocument(xmlText, message = "XML 解析失败，请确认内容完整") {
  const doc = new DOMParser().parseFromString(String(xmlText || ""), "text/xml");
  const parserErrors = doc.getElementsByTagName("parsererror");
  if (parserErrors.length > 0 || doc.documentElement?.localName === "parsererror") {
    const parserError = [...parserErrors]
      .map((node) => node.textContent || "")
      .join(" ")
      .trim();
    const error = new Error(message);
    error.detail = {
      parserError: textExcerpt(parserError, 1200) || "浏览器没有提供具体 parsererror。",
      responsePreview: textExcerpt(xmlText, 1600),
    };
    throw error;
  }
  return doc;
}

function feedDocumentParts(doc) {
  const root = doc.documentElement;
  if (!root) throw new Error("XML 没有根节点");

  const rootName = root.localName.toLowerCase();
  const isAtom = rootName === "feed";
  if (rootName !== "rss" && !isAtom) {
    throw new Error(`不是可识别的 RSS/Atom 文档（根节点：${rootName}）`);
  }

  return {
    root,
    isAtom,
    container: isAtom ? root : firstDirectChild(root, "channel") || root,
  };
}

function commentNodesFromDocument(doc) {
  const { root, isAtom, container } = feedDocumentParts(doc);
  return isAtom ? directChildren(root, "entry") : directChildren(container, "item");
}

function countCommentItems(xmlText) {
  try {
    return commentNodesFromDocument(parseXmlDocument(xmlText)).length;
  } catch {
    return 0;
  }
}

/**
 * Remove top-level RSS <item> / Atom <entry> nodes and keep the channel-level
 * main-post description. Serialization changes whitespace but not meaning.
 */
function stripCommentItems(xmlText) {
  const doc = parseXmlDocument(xmlText);
  const nodes = commentNodesFromDocument(doc);
  if (nodes.length === 0) return { xml: xmlText, removed: 0 };

  for (const node of nodes) node.remove();

  const declaration =
    String(xmlText).match(/^\s*<\?xml[^?]*\?>/)?.[0] ||
    '<?xml version="1.0" encoding="UTF-8"?>';
  const serialized = new XMLSerializer().serializeToString(doc);
  return { xml: `${declaration}\n${serialized}`, removed: nodes.length };
}

function parseFeed(doc, rssUrl, sourceLabel) {
  const { isAtom, container } = feedDocumentParts(doc);
  const itemNodes = isAtom
    ? directChildren(container, "entry")
    : directChildren(container, "item");

  const feedTitle = childText(container, "title") || "Linux.do Topic";
  const feedLink = extractLink(container);
  const feedDescription = extractContent(container);
  if (!feedDescription && itemNodes.length === 0) {
    throw new Error("RSS 中没有找到主帖正文或 item/entry 节点");
  }

  const items = itemNodes.map((node, index) => parseItem(node, index, isAtom));

  return {
    title: feedTitle,
    link: feedLink,
    description: feedDescription,
    updatedAt: childText(container, "lastBuildDate"),
    items,
    rssUrl,
    sourceLabel,
    generatedAt: formatGeneratedAt(),
  };
}

function syncScopeRadios(scope) {
  for (const input of document.querySelectorAll('input[name="outputScope"]')) {
    input.checked = input.value === scope;
  }
}

function scopeLabel(scope) {
  return scope === "all" ? "主帖 + 评论" : "仅主帖";
}

function applyScope(scope, options = {}) {
  if (!state.rawXml) throw new Error("还没有可处理的 RSS 内容");

  const effectiveScope = scope === "all" ? "all" : "main";
  const scoped =
    effectiveScope === "all"
      ? { xml: state.rawXml, removed: 0 }
      : stripCommentItems(state.rawXml);

  const decoded = decodeUploadUrls(scoped.xml);
  const doc = parseXmlDocument(decoded.output);
  const feed = parseFeed(doc, state.rssUrl, state.sourceLabel);
  const mappings = uniqueMappings(decoded.entries);
  const markdown = buildMarkdown(feed, mappings, {
    scope: effectiveScope,
    totalComments: state.totalComments,
    removedComments: effectiveScope === "main" ? scoped.removed : 0,
  });

  state.scope = effectiveScope;
  state.feed = feed;
  state.decoded = decoded;
  state.mappings = mappings;
  state.markdown = markdown;
  state.feedXml = decoded.output;

  const keptComments = effectiveScope === "all" ? feed.items.length : 0;
  const removedComments =
    effectiveScope === "main" ? Math.max(state.totalComments, scoped.removed) : 0;
  const rangeText = scopeLabel(effectiveScope);

  elements.result.hidden = false;
  elements.feedTitle.textContent = feed.title;
  elements.feedMeta.textContent = [
    feed.sourceLabel,
    feed.rssUrl,
    rangeText,
    `保留评论 ${keptComments}/${state.totalComments}`,
    `生成于 ${feed.generatedAt}`,
  ]
    .filter(Boolean)
    .join(" · ");
  elements.feedOutput.value = decoded.output;
  elements.markdownOutput.value = markdown;
  elements.imageTabCount.textContent = String(mappings.length);
  elements.feedOutputHint.textContent =
    effectiveScope === "main"
      ? `保留主帖 description，已移除 ${removedComments} 条评论 item。`
      : `保留主帖和 ${keptComments} 条评论 item。`;
  elements.markdownOutputHint.textContent =
    effectiveScope === "main"
      ? `仅导出主帖正文；RSS 中的 ${removedComments} 条评论已剥离。`
      : `导出主帖正文和 ${keptComments} 条评论。`;
  elements.scopeHint.textContent = state.totalComments
    ? `RSS 中含 ${state.totalComments} 条评论。默认仅主帖，切到右侧可一并保留。`
    : "这个 RSS 没有评论 item，输出主帖内容。";
  syncScopeRadios(effectiveScope);

  renderMetrics(feed, decoded, mappings, effectiveScope, keptComments);
  renderImageGrid(mappings);
  renderPreview(feed, effectiveScope);
  if (options.activateFeedTab) activateTab("feed");
  if (options.scroll) elements.result.scrollIntoView({ behavior: "smooth", block: "start" });

  return {
    scope: effectiveScope,
    sourceLabel: state.sourceLabel,
    itemCount: feed.items.length,
    keptComments,
    totalComments: state.totalComments,
    removedComments,
    mappingCount: mappings.length,
    replacements: decoded.replacements,
    unresolved: decoded.unresolved,
  };
}

function renderFeed(xmlText, options = {}) {
  if (!xmlText || typeof xmlText !== "string") {
    throw new Error("没有收到 RSS 内容");
  }

  state.rawXml = normalizeRssXmlText(xmlText);
  state.topicId = extractTopicId(options.rssUrl || elements.topicUrl.value) || "";
  state.rssUrl = options.rssUrl || "";
  state.sourceLabel = options.sourceLabel || "";
  state.totalComments = countCommentItems(state.rawXml);
  document.title = "Linux.do Topic → RSS → CDN 直链";

  const summary = applyScope("main", { activateFeedTab: true });
  document.title = `${state.feed.title} · Linux.do RSS`;
  return summary;
}

function renderMetrics(feed, decoded, mappings, scope, keptComments) {
  const metrics = [
    { value: scopeLabel(scope), label: "当前输出范围", compact: true },
    { value: `${keptComments}/${state.totalComments}`, label: "保留评论" },
    { value: mappings.length, label: "唯一图片直链" },
    { value: decoded.replacements, label: "upload:// 替换次数" },
  ];

  const nodes = metrics.map((metric) => {
    const card = document.createElement("div");
    card.className = "metric";

    const value = document.createElement("span");
    value.className = `metric-value${metric.compact ? " metric-value-text" : ""}`;
    value.textContent = String(metric.value);

    const label = document.createElement("span");
    label.className = "metric-label";
    label.textContent = metric.label;

    card.append(value, label);
    return card;
  });

  elements.metrics.replaceChildren(...nodes);
}
function renderImageGrid(mappings) {
  if (mappings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "没有找到可解码的 upload:// 图片短链。";
    elements.imageGrid.replaceChildren(empty);
    return;
  }

  const cards = mappings.map(({ original, cdn }) => {
    const card = document.createElement("article");
    card.className = "image-card";

    const frame = document.createElement("a");
    frame.className = "image-frame";
    frame.href = cdn;
    frame.target = "_blank";
    frame.rel = "noopener noreferrer";

    const image = document.createElement("img");
    image.src = cdn;
    image.alt = "Linux.do 图片";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    frame.appendChild(image);

    const info = document.createElement("div");
    info.className = "image-info";

    const originalLabel = document.createElement("span");
    originalLabel.className = "image-label";
    originalLabel.textContent = "Upload short URL";

    const originalCode = document.createElement("code");
    originalCode.className = "image-original";
    originalCode.textContent = original;

    const linkLabel = document.createElement("span");
    linkLabel.className = "image-label";
    linkLabel.textContent = "CDN direct URL";

    const link = document.createElement("a");
    link.className = "image-link";
    link.href = cdn;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = cdn;

    const copyButton = document.createElement("button");
    copyButton.className = "button secondary";
    copyButton.type = "button";
    copyButton.textContent = "复制直链";
    copyButton.addEventListener("click", async () => {
      try {
        await copyText(cdn);
        showToast("已复制 CDN 直链");
      } catch (error) {
        showToast(error.message, true);
      }
    });

    info.append(originalLabel, originalCode, linkLabel, link, copyButton);
    card.append(frame, info);
    return card;
  });

  elements.imageGrid.replaceChildren(...cards);
}

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  doc
    .querySelectorAll(
      "script,style,iframe,object,embed,form,input,button,textarea,select,option,link,meta,base,svg,math,template,noscript",
    )
    .forEach((node) => node.remove());

  for (const element of doc.body.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();

      if (name.startsWith("on") || name === "srcdoc" || name === "style") {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "srcset") {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (
        ["href", "src", "xlink:href", "action", "formaction", "poster"].includes(name)
      ) {
        if (/^(?:javascript|vbscript|data:text\/html)/i.test(value)) {
          element.removeAttribute(attribute.name);
          continue;
        }

        if (value && !value.startsWith("#")) {
          try {
            element.setAttribute(attribute.name, new URL(value, LINUXDO_ORIGIN).href);
          } catch {
            element.removeAttribute(attribute.name);
          }
        }
      }
    }

    if (element.tagName === "A") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }

    if (element.tagName === "IMG") {
      element.loading = "lazy";
      element.referrerPolicy = "no-referrer";
    }
  }

  return doc.body.innerHTML;
}

function appendPreviewMeta(parent, item) {
  const meta = document.createElement("div");
  meta.className = "preview-meta";

  const number = document.createElement("span");
  number.textContent = `#${item.index}`;
  meta.appendChild(number);

  if (item.author) {
    const author = document.createElement("span");
    author.textContent = `作者：${item.author}`;
    meta.appendChild(author);
  }

  if (item.date) {
    const date = document.createElement("span");
    date.textContent = formatDate(item.date);
    meta.appendChild(date);
  }

  if (item.link) {
    const link = document.createElement("a");
    link.href = absoluteUrl(item.link);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "打开原帖";
    meta.appendChild(link);
  }

  if (item.categories.length > 0) {
    const categories = document.createElement("span");
    categories.textContent = `标签：${item.categories.join(" / ")}`;
    meta.appendChild(categories);
  }

  parent.appendChild(meta);
}

function renderPreview(feed, scope) {
  const cards = [];

  if (feed.description) {
    const intro = document.createElement("article");
    intro.className = "preview-card";
    const header = document.createElement("header");
    const title = document.createElement("h3");
    title.textContent = scope === "all" ? "主帖" : "主帖（评论已剥离）";
    header.appendChild(title);
    intro.appendChild(header);

    const content = document.createElement("div");
    content.className = "preview-content";
    content.innerHTML = sanitizeHtml(feed.description);
    intro.appendChild(content);
    cards.push(intro);
  }

  for (const item of feed.items) {
    const card = document.createElement("article");
    card.className = "preview-card";

    const header = document.createElement("header");
    const title = document.createElement("h3");
    title.textContent = `评论 #${item.index}`;
    header.appendChild(title);
    appendPreviewMeta(header, item);
    card.appendChild(header);

    const content = document.createElement("div");
    content.className = "preview-content";
    if (item.content) {
      content.innerHTML = sanitizeHtml(item.content);
    } else {
      const empty = document.createElement("em");
      empty.textContent = "（这条内容没有正文）";
      content.appendChild(empty);
    }
    card.appendChild(content);
    cards.push(card);
  }

  elements.previewList.replaceChildren(...cards);
}

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "dt",
  "dd",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const BACKSLASH = String.fromCharCode(92);

function escapeMarkdownText(value) {
  return String(value)
    .replaceAll(BACKSLASH, BACKSLASH + BACKSLASH)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("*", BACKSLASH + "*")
    .replaceAll("_", BACKSLASH + "_")
    .replaceAll("[", BACKSLASH + "[")
    .replaceAll("]", BACKSLASH + "]")
    .replace(/`/g, BACKSLASH + "`");
}

function imageMarkdown(element) {
  const src = absoluteUrl(element.getAttribute("src") || "");
  if (!src) return "";
  const alt = (element.getAttribute("alt") || "图片")
    .replace(/\[/g, "")
    .replace(/\]/g, "")
    .replace(/\n/g, " ")
    .trim();
  return `![${alt}](${src})`;
}

function renderInlineChildren(node) {
  return [...node.childNodes].map(renderInlineNode).join("");
}

function renderInlineNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeMarkdownText(node.nodeValue.replace(/\s+/g, " "));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toLowerCase();
  switch (tag) {
    case "br":
      return "  \n";
    case "img":
      return imageMarkdown(node);
    case "a": {
      const text = renderInlineChildren(node).trim();
      const href = absoluteUrl(node.getAttribute("href") || "");
      if (!href || href.startsWith("#")) return text;
      return `[${text || href}](${href})`;
    }
    case "strong":
    case "b": {
      const text = renderInlineChildren(node).trim();
      return text ? `**${text}**` : "";
    }
    case "em":
    case "i": {
      const text = renderInlineChildren(node).trim();
      return text ? `*${text}*` : "";
    }
    case "del":
    case "s": {
      const text = renderInlineChildren(node).trim();
      return text ? `~~${text}~~` : "";
    }
    case "code": {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      const fence = text.includes("`") ? "``" : "`";
      return `${fence}${text}${fence}`;
    }
    case "kbd": {
      const text = node.textContent.trim();
      return text ? `\`${text}\`` : "";
    }
    case "video":
    case "audio": {
      const source = node.querySelector("source[src]");
      const url = absoluteUrl(
        node.getAttribute("src") || source?.getAttribute("src") || "",
      );
      return url ? `[媒体文件](${url})` : "";
    }
    default:
      return renderInlineChildren(node);
  }
}

function renderListItemContent(item, depth) {
  let body = "";
  let nested = "";

  for (const child of item.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (tag === "ul" || tag === "ol") {
        nested += renderBlockElement(child, depth + 1);
        continue;
      }
      if (BLOCK_TAGS.has(tag)) {
        body += renderBlockElement(child, depth + 1);
        continue;
      }
    }
    body += renderInlineNode(child);
  }

  const cleanBody = body.replace(/\n{3,}/g, "\n\n").trim();
  const cleanNested = nested.trimEnd();
  return cleanNested ? `${cleanBody}\n${cleanNested}` : cleanBody;
}

function renderTable(table) {
  const rows = [...table.querySelectorAll("tr")];
  if (rows.length === 0) return renderInlineChildren(table);

  const grid = rows.map((row) =>
    [...row.querySelectorAll("th,td")].map((cell) =>
      renderInlineChildren(cell).replace(/\|/g, BACKSLASH + "|").trim(),
    ),
  );
  const width = Math.max(...grid.map((row) => row.length), 1);
  const normalized = grid.map((row) => {
    const copy = [...row];
    while (copy.length < width) copy.push("");
    return copy;
  });
  const [head, ...body] = normalized;
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ];
  return `\n\n${lines.join("\n")}\n\n`;
}

function renderBlockElement(element, depth = 0) {
  const tag = element.tagName.toLowerCase();

  if (tag === "p") {
    return `\n\n${renderInlineChildren(element).trim()}\n\n`;
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    return `\n\n${"#".repeat(level)} ${renderInlineChildren(element).trim()}\n\n`;
  }

  if (tag === "ul" || tag === "ol") {
    const ordered = tag === "ol";
    const items = [...element.children].filter(
      (child) => child.tagName.toLowerCase() === "li",
    );
    const lines = items.map((item, index) => {
      const prefix = ordered ? `${index + 1}. ` : "- ";
      return `${"  ".repeat(depth)}${prefix}${renderListItemContent(item, depth)}`;
    });
    return `\n\n${lines.join("\n")}\n\n`;
  }

  if (tag === "blockquote") {
    const inner = renderBlocks(element, depth).trim();
    if (!inner) return "";
    const quoted = inner
      .split("\n")
      .map((line) => (line.trim() ? `> ${line}` : ">"))
      .join("\n");
    return `\n\n${quoted}\n\n`;
  }

  if (tag === "pre") {
    const code = element.textContent.replace(/\n$/, "");
    const codeElement = element.querySelector("code");
    const languageMatch = codeElement?.className.match(/language-([\w-]+)/);
    const fenceLength = Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1));
    const fence = "`".repeat(fenceLength);
    return `\n\n${fence}${languageMatch ? languageMatch[1] : ""}\n${code}\n${fence}\n\n`;
  }

  if (tag === "hr") return "\n\n---\n\n";
  if (tag === "img") return `\n\n${imageMarkdown(element)}\n\n`;
  if (tag === "br") return "\n";

  if (tag === "table") return renderTable(element);

  if (tag === "figure") {
    const image = element.querySelector("img");
    const caption = element.querySelector("figcaption");
    const pieces = [];
    if (image) pieces.push(imageMarkdown(image));
    if (caption) pieces.push(renderInlineChildren(caption).trim());
    return pieces.length ? `\n\n${pieces.join("\n\n")}\n\n` : "";
  }

  if (tag === "figcaption") {
    const text = renderInlineChildren(element).trim();
    return text ? `\n\n*${text}*\n\n` : "";
  }

  if (tag === "dt") {
    const text = renderInlineChildren(element).trim();
    return text ? `\n\n**${text}**\n` : "";
  }

  if (tag === "dd") {
    const text = renderInlineChildren(element).trim();
    return text ? `${text}\n\n` : "";
  }

  if (tag === "li") {
    return `${"  ".repeat(depth)}- ${renderListItemContent(element, depth)}\n`;
  }

  const hasBlockChildren = [...element.children].some((child) =>
    BLOCK_TAGS.has(child.tagName.toLowerCase()),
  );

  if (hasBlockChildren) return renderBlocks(element, depth);

  const inline = renderInlineChildren(element).trim();
  return inline ? `\n\n${inline}\n\n` : "";
}

function renderBlocks(parent, depth = 0) {
  let output = "";

  for (const child of parent.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.nodeValue.replace(/\s+/g, " ");
      if (text.trim()) output += escapeMarkdownText(text);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName.toLowerCase();
    if (tag === "br") {
      output += "\n";
    } else if (BLOCK_TAGS.has(tag)) {
      output += renderBlockElement(child, depth);
    } else {
      output += renderInlineNode(child);
    }
  }

  return output;
}

function normalizeMarkdown(markdown) {
  return `${String(markdown)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

function htmlToMarkdown(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  doc
    .querySelectorAll("script,style,template,noscript")
    .forEach((element) => element.remove());
  return normalizeMarkdown(renderBlocks(doc.body));
}

function buildMarkdown(feed, mappings, options = {}) {
  const scope = options.scope === "all" ? "all" : "main";
  const removedComments = options.removedComments || 0;
  const lines = [`# ${feed.title}`];
  const meta = [];

  if (feed.link) meta.push(`- 原帖：${feed.link}`);
  if (feed.rssUrl) meta.push(`- RSS：${feed.rssUrl}`);
  meta.push(
    scope === "main"
      ? `- 输出范围：仅主帖（已移除 ${removedComments} 条评论）`
      : `- 输出范围：主帖 + ${feed.items.length} 条评论`,
  );
  if (feed.updatedAt) meta.push(`- RSS 更新时间：${feed.updatedAt}`);
  meta.push(`- 生成时间：${feed.generatedAt}`);
  meta.push(`- 图片直链：${mappings.length}`);
  lines.push("", ...meta);

  if (feed.description) {
    const description = htmlToMarkdown(feed.description).trim();
    if (description) lines.push("", "## 主帖", "", description);
  }

  for (const item of feed.items) {
    lines.push("", "---", "", `## 评论 #${item.index}`);

    const itemMeta = [];
    if (item.author) itemMeta.push(`- 作者：${item.author}`);
    if (item.date) itemMeta.push(`- 时间：${item.date}`);
    if (item.link) itemMeta.push(`- 原帖：${item.link}`);
    if (item.categories.length > 0) {
      itemMeta.push(`- 标签：${item.categories.join(" / ")}`);
    }
    if (itemMeta.length > 0) lines.push("", ...itemMeta);

    const content = htmlToMarkdown(item.content).trim();
    if (content) lines.push("", content);
  }

  return normalizeMarkdown(lines.join("\n"));
}
function safeFilenamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function outputBaseName() {
  const topic = safeFilenamePart(state.topicId);
  return topic ? `linuxdo-${topic}` : "linuxdo-feed";
}

async function copyText(text) {
  if (!text) throw new Error("没有可复制的内容");

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.left = "-9999px";
  document.body.appendChild(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();

  if (!copied) throw new Error("浏览器拒绝了复制操作");
}

function downloadText(text, filename, mimeType) {
  if (!text) throw new Error("没有可下载的内容");
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyWithFeedback(button, text) {
  const originalLabel = button.textContent;
  try {
    await copyText(text);
    button.textContent = "已复制";
    showToast("已复制到剪贴板");
    window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 1400);
  } catch (error) {
    showToast(error.message, true);
  }
}

function activateTab(name) {
  for (const tab of document.querySelectorAll("[data-tab]")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }

  for (const panel of document.querySelectorAll(".tab-panel")) {
    const active = panel.id === `panel-${name}`;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }
}

function resetResult() {
  clearErrorDetails();
  state.topicId = "";
  state.rssUrl = "";
  state.sourceLabel = "";
  state.feed = null;
  state.decoded = null;
  state.mappings = [];
  state.markdown = "";
  state.feedXml = "";
  state.rawXml = "";
  state.totalComments = 0;
  state.scope = "main";
  elements.result.hidden = true;
  elements.feedTitle.textContent = "处理结果";
  elements.feedMeta.textContent = "";
  elements.feedOutput.value = "";
  elements.markdownOutput.value = "";
  elements.imageGrid.replaceChildren();
  elements.previewList.replaceChildren();
  elements.metrics.replaceChildren();
  elements.imageTabCount.textContent = "0";
  elements.feedOutputHint.textContent = "只替换 upload:// 短链，并默认移除评论 item。";
  elements.markdownOutputHint.textContent = "包含主题信息、主帖正文、作者、时间与原帖链接。";
  elements.scopeHint.textContent = "默认只保留主帖，自动移除 RSS item 中的评论。";
  syncScopeRadios("main");
  document.title = "Linux.do Topic → RSS → CDN 直链";
  setStatus("已清空结果。");
  elements.topicUrl.focus();
}

elements.urlForm.addEventListener("submit", handleFetch);
elements.topicUrl.addEventListener("input", updateRssPreview);
elements.parsePasteButton.addEventListener("click", handlePaste);
elements.resetButton.addEventListener("click", resetResult);

for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
}

for (const input of document.querySelectorAll('input[name="outputScope"]')) {
  input.addEventListener("change", () => {
    if (!input.checked || !state.rawXml) return;
    try {
      const summary = applyScope(input.value);
      setStatus(
        summaryStatus(summary, "已切换输出范围"),
        summary.unresolved ? "warning" : "success",
      );
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

elements.copyFeedButton.addEventListener("click", () =>
  copyWithFeedback(elements.copyFeedButton, state.feedXml),
);
elements.downloadFeedButton.addEventListener("click", () => {
  try {
    downloadText(
      state.feedXml,
      `${outputBaseName()}-feed.xml`,
      "application/rss+xml;charset=utf-8",
    );
    showToast("已下载 feed.xml");
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.copyMarkdownButton.addEventListener("click", () =>
  copyWithFeedback(elements.copyMarkdownButton, state.markdown),
);
elements.downloadMarkdownButton.addEventListener("click", () => {
  try {
    downloadText(
      state.markdown,
      `${outputBaseName()}.md`,
      "text/markdown;charset=utf-8",
    );
    showToast("已下载 Markdown");
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.copyAllImagesButton.addEventListener("click", () =>
  copyWithFeedback(
    elements.copyAllImagesButton,
    state.mappings.map((mapping) => mapping.cdn).join("\n"),
  ),
);

updateRssPreview();
