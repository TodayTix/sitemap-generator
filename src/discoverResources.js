const url = require('url');
const cheerio = require('cheerio');
const superagent = require('superagent-interface-promise');
// const normalizeUrl = require('normalize-url'); // ❌ removed (ESM-only)
const cld = require('cld');
const msg = require('./helpers/msg-helper');

let browser = null;
let crawler = null;

/**
 * Lightweight URL normalizer covering the options used in this file.
 * Options:
 *  - removeTrailingSlash: boolean (default false)
 *  - forceHttps: boolean (default false)
 *  - stripWWW: boolean (default true)
 */
function normalize(input, opts = {}) {
  const {
    removeTrailingSlash = false,
    forceHttps = false,
    stripWWW = true,
  } = opts;

  let href = String(input || '');
  if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href)) {
    href = 'http://' + href;
  }

  let u;
  try {
    u = new URL(href);
  } catch (_) {
    return String(input || '');
  }

  if (forceHttps) u.protocol = 'https:';

  // Lowercase host
  u.hostname = u.hostname.toLowerCase();

  if (stripWWW && u.hostname.startsWith('www.')) {
    u.hostname = u.hostname.slice(4);
  }

  // Normalize default ports
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }

  // Clean up pathname
  if (removeTrailingSlash && u.pathname !== '/' && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
    if (u.pathname === '') u.pathname = '/';
  }

  // Collapse duplicate slashes in pathname
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');

  return u.toString();
}

const guessItemLanguage = (queueItem) => {
  const $ = queueItem.$;
  const init = (resolve, reject) => {
    let lang = $('html').attr('lang') ? $('html').attr('lang') : '';
    if (lang !== '') {
      resolve(lang);
    } else {
      cld.detect(queueItem.plainHTML || '', { isHTML: true }, function(err, result) {
        if (err) {
          return reject(err);
        }
        lang = result && result.languages && result.languages[0] && result.languages[0].code
          ? result.languages[0].code
          : '';
        resolve(lang);
      });
    }
  };
  return new Promise(init);
};

const discoverWithCheerio = (buffer, queueItem) => {

  queueItem.urlNormalized = normalize(queueItem.url, {
    removeTrailingSlash: false,
    forceHttps: true
  });
  queueItem.plainHTML = buffer.body ? buffer.body : buffer.toString('utf8');
  queueItem.$ = cheerio.load(queueItem.plainHTML);
  queueItem.canonical = '';
  queueItem.alternatives = [];
  queueItem.isDiscoveryProcessDone = false;

  const $ = queueItem.$;
  const metaRobots = $('meta[name="robots"]');

  if (
    metaRobots &&
    metaRobots.length &&
    /nofollow/i.test(metaRobots.attr('content'))
  ) {
    return [];
  }
  const alternatives = $('head').find('link[rel="alternate"]');
  alternatives.each(function() {
    try {
      let hreflang = $(this).attr('hreflang');
      let type = $(this).attr('type');
      let hreflangUrl = ($(this).attr('href') || '').replace('\n', '').trim();

      if (type === 'application/rss+xml') {
        return;
      }

      if (hreflangUrl !== '' && queueItem.urlNormalized === normalize(hreflangUrl, {
          removeTrailingSlash: false,
          forceHttps: true
        })) {
        // Update the original URL by its main language
        queueItem.lang = hreflang;
      }
      if (typeof hreflang !== typeof undefined && hreflang !== false && hreflangUrl !== '') {
        queueItem.alternatives.push({
          url: hreflangUrl,
          urlNormalized: normalize(hreflangUrl, {
            removeTrailingSlash: false,
            forceHttps: true
          }),
          flushed: false,
          lang: hreflang
        });
      }

    } catch (err) {
      msg.error(err);
    }
  });

  const handleAlters = () => {
    guessItemLanguage(queueItem).then(lang => {
      queueItem.lang = queueItem.lang ? queueItem.lang : lang;
      queueItem.isDiscoveryProcessDone = true;
      delete queueItem.$;
      delete queueItem.plainHTML;
    }, () => {
      queueItem.isDiscoveryProcessDone = true;
      delete queueItem.$;
      delete queueItem.plainHTML;
    });
  };

  const links = () => {
    const $ = queueItem.$;
    const html = $('a[href], link[rel="canonical"]');

    // TODO: Use the mapping function to handle relative URLs for alternatives
    const links = html.map(function iteratee() {
      let href = $(this).attr('href');
      if (!href || href === '') {
        return null;
      }
      // exclude "mailto:" etc
      if (/^[a-z]+:(?!\/\/)/i.test(href)) {
        return null;
      }

      // exclude rel="nofollow" links
      const rel = $(this).attr('rel');
      if (/nofollow/i.test(rel)) {
        return null;
      } else if (rel === 'canonical') {
        queueItem.canonical = href;
      }

      // remove anchors
      href = href.replace(/(#.*)$/, '');

      // handle "//"
      if (/^\/\//.test(href)) {
        return `${queueItem.protocol}:${href}`;
      }

      // check if link is relative (does not start with "http(s)" or "//")
      if (!/^https?:\/\//.test(href)) {
        const base = $('base').first();
        if (base && base.length) {
          if (base.attr('href') !== undefined) {
            // base tags sometimes don't define href
            href = url.resolve(base.attr('href'), href);
          }
        }

        // handle links such as "./foo", "../foo", "/foo"
        if (/^\.\.?\/.*/.test(href) || /^\/[^/].*/.test(href)) {
          href = url.resolve(queueItem.url, href);
        }
      }
      return href;
    });
    return links;
  };

  (async () => {
    const resume = crawler.wait();
    if (!browser) {
      handleAlters();
      return resume();
    }
    try {
      const data = await getHTMLWithHeadlessBrowser(queueItem.url);
      queueItem.plainHTML = data.body;
      queueItem.$ = cheerio.load(queueItem.plainHTML);
      handleAlters();

      let resources = links().get();
      resources = crawler.cleanExpandResources(resources, queueItem);
      resources.forEach(function(url) {
        if (crawler.maxDepth === 0 || queueItem.depth + 1 <= crawler.maxDepth) {
          crawler.queueURL(url, queueItem);
        }
      });
      resume();
    } catch (ex) {
      msg.error(ex);
      resume();
    }

  })();

  return links().get();
};

const getHTMLWithHeadlessBrowser = async (urlStr) => {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en'
  });

  const result = {
    url: urlStr,
    body: '',
    endURL: urlStr
  };
  try {
    await page.goto(urlStr, {
      waitLoad: true,
      waitNetworkIdle: true,
      timeout: 3000000
    });
    await page.waitForTimeout(15000);
    result.body = await page.evaluate('new XMLSerializer().serializeToString(document.doctype) + document.documentElement.outerHTML');
    result.endURL = await page.evaluate('window.location.origin');
    await page.close();

  } catch (ex) {
    msg.error(ex);
  }
  return result;
};

const getHTML = async (urlStr) => {
  return superagent.get(urlStr);
};

module.exports = (options) => {
  browser = options.browser;
  crawler = options.crawler;

  return {
    getLinks: discoverWithCheerio,
    getHTML: getHTML,
    getHTMLWithHeadlessBrowser: getHTMLWithHeadlessBrowser
  };
};