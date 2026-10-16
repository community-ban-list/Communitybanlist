import BodyParser from 'koa-bodyparser';

// koa-bodyparser reads and parses JSON request bodies. These are the options the web server uses.
const parseJsonBody = BodyParser({
  enableTypes: ['json'],
  // The client's largest request is a couple of kilobytes, so a request much larger than that does
  // not come from the site.
  jsonLimit: '100kb',
  strict: true,
  onerror: function (err, ctx) {
    if (err) console.log(err);
    ctx.throw(422, 'body parse error');
  }
});

// The client always sends its request bodies as plain, uncompressed JSON, so only read bodies that
// are sent that way. A compressed body would be decompressed before the size limit above is
// applied, so the limit would bound the decompressed size rather than the bytes actually received;
// the client never needs that, so refuse any encoding other than "identity" (or none at all).
export default async function bodyParser(ctx, next) {
  const encoding = ctx.get('Content-Encoding').trim().toLowerCase();
  if (encoding && encoding !== 'identity') ctx.throw(415, 'Unsupported Content-Encoding.');
  return parseJsonBody(ctx, next);
}
