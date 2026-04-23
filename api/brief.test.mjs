/**
 * api/brief.test.mjs
 *
 * Zero-dependency smoke tests for the /api/brief handler.
 * Run with:  node --test api/brief.test.mjs
 *
 * These tests invoke the handler in-process with mock req/res objects so we
 * don't need a live HTTP server or a real Anthropic API key for the
 * negative-path cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import handler from './brief.js';

// ---------------------------------------------------------------------------
// Mock req/res helpers
// ---------------------------------------------------------------------------
function makeReq({ method = 'POST', body = undefined, headers = {} } = {}) {
  // Vercel's Node runtime commonly exposes the parsed body on req.body. Our
  // handler prefers that when present, so passing `body` directly is enough.
  const req = new EventEmitter();
  req.method = method;
  req.headers = { 'content-type': 'application/json', ...headers };
  req.socket = { remoteAddress: `127.0.0.${Math.floor(Math.random() * 250) + 1}` };
  req.body = body;
  return req;
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    end(payload) {
      this.body = payload;
      this.ended = true;
    },
  };
  return res;
}

function parseBody(res) {
  if (typeof res.body !== 'string') return res.body;
  try {
    return JSON.parse(res.body);
  } catch {
    return res.body;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('missing body -> 400', async () => {
  // Explicitly withhold ANTHROPIC_API_KEY-triggered 503 by setting the key;
  // we want the 400 validation path here.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    const req = makeReq({ body: {} }); // no `input` field
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    const parsed = parseBody(res);
    assert.ok(parsed && typeof parsed.error === 'string');
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('missing ANTHROPIC_API_KEY -> 503', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const req = makeReq({
      body: { input: 'A sunlit reading nook with a tall window.' },
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 503);
    const parsed = parseBody(res);
    assert.ok(parsed && typeof parsed.error === 'string');
    // Must not leak "key" / internals to the client.
    assert.doesNotMatch(parsed.error, /key|env|ANTHROPIC/i);
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('oversized input (>2000 chars) -> 400', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    const req = makeReq({ body: { input: 'x'.repeat(2001) } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    const parsed = parseBody(res);
    assert.ok(parsed && typeof parsed.error === 'string');
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('non-POST method -> 405', async () => {
  const req = makeReq({ method: 'GET' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test('OPTIONS preflight -> 204 with CORS headers', async () => {
  const req = makeReq({ method: 'OPTIONS' });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.getHeader('Access-Control-Allow-Origin'), '*');
});

// TODO: add an integration test that stubs the Anthropic client to assert the
// 200 success path and the 502 "model returned non-JSON" path. Would require
// injecting a mock client (e.g., via dependency injection or a module mock)
// since the handler currently constructs `new Anthropic()` directly.
