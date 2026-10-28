import BodyParser from 'koa-bodyparser';

// koa-bodyparser reads and parses JSON request bodies. These are the options the web server uses.
const parseJsonBody = BodyParser({
  enableTypes: ['json'],
  // The client's largest request is a couple of kilobytes, so a request much larger than that does
  // not come from the site.
  jsonLimit: '100kb',
  strict: true,
  // Answer a body that cannot be read with the status the parser gives it, such as 413 for one over
  // the limit or 400 for one that is not JSON, and a fixed message. The parser's error can hold the
  // body itself, so only what kind of error it was is logged.
  onerror: function (err, ctx) {
    console.log(`Could not read a request body: ${err.type || err.name} (${err.status})`);
    const status = err.status >= 400 && err.status < 500 ? err.status : 400;
    if (status === 413) ctx.throw(413, 'Request body too large.');
    ctx.throw(status, 'Request body could not be read.');
  }
});

// The client always sends its request bodies as plain, uncompressed JSON, so only read bodies that
// are sent that way. A compressed body would be decompressed before the size limit above is
// applied, so the limit would bound the decompressed size rather than the bytes actually received;
// the client never needs that, so refuse any encoding other than "identity" (or none at all).
export default async function bodyParser(ctx, next) {
  const encoding = ctx.get('Content-Encoding').trim().toLowerCase();
  if (encoding && encoding !== 'identity') ctx.throw(415, 'Unsupported Content-Encoding.');
  // Encoding names are case-insensitive, but the parser only recognises "identity" in lower case,
  // so pass it on in that form.
  if (encoding) ctx.req.headers['content-encoding'] = 'identity';
  return parseJsonBody(ctx, next);
}
