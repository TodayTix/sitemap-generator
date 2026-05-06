const SitemapGenerator = require('../index');

describe('SitemapGenerator', () => {
  beforeEach(() => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  it('does not set NODE_TLS_REJECT_UNAUTHORIZED globally', () => {
    SitemapGenerator('http://example.com');
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });
});
