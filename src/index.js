import {
  extractTopicId,
  LINUXDO_ORIGIN,
  normalizeRssXmlText,
} from "../public/core.js";

const JINA_READER_ORIGIN = "https://r.jina.ai";
const UPSTREAM_HEADERS = {
  accept:
    "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "user-agent":
    "Mozilla/5.0 (compatible; linuxdo-rss-cdn/1.0; +https://github.com/lco117/linuxdo-rss-cdn)",
};
const JINA_HEADERS = {
  accept: "text/plain",
  "x-return-format": "text",
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Accept, Content-Type",
  "access-control-expose-headers": "x-fetch-source, x-linuxdo-rss-url",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

function textExcerpt(value, limit = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function looksLikeRssXml(value) {
  const text = String(value || "").replace(/^\uFEFF/, "").trimStart();
  return /^(?:<\?xml\b[^>]*>\s*)?<(?:rss|feed)\b/i.test(text);
}

function attemptRecord(source, targetUrl, response, body, error) {
  return {
    source,
    url: targetUrl,
    ok: Boolean(response?.ok && looksLikeRssXml(body)),
    status: response?.status ?? null,
    contentType: response?.headers.get("content-type") || "",
    error: error ? (error instanceof Error ? error.message : String(error)) : "",
    preview: textExcerpt(body),
  };
}

async function requestRss(source, targetUrl, options) {
  let response;
  try {
    response = await fetch(targetUrl, options);
  } catch (error) {
    return {
      response: null,
      body: "",
      attempt: attemptRecord(source, targetUrl, null, "", error),
    };
  }

  const body = normalizeRssXmlText(await response.text());
  return {
    response,
    body,
    attempt: attemptRecord(source, targetUrl, response, body),
  };
}

async function handleRssRequest(request, url) {
  const topic = url.searchParams.get("topic") || url.searchParams.get("id");
  const topicId = extractTopicId(topic);

  if (!topicId) {
    return jsonResponse(
      {
        error: "INVALID_TOPIC",
        message:
          "参数 topic 必须是 Linux.do 主题链接、RSS 链接或纯数字 topic id。",
      },
      400,
    );
  }

  const rssUrl = `${LINUXDO_ORIGIN}/t/topic/${topicId}.rss`;
  const attempts = [];

  const direct = await requestRss("direct", rssUrl, {
    headers: UPSTREAM_HEADERS,
    redirect: "follow",
    cf: {
      cacheEverything: true,
      cacheTtl: 300,
    },
  });
  attempts.push(direct.attempt);

  if (direct.attempt.ok) {
    return new Response(direct.body, {
      status: 200,
      headers: {
        "content-type": "application/rss+xml; charset=utf-8",
        "cache-control": "public, max-age=300, s-maxage=300",
        "x-fetch-source": "direct",
        "x-linuxdo-rss-url": rssUrl,
        "x-content-type-options": "nosniff",
        ...CORS_HEADERS,
      },
    });
  }

  // Linux.do's Cloudflare challenge blocks ordinary Worker egress. Jina Reader
  // runs a browser-side fetch and can return the raw text with this header.
  const jinaUrl = `${JINA_READER_ORIGIN}/${rssUrl}`;
  const fallback = await requestRss("jina-reader", jinaUrl, {
    headers: JINA_HEADERS,
    redirect: "follow",
    cf: {
      cacheEverything: true,
      cacheTtl: 300,
    },
  });
  attempts.push(fallback.attempt);

  if (fallback.attempt.ok) {
    return new Response(fallback.body, {
      status: 200,
      headers: {
        "content-type": "application/rss+xml; charset=utf-8",
        "cache-control": "public, max-age=300, s-maxage=300",
        "x-fetch-source": "jina-reader",
        "x-linuxdo-rss-url": rssUrl,
        "x-content-type-options": "nosniff",
        ...CORS_HEADERS,
      },
    });
  }

  const summary = attempts
    .map((attempt) =>
      attempt.status
        ? `${attempt.source}: HTTP ${attempt.status}`
        : `${attempt.source}: ${attempt.error || "请求失败"}`,
    )
    .join("；");

  return jsonResponse(
    {
      error: "UPSTREAM_FETCH_FAILED",
      message: `无法从 Linux.do 获取 RSS（${summary || "未知错误"}）。请改用粘贴 RSS 模式。`,
      rssUrl,
      attempts,
    },
    502,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/rss" || url.pathname === "/api/rss/") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method !== "GET") {
        return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405);
      }
      return handleRssRequest(request, url);
    }

    if (url.pathname === "/api/health") {
      return jsonResponse({ ok: true, service: "linuxdo-rss-cdn" });
    }

    return env.ASSETS.fetch(request);
  },
};
