import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const XML = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Test</title><description>Main post</description></channel></rss>`;
const ENV = { ASSETS: { fetch: () => new Response("asset") } };

test("Worker falls back to Jina Reader when Linux.do returns a Cloudflare challenge", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://linux.do/")) {
      return new Response("<html><title>Just a moment...</title></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    }
    if (String(url).startsWith("https://r.jina.ai/")) {
      return new Response(XML, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/api/rss?topic=3109398"),
      ENV,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fetch-source"), "jina-reader");
    assert.match(await response.text(), /<rss\b/);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /^https:\/\/linux\.do\/t\/topic\/3109398\.rss$/);
    assert.match(calls[1], /^https:\/\/r\.jina\.ai\/https:\/\/linux\.do\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker returns detailed attempts when direct and fallback both fail", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://linux.do/")) {
      return new Response("<html><title>Just a moment...</title></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response('{"error":"rate limited"}', {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/api/rss?topic=3109398"),
      ENV,
    );
    const payload = await response.json();

    assert.equal(response.status, 502);
    assert.equal(payload.error, "UPSTREAM_FETCH_FAILED");
    assert.equal(payload.attempts.length, 2);
    assert.equal(payload.attempts[0].source, "direct");
    assert.equal(payload.attempts[0].status, 403);
    assert.equal(payload.attempts[1].source, "jina-reader");
    assert.equal(payload.attempts[1].status, 429);
    assert.match(payload.attempts[0].preview, /Just a moment/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker does not call the fallback when direct RSS succeeds", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(XML, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/api/rss?topic=3109398"),
      ENV,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fetch-source"), "direct");
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
