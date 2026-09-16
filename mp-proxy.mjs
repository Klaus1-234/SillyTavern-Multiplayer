#!/usr/bin/env node
// mp-proxy — expose ONLY the multiplayer API of your ST through a tunnel.
// usage: node mp-proxy.mjs [stPort=8000] [proxyPort=8123] [user] [pass]
//        creds also via MP_PROXY_USER / MP_PROXY_PASS
// listens on 127.0.0.1 only, CORS answered here so ST never sees preflights.
// share the tunnel URL + room code, never the ST port.
import http from 'node:http';
import { Buffer } from 'node:buffer';

const ST_PORT = parseInt(process.argv[2] || '8000', 10);
const PROXY_PORT = parseInt(process.argv[3] || '8123', 10);
const PLUGIN_PREFIX = '/api/plugins/multiplayer/';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_URL_CHARS = 2048;
const UPSTREAM_TIMEOUT_MS = 15000;

const PROXY_USER = process.argv[4] || process.env.MP_PROXY_USER || '';
const PROXY_PASS = process.argv[5] || process.env.MP_PROXY_PASS || '';
const proxyAuth = (PROXY_USER || PROXY_PASS)
    ? 'Basic ' + Buffer.from(`${PROXY_USER}:${PROXY_PASS}`, 'utf8').toString('base64')
    : '';

if (!Number.isInteger(ST_PORT) || !Number.isInteger(PROXY_PORT)) {
    console.error('[mp-proxy] invalid ports. usage: node mp-proxy.mjs [stPort] [proxyPort] [user] [pass]');
    process.exit(1);
}

// fixed allow-list, never reflect requested headers
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token, X-MP-Token, ngrok-skip-browser-warning',
    'Access-Control-Max-Age': '86400',
};
const ALLOWED_HEADER_SET = new Set(CORS_HEADERS['Access-Control-Allow-Headers'].split(',').map((s) => s.trim().toLowerCase()));

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(obj));
}

function handlePreflight(req, res) {
    const requested = String(req.headers['access-control-request-headers'] || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!requested.every((h) => ALLOWED_HEADER_SET.has(h))) {
        sendJson(res, 403, { error: 'header not allowed' });
        return;
    }
    res.writeHead(204, CORS_HEADERS);
    res.end();
}

function isAllowedMethod(method) {
    return method === 'GET' || method === 'POST';
}

// json-only POST blocks simple-request CSRF (forms skip preflight)
function isJsonPost(req) {
    if (req.method !== 'POST') return true;
    return String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json');
}

function forwardToSt(req, res) {
    const forwardHeaders = { ...req.headers, host: `127.0.0.1:${ST_PORT}` };
    if (proxyAuth && !req.headers.authorization) forwardHeaders.authorization = proxyAuth;

    const upstream = http.request({
        host: '127.0.0.1',
        port: ST_PORT,
        path: req.url,
        method: req.method,
        headers: forwardHeaders,
    }, (up) => {
        const headers = { ...CORS_HEADERS };
        for (const [key, value] of Object.entries(up.headers)) {
            const lower = key.toLowerCase();
            if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') continue;
            if (lower.startsWith('access-control-')) continue;
            headers[key] = value;
        }
        res.writeHead(up.statusCode || 502, headers);
        up.pipe(res);
    });
    upstream.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, { error: 'st not responding' });
        else try { res.end(); } catch (_) { /* partial response */ }
    });
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('timeout')));

    // node handles framing via pipe, cap the body while streaming
    let bytesSeen = 0;
    let aborted = false;
    req.on('data', (chunk) => {
        if (aborted) return;
        bytesSeen += chunk.length;
        if (bytesSeen > MAX_BODY_BYTES) {
            aborted = true;
            req.unpipe(upstream);
            upstream.destroy();
            if (!res.headersSent) sendJson(res, 413, { error: 'payload too large' });
            else try { res.end(); } catch (_) { /* partial response */ }
        }
    });
    req.pipe(upstream);
}

const server = http.createServer((req, res) => {
    let pathname = '';
    try {
        pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
        sendJson(res, 400, { error: 'bad request' });
        return;
    }
    if (req.url.length > MAX_URL_CHARS) { sendJson(res, 414, { error: 'uri too long' }); return; }
    if (req.method === 'OPTIONS') { handlePreflight(req, res); return; }
    if (!isAllowedMethod(req.method)) { sendJson(res, 405, { error: 'method not allowed' }); return; }
    if (!pathname.startsWith(PLUGIN_PREFIX)) { sendJson(res, 404, { error: 'not found' }); return; }
    if (!isJsonPost(req)) { sendJson(res, 415, { error: 'json only' }); return; }

    const declaredLength = parseInt(req.headers['content-length'] || '0', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: 'payload too large' });
        return;
    }
    forwardToSt(req, res);
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[mp-proxy] :${PROXY_PORT} -> ${PLUGIN_PREFIX} of st :${ST_PORT} (${proxyAuth ? 'auth injected' : 'client auth'})`);
    console.log('[mp-proxy] tunnel this port, not the st port');
});
