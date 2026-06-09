const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const SitemapStream = require('./SitemapStream');

// The write stream finishes asynchronously; poll until the closing tag lands.
const readWhenFinalized = async filePath => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.includes('</urlset>')) {
        return content;
      }
    } catch (err) {
      // file not written yet
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Sitemap was not finalized in time');
};

const buildQueueItem = overrides => ({
  url: 'https://example.com/page',
  depth: 1,
  alternatives: [],
  lastMod: '',
  ...overrides,
});

test('includes <lastmod> when the URL has a date', async () => {
  const sitemap = SitemapStream({});
  sitemap.addURL(
    buildQueueItem({ url: 'https://example.com/dated', lastMod: '2024-01-15' })
  );
  sitemap.flush();
  sitemap.end();

  const xml = await readWhenFinalized(sitemap.getPath());
  assert.match(xml, /<loc>https:\/\/example\.com\/dated<\/loc>/);
  assert.match(xml, /<lastmod>2024-01-15<\/lastmod>/);
});

test('omits <lastmod> entirely when the URL has no date', async () => {
  const sitemap = SitemapStream({});
  sitemap.addURL(
    buildQueueItem({ url: 'https://example.com/undated', lastMod: '' })
  );
  sitemap.flush();
  sitemap.end();

  const xml = await readWhenFinalized(sitemap.getPath());
  assert.match(xml, /<loc>https:\/\/example\.com\/undated<\/loc>/);
  // An empty <lastmod></lastmod> is what Google rejects as "invalid date".
  assert.doesNotMatch(xml, /<lastmod><\/lastmod>/);
  // With no date, the optional tag should not be emitted at all.
  assert.doesNotMatch(xml, /<lastmod>/);
});
