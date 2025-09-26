const path = require('path');
const { randomBytes } = require('crypto'); // ✅ replace crypto-random-string
const os = require('os');
const fs = require('fs');
const escapeUnsafe = require('./helpers/escapeUnsafe');
const msg = require('./helpers/msg-helper');

// Helper to mimic crypto-random-string
function rand(length = 10) {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

module.exports = function SitemapStream(options) {
  const tmpPath = path.join(os.tmpdir(), `sitemap_${rand(10)}`);
  msg.info('USING TMP PATH TO SAVE SITEMAP: ' + tmpPath);

  const stream = fs.createWriteStream(tmpPath);
  const urls = [];

  const getPath = () => tmpPath;

  const getPriorityFromDepth = depth => {
    let pir = 0.5;
    const zeroIndexedDepth = depth - 1;
    if (zeroIndexedDepth === 0) {
      pir = 1;
    } else if (zeroIndexedDepth === 1) {
      pir = 0.9;
    } else if (zeroIndexedDepth === 2) {
      pir = 0.8;
    } else if (zeroIndexedDepth === 3) {
      pir = 0.7;
    } else if (zeroIndexedDepth === 4) {
      pir = 0.6;
    }
    return pir;
  };

  const addURL = url => {
    urls.push(url);
  };

  const initXML = () => {
    stream.write('<?xml version="1.0" encoding="utf-8" standalone="yes" ?>');
    stream.write('\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">');
  };

  const flushURL = (queueItem) => {
    queueItem.flushed = true;

    const escapedUrl = escapeUnsafe(queueItem.url);

    stream.write(`\n  <url>\n    <loc>${escapedUrl}</loc>`);
    for (const alternativeUrl of queueItem.alternatives) {
      // Skip self reference alternative URL if needed
      stream.write(
        `\n    <xhtml:link rel='alternate' hreflang='${alternativeUrl.lang}' href='${escapeUnsafe(alternativeUrl.url)}' />`
      );
    }
    if (options.changeFreq) {
      stream.write(`\n    <changefreq>${options.changeFreq}</changefreq>`);
    }
    stream.write(`\n    <priority>${getPriorityFromDepth(queueItem.depth)}</priority>`);
    stream.write(`\n    <lastmod>${queueItem.lastMod}</lastmod>`);
    stream.write(`\n  </url>`);
  };

  const flush = () => {
    initXML();
    for (const url of urls) {
      flushURL(url);
    }
  };

  const end = () => {
    stream.write('\n</urlset>');
    stream.end();
  };

  return {
    urls,
    addURL,
    getPath,
    flush,
    end
  };
};