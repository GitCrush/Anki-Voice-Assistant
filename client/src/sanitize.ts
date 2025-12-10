// client/src/sanitize.ts

/**
 * Hardcoded sanitizer (strict):
 * - Remove CSS/JS, comments, boilerplate/meta blocks, invisible spans, images (keep alt if present)
 * - Convert <br> and block endings to newlines; <li> to bullets
 * - Preserve cloze hints:
 *    - {{c1::text::HINT}}  -> "HINT"
 *    - {{c1::(Es-)Citalopram}} -> "(Es-)"
 *    - {{c1::prefix-Root}}  -> "prefix-" (if it clearly looks like a hint/prefix)
 *    - otherwise -> "…"
 * - Strip all remaining tags
 * - Decode HTML entities
 * - Remove zero-width & control characters; collapse whitespace
 * - Keep original language/terms; no paraphrasing
 */

type Fields = Record<string, any> | undefined;

/* -------------------- helpers: html entity decode (browser) -------------------- */
function decodeHTML(s: string): string {
  // Use the browser to decode entities reliably
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

/* -------------------- 1) Drop obvious boilerplate -------------------- */
function stripBoilerplate(html = ""): string {
  let s = String(html);

  // Remove <style> / <script> blocks
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Remove HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // Remove "meta/info" containers often used by AnKing/AnkiHub:
  // tags, source, note id, metadata, etc.
  s = s.replace(
    /<(?:div|section|table|tbody|thead|tr|td|ul|ol)[^>]*(tags|quelle|note id|ankihub|metadata|source|quellenangabe|ankihub_subdeck|ankihub-)/gi,
    (m) => m.replace(/<[^>]+>/g, "") // quick guard to avoid catastrophic regex, fallback to plain strip
  );
  s = s.replace(
    /<(?:div|section|table|tbody|thead|tr|td|ul|ol)[^>]*(tags|quelle|note id|ankihub|metadata|source|quellenangabe|ankihub_subdeck|ankihub-)[^>]*>[\s\S]*?<\/(?:div|section|table|tbody|thead|tr|td|ul|ol)>/gi,
    ""
  );

  // Remove invisible spans commonly used for card IDs
  s = s.replace(/<span[^>]*style=['"][^'"]*display\s*:\s*none[^'"]*['"][^>]*>[\s\S]*?<\/span>/gi, "");

  // <img alt="..."> -> alt text; otherwise drop
  s = s.replace(/<img[^>]*alt="([^"]+)"[^>]*>/gi, "$1");
  s = s.replace(/<img[^>]*>/gi, "");

  // Convert <br> to newline
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // Convert block closers to newline (paragraph-ish)
  s = s.replace(/<\/(?:p|div|section|article|li|h[1-6]|tr)>/gi, "\n");

  // Convert list items to bullet-ish text
  s = s.replace(/<li[^>]*>/gi, "\n• ");

  return s;
}

/* -------------------- 2) Cloze softening (preserve hints/partials) -------------------- */
/**
 * Cloze rules:
 * - {{cX::TEXT::HINT}} -> "HINT"
 * - If TEXT contains parentheses/brackets at the beginning, keep that part:
 *      "(Es-)Citalopram" -> "(Es-)"
 * - If TEXT looks like "prefix-" (letters + dash) at the start, keep "prefix-"
 * - Else -> "…"
 */
function softenCloze(html = ""): string {
  return String(html).replace(/\{\{c\d+::(.*?)(?:::([^}]*))?\}\}/gi, (_m, textRaw: string, hint?: string) => {
    const text = (textRaw || "").trim();
    const hintClean = (hint || "").trim();

    // 1) explicit author hint wins
    if (hintClean) return hintClean;

    // 2) preserve leading bracketed groups e.g. (Es-) or [Es-] or {Es-}
    const mParen = text.match(/^\s*(\([^)]*\)|\[[^\]]*\]|\{[^}]*\})/);
    if (mParen && mParen[1]) {
      const keep = mParen[1].trim();
      // If it's empty, fallback to ellipsis
      return keep.length ? keep : "…";
    }

    // 3) preserve clear prefix hint like "pre-" or "anti-" (letters + dash at start)
    const mPrefix = text.match(/^\s*([A-Za-zÄÖÜäöüß\-]+-)\S+/);
    if (mPrefix && mPrefix[1]) {
      return mPrefix[1];
    }

    // 4) default elide
    return "…";
  });
}

/* -------------------- 3) Strip remaining tags, but keep link text -------------------- */
function stripTags(html = ""): string {
  let s = String(html);

  // Replace anchors with their inner text
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_m, inner) => inner);

  // Remove any remaining tags
  s = s.replace(/<\/?[^>]+>/g, "");

  return s;
}

/* -------------------- 4) Decode entities and clean special chars -------------------- */
function stripSpecials(s = ""): string {
  let out = String(s);

  // Decode common entities (including numeric)
  out = decodeHTML(out);

  // Remove zero-width & bidi control characters
  out = out.replace(/[\u200B-\u200F\uFEFF\u202A-\u202E]/g, "");

  // Remove C0/C1 control chars except \n and \t
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Squash weird spacing
  out = out.replace(/\u00A0/g, " "); // nbsp
  out = out.replace(/[ \t]+\n/g, "\n");

  // Normalize multiple punctuation that often appears due to stripping
  out = out.replace(/\.{4,}/g, "…");
  out = out.replace(/–/g, "-"); // en-dash to hyphen
  out = out.replace(/—/g, "-"); // em-dash to hyphen

  // Remove stray HTML entities that survived (safety)
  out = out.replace(/&[a-z0-9#]+;/gi, "");

  return out;
}

/* -------------------- 5) Whitespace tidy -------------------- */
function tidyWhitespace(s = ""): string {
  return String(s)
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/* -------------------- public API -------------------- */

/**
 * Try to pick the best HTML field for front/back.
 * - Fields sometimes appear as { key: "string" } or { key: { value: "string" } }
 * - We try common candidates and then fall back to the first non-empty string
 */
export function extractFieldHTML(fields: Fields, _modelName: string, which: "front" | "back"): string {
  if (!fields) return "";

  const candidatesFront = ["Front", "front", "Question", "Text", "Prompt", "Cloze", "Cloze-Deletion"];
  const candidatesBack  = ["Back", "back", "Answer", "Extra", "Add. Info", "Addition", "Notes"];

  const keys = which === "front" ? candidatesFront : candidatesBack;

  for (const k of keys) {
    const v = (fields as any)[k];
    if (v && typeof v === "object" && typeof v.value === "string" && v.value.trim()) {
      return String(v.value);
    }
    if (typeof v === "string" && v.trim()) {
      return String(v);
    }
  }

  // Fallback: first string-like field with content
  for (const [_k, v] of Object.entries(fields)) {
    if (typeof v === "string" && v.trim()) return v as string;
    if (v && typeof (v as any).value === "string" && (v as any).value.trim()) return (v as any).value;
  }

  return "";
}

/**
 * Main export: sanitize HTML to speakable plain text
 */
export function toPlainSpeakable(html: string): string {
  if (!html) return "";
  let s = html;

  // 1) Remove boilerplate clutter
  s = stripBoilerplate(s);

  // 2) Handle clozes (keep explicit hints, partials, prefixes)
  s = softenCloze(s);

  // 3) Remove leftover tags (keep link text)
  s = stripTags(s);

  // 4) Decode entities and purge non-readable specials
  s = stripSpecials(s);

  // 5) Final whitespace cleanup
  s = tidyWhitespace(s);

  return s;
}
