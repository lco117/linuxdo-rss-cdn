/**
 * Pure helpers shared by the browser UI and the Cloudflare Worker.
 * No DOM APIs live here so the module can also run under Node tests.
 */

export const BASE62_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const CDN_ORIGIN = "https://cdn3.ldstatic.com";
export const CDN_BASE_PATH = `${CDN_ORIGIN}/original/4X`;
export const LINUXDO_ORIGIN = "https://linux.do";

const BASE62_LOOKUP = new Map(
  [...BASE62_ALPHABET].map((character, index) => [character, index]),
);

/**
 * Decode a Discourse Base62 upload id into its 40-character SHA-1 hex form.
 * The alphabet order matches Discourse's lib/base62.rb.
 *
 * @param {string} input
 * @returns {string}
 */
export function decodeBase62ToHex(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Base62 value is empty");
  }

  let value = 0n;
  for (const character of input) {
    const digit = BASE62_LOOKUP.get(character);
    if (digit === undefined) {
      throw new Error(`Invalid Base62 character: ${character}`);
    }
    value = value * 62n + BigInt(digit);
  }

  return value.toString(16).padStart(40, "0");
}

/**
 * Convert an upload:// short URL to the corresponding cdn3.ldstatic.com URL.
 * Returns null when the short URL is malformed or does not decode to 40 hex
 * characters (the SHA-1 path shape Linux.do uses).
 *
 * @param {string} uploadUrl
 * @returns {string | null}
 */
export function uploadToCdn(uploadUrl) {
  const match = /^upload:\/\/([0-9A-Za-z]+)\.([0-9A-Za-z]+)$/.exec(uploadUrl);
  if (!match) return null;

  const [, encoded, extension] = match;
  try {
    const hash = decodeBase62ToHex(encoded);
    if (!/^[0-9a-f]{40}$/.test(hash)) return null;
    return `${CDN_BASE_PATH}/${hash[0]}/${hash[1]}/${hash[2]}/${hash}.${extension}`;
  } catch {
    return null;
  }
}

/**
 * Replace every syntactically valid upload:// token inside a string.
 * Everything else in the source (XML declaration, CDATA, entities, etc.) is
 * left byte-for-byte unchanged.
 *
 * @param {string} source
 * @returns {{
 *   output: string,
 *   entries: Array<{ original: string, cdn: string }>,
 *   replacements: number,
 *   unresolved: number
 * }}
 */
export function decodeUploadUrls(source) {
  const entries = [];
  const output = String(source ?? "").replace(
    /upload:\/\/([0-9A-Za-z]+)\.([0-9A-Za-z]+)/g,
    (original, encoded, extension) => {
      const cdn = uploadToCdn(`upload://${encoded}.${extension}`);
      if (!cdn) return original;
      entries.push({ original, cdn });
      return cdn;
    },
  );

  // Count obvious upload:// tokens that the conversion regex could not parse.
  const allTokens = String(source ?? "").match(/upload:\/\/[^\s"'<>]+/g) ?? [];
  const unresolved = Math.max(0, allTokens.length - entries.length);

  return { output, entries, replacements: entries.length, unresolved };
}

/**
 * Extract a Linux.do topic id from common topic URLs, raw RSS URLs, or a bare
 * numeric id.
 *
 * @param {string} input
 * @returns {string | null}
 */
export function extractTopicId(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;

  let candidate = raw;
  if (/^(?:www\.)?linux\.do\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== "linux.do" && !url.hostname.endsWith(".linux.do")) {
    return null;
  }

  const match = url.pathname.match(/\/t\/(?:[^/]+\/)?(\d+)(?:[./]|$)/);
  return match ? match[1] : null;
}

/**
 * Build the canonical RSS endpoint for a Linux.do topic URL or topic id.
 *
 * @param {string} input
 * @returns {string}
 */
export function topicToRssUrl(input) {
  const topicId = extractTopicId(input);
  if (!topicId) {
    throw new Error("无法从链接中提取 Linux.do topic id");
  }
  return `${LINUXDO_ORIGIN}/t/topic/${topicId}.rss`;
}
