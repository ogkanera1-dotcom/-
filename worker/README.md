# Worker setup (iPad / Cloudflare dashboard)

This directory contains the API Worker for Stage 1. It is intentionally not deployable until Access, origin, quota storage, and the OpenAI key are configured. Never expose the endpoint before those checks are complete.

## API contract

- `GET /api/usage` returns `{ status: "ok", usage: { dailyRemaining, shortWindowRemaining, resetsAt } }`.
- `POST /api/meeting` accepts only `{ "topic": "..." }` and returns `{ status: "ok", messages: [{ "speaker": "chatgpt", "text": "..." }], usage: ... }`.
- Errors use `{ status: "error", error: { "code": "...", "message": "..." }, usage?: ... }`.
- The Worker, not the browser, chooses the model and speaker. Limits: 5 calls per JST calendar day, 2 calls per rolling 10 minutes, 500 topic characters, 8 KiB request body, and 250 output tokens. A request is reserved before calling OpenAI; failures after reservation consume a use. Quota storage failures fail closed.

## Dashboard setup checklist (do not skip)

1. In Cloudflare, create a Worker from this repository's `worker/` project using the current dashboard workflow. Review the `wrangler.jsonc` configuration, including the `QuotaCounter` SQLite Durable Object migration and binding. Do not use the retired `wrangler publish` command.
2. Before deploying a reachable API, create a Cloudflare Access application/policy for the Worker hostname and allow only the producer's identity. Confirm that Access is enforced on the production Worker route.
3. Set non-secret Worker variables in the dashboard: `ALLOWED_ORIGIN` to the exact GitHub Pages origin (including scheme and any project path is not part of an origin), `ACCESS_TEAM_DOMAIN` to the Access team hostname, `ACCESS_AUD` to the Access application's audience tag, `ALLOWED_EMAIL` to the exact allowed email, and `OPENAI_MODEL` to a model ID currently available to the API account.
4. Add `OPENAI_API_KEY` under Worker **Settings → Variables and Secrets** explicitly as a **Secret**. Never put it in this repository, frontend, HTML, browser storage, or logs.
5. Verify the Cloudflare dashboard shows the DO binding/migration and Access protection as active. Do not enable GitHub Pages calls until the test below succeeds.
6. Test from iPad Safari while logged into Access: preflight/OPTIONS, `GET /api/usage`, an authorized meeting, wrong-origin rejection, missing/invalid Access JWT rejection, 10-minute limit, JST daily limit, and storage failure behavior. Confirm each actual response and usage count. Safari's cross-site cookie restrictions may prevent a GitHub Pages page from authenticating to a separate Worker host; if so, stop and redesign auth rather than weakening checks or placing a secret in JavaScript.

The repository code alone cannot create the Cloudflare Access policy, store the API Secret, deploy the Worker, or prove the cross-origin Safari login flow. Those account-side steps and live tests remain required.

## Model and billing

`gpt-4.1-mini` is only a provisional default candidate. Before first use, check that the model ID is currently available to the API project and compare its current input/output prices on OpenAI's official model and pricing pages. API use is billed separately from ChatGPT subscriptions. Keep account alerts enabled; Worker quotas are the request-side hard limits for this app, not an absolute guarantee against provider-side billing or an already-started request.
