# `/api/brief` — Studio Brief Endpoint

A single Vercel Node.js serverless function that turns a short visitor prompt
into a structured interior-design brief by calling Claude.

## What it does

- Accepts `POST /api/brief` with a JSON body `{ "input": "<1-5 sentences>" }`.
- Validates input (3–2000 chars, must be a string).
- Calls the Anthropic Messages API (`claude-sonnet-4-5`, `max_tokens: 1500`,
  `temperature: 0.6`) using the system prompt + user template defined at the
  top of `brief.js`.
- Expects the model to return a JSON string; parses it and returns
  `{ ok: true, brief: <object> }`.
- Friendly, non-leaky errors on every failure path.
- Best-effort per-IP rate limit (5 requests / 60 s).

## Environment variables

| Variable            | Required | Notes                                          |
| ------------------- | -------- | ---------------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | Read automatically by `@anthropic-ai/sdk`.     |

If the key is missing at runtime the endpoint returns `503` with a generic
"studio is offline" message. Absence is logged to stderr, never surfaced.

## Local testing

### With `vercel dev`

```bash
# from the project root
vercel dev
# then in another terminal:
curl -X POST http://localhost:3000/api/brief \
  -H 'Content-Type: application/json' \
  -d '{"input":"Small Victorian kitchen, want it to feel warm and full of light."}'
```

### Smoke tests

Node's built-in test runner (no deps):

```bash
node --test api/brief.test.mjs
```

## Request / response shape

Request:

```json
{ "input": "Small Victorian kitchen, want it to feel warm and full of light." }
```

Success (`200`):

```json
{
  "ok": true,
  "brief": { "...": "parsed JSON object produced by the model" }
}
```

Errors (all JSON, all with a friendly message):

| Status | When                                                           |
| ------ | -------------------------------------------------------------- |
| 400    | Body not JSON / `input` missing, not a string, wrong length.   |
| 405    | Non-POST method (other than `OPTIONS` preflight).              |
| 429    | Rate limit hit for this IP.                                    |
| 502    | Model returned something that wasn't parseable JSON.           |
| 503    | `ANTHROPIC_API_KEY` not set.                                   |
| 500    | Any other failure (timeouts, SDK errors).                      |

## Swapping the prompt

The prompt is deliberately isolated at the top of `api/brief.js`:

```js
const PROMPT_SYSTEM = `...`;
const PROMPT_USER_TEMPLATE = (input) => `...${input}...`;
```

To update the prompt, replace those two constants. No other code in the
handler needs to change, provided the model is still instructed to return a
single JSON object as its reply.
