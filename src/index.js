import { extractTopicId, LINUXDO_ORIGIN } from "../public/core.js";

const UPSTREAM_HEADERS = {
  accept:
    "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "user-agent":
    "Mozilla/5.0 (compatible; linuxdo-rss-cdn/1.0; +https://github.com/lco117/linuxdo-rss-cdn)",
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Accept, Content-Type",
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
  let upstream;
  try {
    upstream = await fetch(rssUrl, {
      headers: UPSTREAM_HEADERS,
      redirect: "follow",
      cf: {
        cacheEverything: true,
        cacheTtl: 300,
      },
    });
  } catch (error) {
    return jsonResponse(
      {
        error: "UPSTREAM_UNREACHABLE",
        message: "无法连接 Linux.do，请稍后重试或改用粘贴 RSS 模式。",
        detail: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }

  if (!upstream.ok) {
    return jsonResponse(
      {
        error: "UPSTREAM_HTTP_ERROR",
        message: `Linux.do 返回 HTTP ${upstream.status}，请稍后重试或改用粘贴 RSS 模式。`,
        upstreamStatus: upstream.status,
        rssUrl,
      },
      502,
    );
  }

  const xml = await upstream.text();
  if (xml.length < 80 || !/<(?:rss|feed)\b/i.test(xml)) {
    return jsonResponse(
      {
        error: "UPSTREAM_NOT_RSS",
        message:
          "Linux.do 返回的内容看起来不是 RSS（可能是登录页或风控页），请改用粘贴 RSS 模式。",
        rssUrl,
      },
      502,
    );
  }

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
      "x-linuxdo-rss-url": rssUrl,
      "x-content-type-options": "nosniff",
      ...CORS_HEADERS,
    },
  });
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
