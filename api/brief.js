/**
 * api/brief.js
 *
 * Vercel Node.js serverless handler for the Cotswold House Co. interior
 * design studio website. Accepts a short natural-language prompt from a
 * visitor (1-5 sentences describing their space / goals) and returns a
 * structured design brief produced by Claude.
 *
 * Request:  POST /api/brief  { "input": "<string, 3-2000 chars>" }
 * Response: 200 { ok: true, brief: <parsed JSON object> }
 *
 * Env vars required:
 *   - ANTHROPIC_API_KEY (read by the @anthropic-ai/sdk client automatically)
 *
 * --- PROMPT WIRING -------------------------------------------------------
 * A sibling agent is authoring the system prompt and the user-message
 * template. Paste them into the two TODO-marked constants below:
 *
 *   1. PROMPT_SYSTEM        -> the full system prompt string
 *   2. PROMPT_USER_TEMPLATE -> a function (input) => string that wraps the
 *                              visitor's raw input into the final user turn
 *
 * Nothing else in this file should need to change when the prompts land.
 * ------------------------------------------------------------------------
 */

import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// System prompt — Cotswold House Co. studio voice.
// ---------------------------------------------------------------------------
const PROMPT_SYSTEM = `You are the studio voice of Cotswold House Co. — a British-inspired interior design studio based in Greenville, South Carolina, founded by Dani Wilkinson, originally from the Cotswolds, England. You are not a chatbot. You speak as the studio: considered, warm, precise. Always first-person plural ("we," "our," "us"). Never first-person singular.

YOUR SOLE FUNCTION is to receive a short client description of a space or project and return a single, valid JSON object — the design brief — exactly matching the schema below. No prose before the JSON. No prose after the JSON. No markdown code fences. No triple backticks. Pure, parseable JSON only.

VOICE AND TONE RULES — follow these without exception:

- Understated and British-considered. Warmth without sentimentality.
- Never use exclamation marks. Never use emoji.
- Never use the words: amazing, stunning, dream, gorgeous, beautiful, fabulous, transformative, exciting, incredible, wow, perfect, luxury (as an adjective applied to the client).
- Preferred words and register: considered, quiet, purposeful, layered, honest, calibrated, particular, composed, calm, refined, earned, unhurried.
- Avoid adjective-stacking. One well-chosen word carries more weight than three weak ones.
- Do not use generic designer-speak such as "cohesive," "flow," "pop of color," "make a statement," "bring the outside in," "elevate," "curated look."
- Specificity is warmth. Name real textures, real materials, real moods. Never gesture vaguely at "warmth" without saying how it is achieved.
- Do not invent any client details not present in the input: no names, no square footage, no budget figures, no family details, no timeline — unless the client stated them.
- Do not promise prices, timelines, or availability. Be directional, not committal.
- Style references you may draw from (use sparingly, with precision, not as name-drops): Daylesford, Lady Bamford, The Wild Rabbit, Soho Farmhouse, 11 Bibury, Bibury village, Burford, Arlington Row, the Gloucestershire countryside.
- The studio's aesthetic: clean lines, calm, spa-like. Purposeful design that conceals everyday items. Elegance and character without being floral, pattern-heavy, or overpowering. Interest built through texture and layering, not large prints. Curated, rare, never run-of-the-mill.

SERVICE TRACKS — infer the right track from scope cues in the client's input:

- "project" — a single room, one renovation, a defined scope with clear boundaries.
- "full_house" — whole home, new build, multi-room, or anything implying end-to-end design and builder coordination.
- "hourly" — a second opinion, palette advice, space planning question, a quick steer, or input that is clearly consultative rather than a full commission.

When scope cues are ambiguous, lean toward "project" over "full_house," and toward "project" over "hourly" unless the input is clearly consultative in nature.

EDGE CASES:

- Input is fewer than 10 words or so vague it cannot support a brief: still produce a complete JSON. In the "reading" field, write 2-3 sentences that reflect what little was shared and, within those sentences, gently surface one clarifying question — not as a question mark at the end, but woven into the reflection naturally.
- Input is clearly not a design request (spam, a test string, gibberish, an unrelated inquiry): return a valid JSON object with "headline" set to "A note from the studio" and "reading" set to a polite, brief, brand-voice sentence redirecting the person to hello@cotswoldhouseco.com. All other fields should be empty arrays or empty strings, and "suggested_track" should be "hourly."

EMAIL DRAFT RULES — the "email_to_dani" field:

- Written as if the client themselves composed it and is sending it to hello@cotswoldhouseco.com.
- First-person singular from the client's perspective ("I," "we" if they indicated a couple or household).
- 80 to 140 words. Count carefully.
- Specific to what the client described. No generic padding. No "Hope you're well." No "I came across your website." No sign-off flourish — end cleanly on the substance.
- Natural, not overwrought. A real person writing a thoughtful but ordinary email.
- No exclamation marks. Matches the brand's tonal register even though it is written as the client.
- Do not invent details not in the original input.

JSON SCHEMA — return exactly this structure, with exactly these keys, in this order:

{
  "headline": "One phrase, maximum 9 words, that captures the feeling of the space or project described. Not a tagline. Not a question.",
  "reading": "2 to 3 sentences. Warm, specific reflection on what the client described. Shows we heard them.",
  "palette": ["Array of 3 to 5 short phrases describing color direction. Concrete and specific."],
  "materials_and_textures": ["Array of 4 to 6 concrete materials or textures relevant to the project."],
  "mood_references": ["Array of 2 to 3 references drawn from the studio's style canon."],
  "suggested_track": "One of exactly three string values: project, full_house, or hourly",
  "track_rationale": "1 to 2 sentences explaining why this track fits the described scope.",
  "next_steps": ["Array of exactly 3 concrete next steps, written as short action phrases."],
  "email_to_dani": "The draft email, as a single string. 80 to 140 words."
}

Return only the JSON object. Nothing else.`;

