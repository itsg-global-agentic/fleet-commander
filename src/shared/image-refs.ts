// =============================================================================
// Fleet Commander — Image Reference Counter
// =============================================================================
// Pure, side-effect-free utilities for counting image references in markdown
// or HTML text. Used to verify that pasted images survive the conversion path
// from a raw GitHub issue body into the rendered context file delivered to
// the TL agent (see `src/shared/issue-context.ts` for the renderer and
// `src/server/services/issue-context-generator.ts` for the parity check that
// uses these helpers).
//
// Three forms of image references are detected, independently:
//
//   1. Markdown image syntax:        ![alt](https://example.com/foo.png)
//      Optionally followed by a title:  ![alt](https://...png "Title")
//
//   2. HTML <img> tag:               <img src="https://example.com/foo.png">
//      Supports double-quoted, single-quoted, and unquoted src attributes.
//
//   3. Bare GitHub-hosted asset URL: https://user-images.githubusercontent.com/.../foo.png
//                                    https://github.com/owner/repo/assets/...
//      These are produced when users paste images directly into the GitHub
//      issue UI and the browser rewrites the markdown to a bare URL.
//
// Notes:
//   - All three regexes apply independently; the same URL may appear in more
//     than one bucket (e.g. a bare URL inside a markdown image syntax counts
//     once in `markdown` and once in `bare`). The `unique` Set deduplicates
//     across buckets so callers can assert "did every URL survive?" rather
//     than "did every individual reference survive?".
//   - URLs inside fenced code blocks are NOT excluded — the renderer treats
//     them as part of the body text, so we count them too.
//   - This module has zero Node API dependencies (no `fs`, no `path`, no
//     `Buffer`); it is pure string processing and trivially testable.
// =============================================================================

/** Regex for markdown image syntax: ![alt](url) or ![alt](url "title") */
const IMG_MARKDOWN = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Regex for HTML <img> tag with double-quoted, single-quoted, or unquoted src. */
const IMG_HTML = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;

/**
 * Regex for bare GitHub-hosted image asset URLs. Matches:
 *   - https://user-images.githubusercontent.com/<digits>/<path>
 *   - https://github.com/<owner>/<repo>/assets/<path>
 *
 * Stops at whitespace and any closing punctuation that would normally end an
 * inline URL in markdown or HTML: `)`, `>`, `"`, `'`, `]`. This prevents the
 * trailing `)` of `![alt](url)` from being captured as part of the URL.
 */
const IMG_BARE_GITHUB = /https?:\/\/(?:user-images\.githubusercontent\.com|github\.com\/[^\s)>"'\]]+\/assets)\/[^\s)>"'\]]+/g;

/**
 * Counted image references, separated by detection family.
 *
 * Each bucket contains the URLs (or `src` values) that matched that regex.
 * `unique` is the deduplicated set across all three buckets — useful for
 * parity checks that only care whether a given URL is present somewhere.
 */
export interface ImageRefCount {
  /** URLs from markdown `![alt](url)` syntax */
  markdown: string[];
  /** URLs from HTML `<img src="...">` tags */
  html: string[];
  /** URLs from bare GitHub user-images / .../assets/... patterns */
  bare: string[];
  /** Unique URLs across all three buckets */
  unique: Set<string>;
}

/**
 * Count image references in a string. Returns the URLs split into three
 * buckets (markdown / html / bare GitHub) plus a deduplicated `unique` set.
 *
 * Pure function. Empty input returns zero counts.
 */
export function countImageRefs(text: string): ImageRefCount {
  const markdown: string[] = [];
  const html: string[] = [];
  const bare: string[] = [];
  const unique = new Set<string>();

  if (!text) {
    return { markdown, html, bare, unique };
  }

  // --- Markdown images ---
  for (const m of text.matchAll(IMG_MARKDOWN)) {
    const url = m[1];
    if (url) {
      markdown.push(url);
      unique.add(url);
    }
  }

  // --- HTML <img src=...> ---
  for (const m of text.matchAll(IMG_HTML)) {
    // The src value may have been captured in group 1 (double-quoted),
    // group 2 (single-quoted), or group 3 (unquoted).
    const src = m[1] ?? m[2] ?? m[3];
    if (src) {
      html.push(src);
      unique.add(src);
    }
  }

  // --- Bare GitHub-hosted asset URLs ---
  for (const m of text.matchAll(IMG_BARE_GITHUB)) {
    const url = m[0];
    if (url) {
      bare.push(url);
      unique.add(url);
    }
  }

  return { markdown, html, bare, unique };
}

/**
 * Result of comparing image references between two strings (typically the
 * raw issue body and the rendered TL prompt).
 */
export interface ImageRefDelta {
  /**
   * `true` when every unique URL present in `before` is also present in
   * `after`. Extra URLs in `after` (which would be unusual but possible if
   * the renderer adds boilerplate) do NOT cause `ok` to flip false — the
   * concern is dropped URLs, not added ones.
   */
  ok: boolean;
  /** URLs that appear in `before` but not in `after`. */
  missing: string[];
  /** Image-ref count for the `before` string. */
  bodyCount: ImageRefCount;
  /** Image-ref count for the `after` string. */
  promptCount: ImageRefCount;
}

/**
 * Compare image references between two strings. Returns the per-string
 * counts and a list of URLs that were present in `before` but lost in
 * `after` (the typical "image got truncated by the renderer" failure).
 */
export function imageRefDelta(before: string, after: string): ImageRefDelta {
  const bodyCount = countImageRefs(before);
  const promptCount = countImageRefs(after);

  const missing: string[] = [];
  for (const url of bodyCount.unique) {
    if (!promptCount.unique.has(url)) {
      missing.push(url);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    bodyCount,
    promptCount,
  };
}
