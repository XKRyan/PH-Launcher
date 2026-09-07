// Electron's Session.fetch rejects a manual redirect in Electron 44 instead of
// returning the 3xx response. This adapter preserves the fetch contract that
// SchoolDataClient needs without following a destination itself.

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function transportError(code, message) {
  const error = new Error(message);
  error.name = code;
  error.code = code;
  return error;
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function headersFromElectron(source) {
  const headers = new Headers();
  for (const [name, values] of Object.entries(source || {})) {
    for (const value of Array.isArray(values) ? values : [values]) headers.append(name, String(value));
  }
  return headers;
}

function requestHeaders(source) {
  const headers = {};
  if (source == null) return headers;
  for (const [name, value] of new Headers(source)) headers[name] = value;
  return headers;
}

function requestBody(body, method) {
  if (body == null) return null;
  if (method === 'GET' || method === 'HEAD') throw new TypeError('Request with GET/HEAD method cannot have body.');
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('Unsupported school request body.');
}

function responseFrom(status, statusText, headers, body) {
  // Native Response supplies the standard Headers/body/text/json methods used by
  // SchoolDataClient, and keeps the body consumable only once like fetch does.
  return new Response([204, 205, 304].includes(status) ? null : body, { status, statusText: statusText || '', headers });
}

/**
 * Creates an injected, fetch-compatible transport for SchoolDataClient.
 *
 * The caller owns destination validation and redirects. In particular, this
 * function never calls followRedirect. It uses the same Electron Session as the
 * visible school tab, so ordinary session cookies persist; Chromium's SameSite
 * cookie policy still applies and cannot be overridden by this adapter.
 */
function createSchoolFetch({ net, getSession }) {
  if (!net || typeof net.request !== 'function') throw new TypeError('createSchoolFetch requires Electron net.request');
  if (typeof getSession !== 'function') throw new TypeError('createSchoolFetch requires getSession(site)');
  if (typeof Response !== 'function' || typeof Headers !== 'function') throw new Error('Fetch response primitives are unavailable');

  return function schoolFetch(site, url, init = {}) {
    const session = getSession(site);
    if (!session) return Promise.reject(new TypeError('School session is unavailable'));

    let method = String(init.method || 'GET').toUpperCase();
    let body;
    let headers;
    try {
      body = requestBody(init.body, method);
      headers = requestHeaders(init.headers);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      let request;
      let settled = false;
      let expectedAbort = false;
      let responseStream;
      let received = 0;
      const chunks = [];
      const signal = init.signal;

      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (responseStream) {
          responseStream.removeListener('data', onData);
          responseStream.removeListener('end', onEnd);
          responseStream.removeListener('error', onResponseError);
          responseStream.removeListener('aborted', onResponseAborted);
        }
      };
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const fail = (error) => settle(reject, error);
      const stop = () => {
        try { request?.abort(); } catch { /* The request may already be closed. */ }
      };
      const onAbort = () => {
        expectedAbort = true;
        stop();
        fail(abortError());
      };
      const onData = (chunk) => {
        if (settled) return;
        const data = Buffer.from(chunk);
        received += data.length;
        if (received > MAX_RESPONSE_BYTES) {
          expectedAbort = true;
          stop();
          fail(transportError('BODY_TOO_LARGE', 'School response exceeded the maximum size.'));
          return;
        }
        chunks.push(data);
      };
      const onEnd = () => {
        if (settled) return;
        try {
          settle(resolve, responseFrom(responseStream.statusCode, responseStream.statusMessage, headersFromElectron(responseStream.headers), Buffer.concat(chunks, received)));
        } catch (error) { fail(error); }
      };
      const onResponseError = (error) => { if (!expectedAbort) fail(error); };
      const onResponseAborted = () => { if (!expectedAbort) fail(transportError('NETWORK_ERROR', 'School response was aborted.')); };

      try {
        request = net.request({
          url: String(url), method, headers, session,
          // Keep the login state in exactly the visible tab's session. Credentials
          // defaults to include so cookie behavior matches SchoolDataClient fetch.
          credentials: init.credentials || 'include', useSessionCookies: true,
          redirect: 'manual', cache: init.cache || 'default',
        });
      } catch (error) {
        fail(error);
        return;
      }

      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      request.once('redirect', (status, _redirectMethod, redirectUrl, electronHeaders) => {
        if (settled) return;
        const redirectHeaders = headersFromElectron(electronHeaders);
        // Manual means no followRedirect call. Abort the paused request before
        // resolving a synthetic response, so even an external Location is never
        // contacted by this transport.
        if (!redirectHeaders.has('location') && redirectUrl) redirectHeaders.set('location', redirectUrl);
        expectedAbort = true;
        stop();
        try { settle(resolve, responseFrom(status, '', redirectHeaders, null)); }
        catch (error) { fail(error); }
      });
      request.once('response', (incoming) => {
        if (settled) { incoming.resume?.(); return; }
        responseStream = incoming;
        const declaredLength = Number(incoming.headers?.['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          expectedAbort = true;
          stop();
          fail(transportError('BODY_TOO_LARGE', 'School response exceeded the maximum size.'));
          return;
        }
        incoming.on('data', onData);
        incoming.once('end', onEnd);
        incoming.once('error', onResponseError);
        incoming.once('aborted', onResponseAborted);
      });
      request.once('error', (error) => {
        // Redirect/manual cancellation and caller cancellation have already
        // settled their explicit outcomes. Do not turn either into NETWORK_ERROR.
        if (!settled && !expectedAbort) fail(error);
      });
      try { request.end(body == null ? undefined : body); }
      catch (error) { fail(error); }
    });
  };
}

module.exports = { MAX_RESPONSE_BYTES, createSchoolFetch };
