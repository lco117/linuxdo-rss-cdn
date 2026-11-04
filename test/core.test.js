import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE62_ALPHABET,
  CDN_BASE_PATH,
  decodeBase62ToHex,
  decodeUploadUrls,
  extractTopicId,
  topicToRssUrl,
  uploadToCdn,
} from "../public/core.js";

function encodeBase62(hex) {
  let value = BigInt(`0x${hex}`);
  if (value === 0n) return "0";

  let output = "";
  while (value > 0n) {
    const digit = Number(value % 62n);
    output = BASE62_ALPHABET[digit] + output;
    value /= 62n;
  }
  return output;
}

test("decodeBase62ToHex uses Discourse's alphabet order and zero padding", () => {
  assert.equal(decodeBase62ToHex("0"), "0".repeat(40));
  assert.equal(decodeBase62ToHex("10"), (62).toString(16).padStart(40, "0"));
  assert.equal(decodeBase62ToHex("Z"), (61).toString(16).padStart(40, "0"));
  assert.throws(() => decodeBase62ToHex("!"), /Invalid Base62/);
});

test("uploadToCdn maps a Base62 upload id to the 4X SHA-1 CDN path", () => {
  const hash = "0123456789abcdef0123456789abcdef01234567";
  const encoded = encodeBase62(hash);
  const shortUrl = `upload://${encoded}.webp`;

  assert.equal(decodeBase62ToHex(encoded), hash);
  assert.equal(
    uploadToCdn(shortUrl),
    `${CDN_BASE_PATH}/0/1/2/${hash}.webp`,
  );
});

test("uploadToCdn refuses malformed or oversized upload ids", () => {
  assert.equal(uploadToCdn("upload://not base62.png"), null);
  assert.equal(uploadToCdn("upload://abc"), null);
  assert.equal(uploadToCdn(`upload://${"z".repeat(40)}.png`), null);
});

test("decodeUploadUrls replaces every valid token and preserves everything else", () => {
  const hash = "abcdef0123456789abcdef0123456789abcdef01";
  const encoded = encodeBase62(hash);
  const cdn = `${CDN_BASE_PATH}/a/b/c/${hash}.png`;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<rss><channel><item><description><![CDATA[",
    `<p><img src="upload://${encoded}.png"></p>`,
    `<p><a href="upload://${encoded}.png">same image</a></p>`,
    '<p><img src="https://cdn3.ldstatic.com/original/4X/f/i/x/fixed.png"></p>',
    "]]></description></item></channel></rss>",
  ].join("");

  const result = decodeUploadUrls(xml);

  assert.equal(result.replacements, 2);
  assert.equal(result.unresolved, 0);
  assert.equal(result.entries.length, 2);
  assert.equal(result.output.split(cdn).length - 1, 2);
  assert.match(result.output, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(
    result.output,
    /https:\/\/cdn3\.ldstatic\.com\/original\/4X\/f\/i\/x\/fixed\.png/,
  );
});

test("decodeUploadUrls reports upload tokens that cannot be decoded", () => {
  const result = decodeUploadUrls(
    "<p>upload://not!base62.png and upload://also-bad.jpg</p>",
  );
  assert.equal(result.replacements, 0);
  assert.equal(result.unresolved, 2);
  assert.equal(result.output, "<p>upload://not!base62.png and upload://also-bad.jpg</p>");
});

test("extractTopicId accepts common Linux.do topic URL shapes", () => {
  const cases = [
    ["https://linux.do/t/topic/3109398", "3109398"],
    ["https://linux.do/t/some-title/3109398/2", "3109398"],
    ["https://linux.do/t/3109398.rss", "3109398"],
    ["linux.do/t/topic/3109398?u=someone", "3109398"],
    ["3109398", "3109398"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(extractTopicId(input), expected, input);
  }
});

test("extractTopicId rejects non-Linux.do and malformed URLs", () => {
  const invalid = [
    "https://example.com/t/topic/3109398",
    "https://linux.do/t/topic/not-a-number",
    "https://linux.do/about",
    "",
  ];

  for (const input of invalid) {
    assert.equal(extractTopicId(input), null, input);
  }
});

test("topicToRssUrl builds the canonical RSS endpoint", () => {
  assert.equal(
    topicToRssUrl("https://linux.do/t/some-title/3109398/2"),
    "https://linux.do/t/topic/3109398.rss",
  );
  assert.throws(() => topicToRssUrl("https://example.com/t/topic/1"));
});
