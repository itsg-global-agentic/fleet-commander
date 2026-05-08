// =============================================================================
// Fleet Commander — Image Reference Counter Tests
// =============================================================================
// Tests for the pure countImageRefs() and imageRefDelta() helpers used by the
// issue-context-generator parity check (see issue #711).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { countImageRefs, imageRefDelta } from '../../src/shared/image-refs.js';

// ---------------------------------------------------------------------------
// countImageRefs
// ---------------------------------------------------------------------------

describe('countImageRefs', () => {
  it('should return zero counts for empty text', () => {
    const result = countImageRefs('');
    expect(result.markdown).toEqual([]);
    expect(result.html).toEqual([]);
    expect(result.bare).toEqual([]);
    expect(result.unique.size).toBe(0);
  });

  it('should return zero counts for text with no images', () => {
    const result = countImageRefs('Just some plain text without any images.');
    expect(result.markdown).toEqual([]);
    expect(result.html).toEqual([]);
    expect(result.bare).toEqual([]);
    expect(result.unique.size).toBe(0);
  });

  it('should detect a single markdown image', () => {
    const result = countImageRefs('Here is ![an image](https://example.com/foo.png) inline.');
    expect(result.markdown).toEqual(['https://example.com/foo.png']);
    expect(result.html).toEqual([]);
    expect(result.bare).toEqual([]);
    expect(result.unique.size).toBe(1);
    expect(result.unique.has('https://example.com/foo.png')).toBe(true);
  });

  it('should detect a markdown image with a title', () => {
    const result = countImageRefs('![alt](https://example.com/foo.png "My title")');
    expect(result.markdown).toEqual(['https://example.com/foo.png']);
    expect(result.unique.size).toBe(1);
  });

  it('should detect an HTML img tag with double-quoted src', () => {
    const result = countImageRefs('<img src="https://example.com/bar.png" alt="bar">');
    expect(result.markdown).toEqual([]);
    expect(result.html).toEqual(['https://example.com/bar.png']);
    expect(result.bare).toEqual([]);
    expect(result.unique.size).toBe(1);
  });

  it('should detect an HTML img tag with single-quoted src', () => {
    const result = countImageRefs("<img src='https://example.com/baz.png' />");
    expect(result.html).toEqual(['https://example.com/baz.png']);
    expect(result.unique.size).toBe(1);
  });

  it('should detect an HTML img tag with unquoted src', () => {
    const result = countImageRefs('<img src=https://example.com/qux.png alt=qux>');
    expect(result.html).toEqual(['https://example.com/qux.png']);
    expect(result.unique.size).toBe(1);
  });

  it('should detect a bare user-images.githubusercontent.com URL', () => {
    const text = 'See screenshot: https://user-images.githubusercontent.com/12345/abc.png\n\nThanks.';
    const result = countImageRefs(text);
    expect(result.markdown).toEqual([]);
    expect(result.html).toEqual([]);
    expect(result.bare).toEqual(['https://user-images.githubusercontent.com/12345/abc.png']);
    expect(result.unique.size).toBe(1);
  });

  it('should detect a bare github.com/.../assets/... URL', () => {
    const text = 'Look at https://github.com/owner/repo/assets/9999/screenshot.png';
    const result = countImageRefs(text);
    expect(result.bare).toEqual(['https://github.com/owner/repo/assets/9999/screenshot.png']);
    expect(result.unique.size).toBe(1);
  });

  it('should detect mixed forms in a single body and dedupe distinct URLs', () => {
    // Use a non-GitHub URL for the markdown image so each URL stays in a
    // single bucket (the bare-GitHub regex would otherwise also match the
    // user-images.githubusercontent.com URL inside the markdown syntax).
    const text = [
      '# Bug report',
      '',
      '![first](https://example.com/aaa.png)',
      '',
      '<img src="https://example.com/second.png" alt="">',
      '',
      'And here is a bare link: https://github.com/o/r/assets/333/third.png',
    ].join('\n');

    const result = countImageRefs(text);
    expect(result.markdown).toEqual(['https://example.com/aaa.png']);
    expect(result.html).toEqual(['https://example.com/second.png']);
    expect(result.bare).toEqual(['https://github.com/o/r/assets/333/third.png']);
    expect(result.unique.size).toBe(3);
  });

  it('should count a GitHub URL inside markdown syntax in both markdown and bare buckets', () => {
    // When the markdown image URL is itself a GitHub-hosted asset, the bare
    // regex also matches it (since the regex runs independently against the
    // full text). The buckets show 1 markdown ref + 1 bare ref, but the
    // `unique` set deduplicates back to 1 — which is what parity callers care
    // about. Documented behaviour, not a bug.
    const url = 'https://user-images.githubusercontent.com/5/inline.png';
    const text = `![first](${url})`;

    const result = countImageRefs(text);
    expect(result.markdown).toEqual([url]);
    expect(result.bare).toEqual([url]);
    expect(result.unique.size).toBe(1);
  });

  it('should count the same URL referenced twice (markdown + bare) and unify in unique', () => {
    const url = 'https://user-images.githubusercontent.com/7/same.png';
    const text = `![first](${url})\n\nAlso bare: ${url}`;

    const result = countImageRefs(text);
    // Markdown regex matches the one inside ![]() syntax.
    expect(result.markdown).toEqual([url]);
    // Bare regex matches BOTH occurrences (the one inside ![]() and the
    // explicit bare reference) — that is fine, `unique` deduplicates.
    expect(result.bare.length).toBe(2);
    expect(result.bare.every((u) => u === url)).toBe(true);
    expect(result.unique.size).toBe(1);
  });

  it('should still count a URL inside a fenced code block', () => {
    // Documented behaviour: parity check is conservative — the renderer keeps
    // code blocks in the body, so we count URLs there too.
    const text = '```\n![inline](https://example.com/code.png)\n```';
    const result = countImageRefs(text);
    expect(result.markdown).toEqual(['https://example.com/code.png']);
    expect(result.unique.size).toBe(1);
  });

  it('should not include the closing paren of markdown syntax in the captured URL', () => {
    const text = '![alt](https://example.com/img.png)';
    const result = countImageRefs(text);
    expect(result.markdown).toEqual(['https://example.com/img.png']);
    expect(result.markdown[0]).not.toContain(')');
  });

  it('should not include a trailing closing paren when the bare URL is wrapped in parens', () => {
    const text = 'See (https://user-images.githubusercontent.com/9/bare.png) for details.';
    const result = countImageRefs(text);
    expect(result.bare).toEqual(['https://user-images.githubusercontent.com/9/bare.png']);
    expect(result.bare[0]).not.toContain(')');
  });

  it('should not capture an <img> tag without a src attribute', () => {
    const text = '<img alt="no src" srcset="foo 1x">';
    const result = countImageRefs(text);
    expect(result.html).toEqual([]);
    expect(result.unique.size).toBe(0);
  });

  it('should detect multiple markdown images in the same body', () => {
    const text = '![a](https://example.com/1.png) and ![b](https://example.com/2.png)';
    const result = countImageRefs(text);
    expect(result.markdown).toEqual(['https://example.com/1.png', 'https://example.com/2.png']);
    expect(result.unique.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// imageRefDelta
// ---------------------------------------------------------------------------

describe('imageRefDelta', () => {
  it('should report ok=true and empty missing when both texts contain the same URL', () => {
    const url = 'https://user-images.githubusercontent.com/1/abc.png';
    const before = `![alt](${url})`;
    const after = `Description goes here.\n\n![alt](${url})`;

    const delta = imageRefDelta(before, after);
    expect(delta.ok).toBe(true);
    expect(delta.missing).toEqual([]);
    expect(delta.bodyCount.unique.size).toBe(1);
    expect(delta.promptCount.unique.size).toBe(1);
  });

  it('should report ok=false and the missing URL when the prompt drops a body URL', () => {
    const url = 'https://user-images.githubusercontent.com/1/abc.png';
    const before = `Body has image: ![alt](${url})`;
    const after = 'Body has image: [... body truncated ...]';

    const delta = imageRefDelta(before, after);
    expect(delta.ok).toBe(false);
    expect(delta.missing).toEqual([url]);
    expect(delta.bodyCount.unique.size).toBe(1);
    expect(delta.promptCount.unique.size).toBe(0);
  });

  it('should NOT flag an ok=false when the prompt has an extra URL not in the body', () => {
    // Renderer-added images (boilerplate) are fine; we only flag dropped URLs.
    const url = 'https://user-images.githubusercontent.com/1/extra.png';
    const before = 'Plain body, no images.';
    const after = `Plain body, no images.\n\n![extra](${url})`;

    const delta = imageRefDelta(before, after);
    expect(delta.ok).toBe(true);
    expect(delta.missing).toEqual([]);
    expect(delta.bodyCount.unique.size).toBe(0);
    expect(delta.promptCount.unique.size).toBe(1);
  });

  it('should report multiple missing URLs in order encountered', () => {
    const url1 = 'https://user-images.githubusercontent.com/1/one.png';
    const url2 = 'https://user-images.githubusercontent.com/2/two.png';
    const before = `![1](${url1})\n\n![2](${url2})`;
    const after = 'Truncated body.';

    const delta = imageRefDelta(before, after);
    expect(delta.ok).toBe(false);
    expect(delta.missing).toContain(url1);
    expect(delta.missing).toContain(url2);
    expect(delta.missing.length).toBe(2);
  });

  it('should treat empty body and empty prompt as ok=true', () => {
    const delta = imageRefDelta('', '');
    expect(delta.ok).toBe(true);
    expect(delta.missing).toEqual([]);
    expect(delta.bodyCount.unique.size).toBe(0);
    expect(delta.promptCount.unique.size).toBe(0);
  });
});
