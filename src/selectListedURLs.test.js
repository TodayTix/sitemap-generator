const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const SitemapGenerator = require('./index');

let server;
let siteUrl;

const pageWithHead = headMarkup =>
  `<html><head><title>Page</title>${headMarkup}</head><body>Page</body></html>`;

const pagesByPath = () => ({
  '/': pageWithHead(
    [
      'plain',
      'noindex',
      'noindex-follow',
      'noindex-nofollow',
      'googlebot-none',
      'robots-index',
      'canonical-elsewhere',
      'canonical-relative',
      'canonical-itself',
      'canonical-off-site',
      'robots-spaced-value',
      "it's-a-page",
    ]
      .map(page => `<a href="/${page}">${page}</a>`)
      .join('')
  ),
  '/plain': pageWithHead(''),
  '/noindex': pageWithHead('<meta name="robots" content="noindex">'),
  '/noindex-follow': pageWithHead('<meta name="ROBOTS" content="NoIndex, follow">'),
  '/noindex-nofollow': pageWithHead('<meta name="robots" content="noindex,nofollow">'),
  '/googlebot-none': pageWithHead('<meta name="googlebot" content="none">'),
  '/robots-index': pageWithHead('<meta name="robots" content="index, follow">'),
  '/canonical-elsewhere': pageWithHead(`<link rel="canonical" href="${siteUrl}/plain">`),
  '/canonical-relative': pageWithHead('<link rel="canonical" href="/plain">'),
  '/canonical-itself': pageWithHead(`<link rel="canonical" href="${siteUrl}/canonical-itself">`),
  '/robots-spaced-value': pageWithHead('<meta name="robots" content="index, max-image-preview: none">'),
  '/it%27s-a-page': pageWithHead(`<link rel="canonical" href="${siteUrl}/it's-a-page">`),
  '/canonical-off-site': pageWithHead('<link rel="canonical" href="https://elsewhere.example/x">'),
});

before(async () => {
  server = http.createServer((request, response) => {
    const page = pagesByPath()[request.url];
    response.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html' });
    response.end(page ?? 'not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const generateSitemap = options =>
  new Promise(resolve => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'select-listed-urls-'));
    const filepath = path.join(outputDirectory, 'sitemap.xml');
    const generator = SitemapGenerator(siteUrl, { ...options, filepath });
    generator.on('done', stats =>
      resolve({ sitemap: fs.readFileSync(filepath, 'utf8'), stats })
    );
    generator.start();
  });

const listedPaths = sitemap =>
  [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].replace(siteUrl, ''));

describe('selectListedURLs', { concurrency: true }, () => {
  test('hands over every crawled page with what it says about indexing', async () => {
    let queueItems = [];

    await generateSitemap({
      selectListedURLs: items => {
        queueItems = items;
        return items;
      },
    });

    const byPath = Object.fromEntries(queueItems.map(item => [item.url.replace(siteUrl, ''), item]));
    assert.strictEqual(byPath['/noindex'].isNoindex, true);
    assert.strictEqual(byPath['/noindex-follow'].isNoindex, true);
    assert.strictEqual(byPath['/googlebot-none'].isNoindex, true);
    assert.strictEqual(byPath['/robots-index'].isNoindex, false);
    assert.strictEqual(byPath['/robots-spaced-value'].isNoindex, false);
    assert.strictEqual(byPath['/plain'].isNoindex, false);
    assert.strictEqual(byPath['/plain'].canonicalUrl, '');
    assert.strictEqual(byPath['/canonical-relative'].canonicalUrl, `${siteUrl}/plain`);
    assert.strictEqual(byPath['/canonical-itself'].canonicalUrl, `${siteUrl}/canonical-itself`);
    assert.strictEqual(byPath['/canonical-off-site'].canonicalUrl, 'https://elsewhere.example/x');
  });

  test('lists only the pages it keeps, waiting for it to resolve, and reports the rest as unlisted', async () => {
    const { sitemap, stats } = await generateSitemap({
      selectListedURLs: async items => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return items.filter(item => !item.isNoindex);
      },
    });

    const listed = listedPaths(sitemap);
    assert.ok(listed.includes('/plain'));
    assert.ok(listed.includes('/robots-index'));
    for (const noindexPath of ['/noindex', '/noindex-follow', '/googlebot-none']) {
      assert.ok(!listed.includes(noindexPath), `${noindexPath} should not be listed`);
    }
    assert.deepStrictEqual(
      stats.unlisted.map(url => url.replace(siteUrl, '')).sort(),
      ['/googlebot-none', '/noindex', '/noindex-follow']
    );
  });

  test('finds a forced URL the crawl fetched even when the two spell its characters differently', async () => {
    const forcedUrl = `${siteUrl}/noindex-nofollow`;
    const encodedForcedUrl = forcedUrl.replace('nofollow', 'nofol%6Cow');
    let seenForcedItem;

    await generateSitemap({
      forcedURLs: [{ value: encodedForcedUrl, alternatives: [] }],
      selectListedURLs: items => {
        seenForcedItem = items.find(item => item.url === encodedForcedUrl);
        return items;
      },
    });

    assert.strictEqual(seenForcedItem.isNoindex, true);
  });

  test('lets a forced URL that was never fetched through the same selector', async () => {
    const forcedUrl = `${siteUrl}/never-crawled`;
    const seenForcedItems = [];

    const { sitemap } = await generateSitemap({
      forcedURLs: [{ value: forcedUrl, alternatives: [] }],
      selectListedURLs: items => {
        seenForcedItems.push(...items.filter(item => item.url === forcedUrl));
        return items;
      },
    });

    assert.ok(sitemap.includes(`<loc>${forcedUrl}</loc>`));
    assert.strictEqual(seenForcedItems.length, 1);
    assert.strictEqual(seenForcedItems[0].isNoindex, undefined);
    assert.strictEqual(seenForcedItems[0].canonicalUrl, undefined);
  });

  test('tells it a forced URL is noindex when the crawl fetched that page but never finished with it', async () => {
    const forcedUrl = `${siteUrl}/noindex-nofollow`;
    let seenForcedItem;

    const { sitemap } = await generateSitemap({
      forcedURLs: [{ value: forcedUrl, alternatives: [] }],
      selectListedURLs: items => {
        seenForcedItem = items.find(item => item.url === forcedUrl);
        return items.filter(item => !item.isNoindex);
      },
    });

    assert.strictEqual(seenForcedItem.isNoindex, true);
    assert.ok(!sitemap.includes(`<loc>${forcedUrl}</loc>`));
  });

  test('lists every page when it throws', async () => {
    const { sitemap, stats } = await generateSitemap({
      selectListedURLs: () => {
        throw new Error('selection failed');
      },
    });

    assert.ok(listedPaths(sitemap).includes('/noindex'));
    assert.deepStrictEqual(stats.unlisted, []);
  });

  test('lists every page when it resolves to something other than a list', async () => {
    const { sitemap, stats } = await generateSitemap({ selectListedURLs: async () => undefined });

    assert.ok(listedPaths(sitemap).includes('/noindex'));
    assert.deepStrictEqual(stats.unlisted, []);
  });

  test('lists every page when no selector is given', async () => {
    const { sitemap, stats } = await generateSitemap({});

    assert.ok(listedPaths(sitemap).includes('/noindex'));
    assert.deepStrictEqual(stats.unlisted, []);
  });
});