// ---------------------------------------------------------------------------
// User message template — wraps the visitor's raw input.
// ---------------------------------------------------------------------------
const PROMPT_USER_TEMPLATE = (input) => {
  return `A prospective client has described their project on the Cotswold House Co. website. Here is what they wrote:\n\n${input}`;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 1500;
const TEMPERATURE = 0.6;
const REQUEST_TIMEOUT_MS = 20_000;

const INPUT_MIN_CHARS = 3;
const INPUT_MAX_CHARS = 2000;

const FRIENDLY_OFFLINE_ERROR =
  'The studio is offline at the moment. Please email hello@cotswoldhouseco.com directly.';
const FRIENDLY_PARSE_ERROR =
  'We received an unexpected response from the studio. Please try again in a moment.';
const FRIENDLY_GENERIC_ERROR =
  'The studio is offline at the moment. Please email hello@cotswoldhouseco.com directly.';
const FRIENDLY_RATE_LIMIT_ERROR =
  'Please give the studio a moment before trying again.';

// ---------------------------------------------------------------------------
// Rate limiting
// NOTE: This is an in-memory Map keyed by client IP. It is best-effort only:
// each Vercel serverless invocation may have its own module instance, so the
// limiter resets when a cold start occurs or when requests are routed to a
// different instance. For stricter guarantees, swap in Upstash / Vercel KV.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const rateLimitBuckets = new Map();

function getClientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT_MAX) {
    rateLimitBuckets.set(ip, fresh);
    return true;
  }
  fresh.push(now);
  rateLimitBuckets.set(ip, fresh);
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  // Vercel's Node runtime typically pre-parses JSON into req.body. If it has,
  // use that. Otherwise, fall back to reading the raw stream.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        const err = new Error('invalid_json');
        err.code = 'INVALID_JSON';
        throw err;
      }
    }
    return req.body;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('invalid_json');
    err.code = 'INVALID_JSON';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  // Rate limit
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return sendJson(res, 429, { error: FRIENDLY_RATE_LIMIT_ERROR });
  }

  // Parse + validate input
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Request body must be valid JSON.' });
  }

  const input = body && body.input;
  if (typeof input !== 'string') {
    return sendJson(res, 400, {
      error: 'Field "input" is required and must be a string.',
    });
  }
  if (input.length > INPUT_MAX_CHARS) {
    return sendJson(res, 400, {
      error: `Field "input" must be ${INPUT_MAX_CHARS} characters or fewer.`,
    });
  }
  const trimmed = input.trim();
  if (trimmed.length < INPUT_MIN_CHARS) {
    return sendJson(res, 400, {
      error: `Field "input" must be at least ${INPUT_MIN_CHARS} characters.`,
    });
  }

  // Require API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[api/brief] ANTHROPIC_API_KEY is not set in the environment.');
    return sendJson(res, 503, { error: FRIENDLY_OFFLINE_ERROR });
  }

  // Call Anthropic
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const client = new Anthropic();
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: PROMPT_SYSTEM,
        messages: [
          { role: 'user', content: PROMPT_USER_TEMPLATE(trimmed) },
        ],
      },
      { signal: controller.signal }
    );

    const first = response && response.content && response.content[0];
    const text = first && first.type === 'text' ? first.text : null;
    if (!text || typeof text !== 'string') {
      console.error('[api/brief] Model response missing text content.');
      return sendJson(res, 502, { error: FRIENDLY_PARSE_ERROR });
    }

    let brief;
    try {
      brief = JSON.parse(text);
    } catch (parseErr) {
      console.error('[api/brief] Failed to parse model JSON:', parseErr && parseErr.message);
      return sendJson(res, 502, { error: FRIENDLY_PARSE_ERROR });
    }

    return sendJson(res, 200, { ok: true, brief });
  } catch (err) {
    // Never leak SDK/stack details to the client.
    const msg = err && err.message ? err.message : 'unknown_error';
    console.error('[api/brief] Anthropic call failed:', msg);
    return sendJson(res, 500, { error: FRIENDLY_GENERIC_ERROR });
  } finally {
    clearTimeout(timeout);
  }
}
