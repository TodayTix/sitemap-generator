const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const SitemapGenerator = require('./index');

const pageHtml = '<html><head><title>Page</title></head><body>Page</body></html>';

let server;
let siteUrl;

before(async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(pageHtml);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const toForcedURL = url => ({ value: url, alternatives: [] });

const generateSitemap = options =>
  new Promise(resolve => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'select-forced-urls-'));
    const filepath = path.join(outputDirectory, 'sitemap.xml');
    const generator = SitemapGenerator(siteUrl, { ...options, filepath });
    generator.on('done', () => resolve(fs.readFileSync(filepath, 'utf8')));
    generator.start();
  });

describe('selectForcedURLs', { concurrency: true }, () => {
  test('lists only the forced URLs it keeps, waiting for it to resolve', async () => {
    const keptURL = `${siteUrl}/forced-kept`;
    const droppedURL = `${siteUrl}/forced-dropped`;

    const sitemap = await generateSitemap({
      forcedURLs: [toForcedURL(keptURL), toForcedURL(droppedURL)],
      selectForcedURLs: async forcedURLs => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return forcedURLs.filter(forcedURL => forcedURL.value === keptURL);
      },
    });

    assert.ok(sitemap.includes(`<loc>${keptURL}</loc>`));
    assert.ok(!sitemap.includes(`<loc>${droppedURL}</loc>`));
  });

  test('lists every forced URL when it throws', async () => {
    const forcedURLs = [`${siteUrl}/forced-a`, `${siteUrl}/forced-b`];

    const sitemap = await generateSitemap({
      forcedURLs: forcedURLs.map(toForcedURL),
      selectForcedURLs: async () => {
        throw new Error('selection failed');
      },
    });

    for (const forcedURL of forcedURLs) {
      assert.ok(sitemap.includes(`<loc>${forcedURL}</loc>`));
    }
  });

  test('lists every forced URL when it rejects with something other than an Error', async () => {
    const forcedURLs = [`${siteUrl}/forced-g`, `${siteUrl}/forced-h`];

    const sitemap = await generateSitemap({
      forcedURLs: forcedURLs.map(toForcedURL),
      selectForcedURLs: () => Promise.reject(undefined),
    });

    for (const forcedURL of forcedURLs) {
      assert.ok(sitemap.includes(`<loc>${forcedURL}</loc>`));
    }
  });

  test('lists every forced URL when it resolves to something other than a list', async () => {
    const forcedURLs = [`${siteUrl}/forced-e`, `${siteUrl}/forced-f`];

    const sitemap = await generateSitemap({
      forcedURLs: forcedURLs.map(toForcedURL),
      selectForcedURLs: async () => undefined,
    });

    for (const forcedURL of forcedURLs) {
      assert.ok(sitemap.includes(`<loc>${forcedURL}</loc>`));
    }
  });

  test('lists every forced URL when no selector is given', async () => {
    const forcedURLs = [`${siteUrl}/forced-c`, `${siteUrl}/forced-d`];

    const sitemap = await generateSitemap({ forcedURLs: forcedURLs.map(toForcedURL) });

    for (const forcedURL of forcedURLs) {
      assert.ok(sitemap.includes(`<loc>${forcedURL}</loc>`));
    }
  });
});
