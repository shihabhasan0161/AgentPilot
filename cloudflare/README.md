# Cloudflare browser automation

Two TypeScript Workers run browser tasks independently of the local Python applications. The agent Worker accepts instructions and calls OpenAI; the browser Worker exposes MCP tools backed by Cloudflare Browser Run. Durable Objects coordinate browser ownership, background execution, and retained results.

```text
HTTP client / Siri Shortcut
  -> Agent Worker -> RunCoordinator -> OpenAI
                          |
                    service binding
                          |
     Browser Worker -> BrowserSession -> Browser Run
```

Addresses, credentials, model selections, and allowlist values are intentionally omitted. Replace angle-bracket placeholders with your own settings before use.

## Files and folders

Paths below are relative to this directory unless marked otherwise.

| Path | Purpose |
| --- | --- |
| `browser/` | Browser MCP service and its deployment configuration. |
| `browser/src/index.ts` | HTTP entry point, authentication, health, lease routes, and MCP dispatch. |
| `browser/src/browser-session.ts` | `BrowserSession` Durable Object: exclusive leases, browser launch, serialized actions, evidence capture, and cleanup. Declares `BrowserEnv`. |
| `browser/src/mcp.ts` | MCP tool schemas, current-page resource, and user-flow prompt. |
| `browser/src/policy.ts` | Exact-host navigation/dependency allowlists and URL validation. |
| `browser/wrangler.jsonc` | Worker entry point, compatibility settings, browser binding, Durable Object binding/migration, variables, version metadata, and logging. |
| `browser/.dev.vars.example` | Template for local browser secrets. |
| `browser/worker-configuration.d.ts` | Generated binding declarations; optional under the current explicit environment interfaces. |
| `browser/tests/policy.test.ts` | Host and URL policy tests. |
| `browser/tests/protocol.test.ts` | MCP authentication, discovery, tools, resources, and prompts tests. |
| `browser/tests/sessions.test.ts` | Session/lease lifecycle tests. |
| `browser/tests/tools.test.ts` | Browser action, evidence, and error tests using mocks. |
| `agent/` | Task API and model-driven execution service. |
| `agent/src/index.ts` | HTTP entry point, health, agent authentication, and coordinator dispatch. |
| `agent/src/run-coordinator.ts` | `RunCoordinator` Durable Object: validation, idempotency, background alarms, quotas, status, recovery, retention, and cleanup. Declares `AgentEnv`. |
| `agent/src/runner.ts` | Model/tool loop, execution budgets, structured results, and final-state verification. |
| `agent/src/mcp-client.ts` | MCP connection and authenticated browser requests over the service binding. |
| `agent/src/evidence.ts` | Evidence persistence/retrieval with chunked screenshot storage. |
| `agent/wrangler.jsonc` | Worker entry point, compatibility settings, browser service binding, coordinator binding/migration, model selection, metadata, and logging. |
| `agent/.dev.vars.example` | Template for local agent secrets. |
| `agent/worker-configuration.d.ts` | Generated agent binding declarations; optional in this setup. |
| `agent/tests/runs.test.ts` | Submission, idempotency, lifecycle, and retention tests. |
| `agent/tests/runner.test.ts` | Model loop and tool execution tests. |
| `shared/contracts.ts` | Runtime schemas/types, limits, authentication, request parsing, response helpers, and safe errors. Required by both Workers. |
| `shared/instructions.ts` | Agent system instructions and browser-task rules. Required by the agent. |
| `shared/test-storage.ts` | In-memory Durable Object storage/state helper for unit tests. |
| `shared/test-workers.ts` | Minimal Durable Object constructor used by the Vitest alias. |
| `scripts/build.ts` | Dry-run bundles both Workers into `dist/` with Wrangler; does not deploy. |
| `scripts/test-runtime.ts` | Loads built bundles into Miniflare; verifies real Workers runtime behavior, SQLite objects, MCP, and background execution using a stubbed model. Requires the build first. |
| `scripts/common.ts` | Shared deployed-check CLI parsing, environment tokens, artifact writing, and evidence assertions. |
| `scripts/check-mcp.ts` | Deployed authentication and MCP discovery checks; no browser launch or model call. |
| `scripts/test-deployed-mcp.ts` | Live browser acceptance test for the script's demo flow, with evidence artifacts. |
| `scripts/test-deployed-agent.ts` | Live end-to-end agent test, including idempotency and evidence; uses a real model and browser. |
| `scripts/test-deployed-form.ts` | Read-only enabled-textbox diagnostic for a supported public form; no submission or model call. |
| `scripts/verify-evidence.ts` | Rechecks saved evidence against an exact expected task name without cloud calls. |
| `scripts/tests/common.test.ts` | Script URL argument/validation tests. |
| `package.json` | Dependencies, supported Node version, and npm commands. Commit it. |
| `package-lock.json` | Exact dependency resolution used by `npm ci`. Commit it. |
| `tsconfig.json` | TypeScript options and source/test include paths. |
| `vitest.config.ts` | Unit-test discovery and the `cloudflare:workers` mock alias. |
| `README.md` | Setup, API, deployment, and repository guidance. |
| `../.github/workflows/cloudflare.yml` | Verification and optional ordered deployment through GitHub Actions. |


## Installation and local settings

Use Node.js 24 to match CI. The minimum supported version is declared in `package.json`. Run the following from `cloudflare/`:

```powershell
npm ci
Copy-Item browser/.dev.vars.example browser/.dev.vars
Copy-Item agent/.dev.vars.example agent/.dev.vars
```

Copy the templates only on first setup; preserve existing secret files. Fill in your own credentials. Wrangler loads `.dev.vars` per Worker for local development. These files are ignored and do not configure deployed secrets.

### Variables and secrets

| Name | Location | Purpose |
| --- | --- | --- |
| `MCP_API_TOKEN` | Both Workers' runtime secrets; browser-check shell environment | Browser API/MCP authentication. Must match between Workers. |
| `AGENT_API_TOKEN` | Agent runtime secret; agent-check shell environment; HTTP client | Task submission and result/evidence authentication. Use a different token from the MCP token. |
| `OPENAI_API_KEY` | Agent runtime secret | Model authentication. Never send it from Siri. |
| `BROWSER_WORKER_URL` | Agent runtime configuration; browser-check shell environment | Browser Worker HTTPS origin, without a path. Set locally in `agent/.dev.vars` and remotely using the secret command below. |
| `AGENT_WORKER_URL` | Agent-check shell environment | Agent Worker origin used by deployed verification scripts. Not needed by the agent runtime. |
| `OPENAI_MODEL` | Agent dashboard variable; local `agent/.dev.vars` | Select an accessible Responses API model supporting tools and structured output. |
| `ALLOWED_DOMAINS` | Browser dashboard variable or secret; local `browser/.dev.vars` | Comma-separated exact navigation hostnames. Required and nonempty. |
| `ASSET_DOMAINS` | Browser dashboard variable or secret; local `browser/.dev.vars` | Comma-separated exact dependency hosts for scripts, styles, images, and API requests. Does not grant top-level navigation. May be empty. |


Runtime bearer tokens must be random strings of at least 32 characters; template markers are rejected. Store values in local `.dev.vars` files or deployed Worker secrets. Keep credentials out of Wrangler `vars`, URLs, source, and committed examples.

Bindings are resources rather than secret strings:

| Binding | Worker | Resource |
| --- | --- | --- |
| `BROWSER` | Browser | Native Browser Run binding; remote during local development. |
| `BROWSER_SESSION` | Browser | SQLite-backed `BrowserSession` Durable Object namespace. |
| `MCP_BROWSER` | Agent | Service binding targeting the configured browser Worker name. |
| `RUN_COORDINATOR` | Agent | SQLite-backed `RunCoordinator` Durable Object namespace. |
| `VERSION` | Both | Deployment version metadata used by health/run responses. |

Review both Wrangler files and set your Worker names. Configure model selection and navigation/dependency hostnames in each Worker's Cloudflare dashboard and in its local `.dev.vars`. Both configurations use `keep_vars: true` and omit `vars`, preserving existing dashboard variables on subsequent deployments. This does not create missing variables: set them explicitly on first deployment before submitting tasks. Secrets are also preserved. Keep `MCP_BROWSER.service` equal to the browser Worker's `name`. Preserve the declared class bindings and migration history on an existing deployment. Keep the Node compatibility flag.

Allowlist entries are hostnames only, without schemes, paths, ports, wildcards, or implicit subdomains. Explicitly include required dependency hosts. The policy rejects private/local-style hostnames and bounds the list size. Restart local development after changing `.dev.vars`; save/deploy dashboard variable changes to apply them remotely. Avoid adding these names back to Wrangler `vars`, which would override dashboard values on deployment.

```powershell
npx wrangler login
npm run dev
```

Both Workers run together with their service binding. Use the local addresses printed by Wrangler: the agent address for task submissions and the browser address for direct MCP access. Browser operations use the remote binding, require Cloudflare account access, and consume cloud browser usage. Agent tasks call the configured OpenAI account. See [Cloudflare's browser binding guidance](https://developers.cloudflare.com/browser-run/reference/wrangler/).

### Local verification

```powershell
npm run typecheck
npm test
npm run build
npm run test:runtime
```

The runtime check must follow the build because it reads `dist/browser/index.js` and `dist/agent/index.js`. Unit tests use mocks. Runtime verification uses a stubbed model and does not launch Chromium or make paid model requests. Live acceptance scripts are separate and are not run by CI.
## Cloudflare setup and deployment

1. Select a Cloudflare account, configure its Workers subdomain, and ensure Workers, SQLite-backed Durable Objects, and Browser Run are available. Review the applicable account limits and billing.
2. Run `npx wrangler login` and `npx wrangler whoami` to authenticate and confirm the account.
3. Review both Wrangler configurations as described above. Their migrations provision the declared Durable Object classes/namespaces. This implementation does not use a separate D1 database, R2 bucket, or Containers service.
4. Deploy the browser first so the agent's service target exists:

   ```powershell
   npm run deploy:browser
   npx wrangler secret put MCP_API_TOKEN --config browser/wrangler.jsonc
   ```

5. Deploy the agent and set its runtime secrets:

   ```powershell
   npm run deploy:agent
   npx wrangler secret put MCP_API_TOKEN --config agent/wrangler.jsonc
   npx wrangler secret put AGENT_API_TOKEN --config agent/wrangler.jsonc
   npx wrangler secret put OPENAI_API_KEY --config agent/wrangler.jsonc
   npx wrangler secret put BROWSER_WORKER_URL --config agent/wrangler.jsonc
   ```

   Enter values at Wrangler's prompts. The MCP secret must match between Workers. Secrets can also be managed in each Worker's dashboard settings. Set them before accepting tasks; unconfigured operations fail closed.

6. Save the HTTPS addresses printed by Wrangler privately. This document uses `https://<agent-worker-host>` and `https://<browser-worker-host>` as placeholders. Check `GET /health` on both. Health confirms liveness/revision, not full browser/model readiness.
7. Run deployed verification before enabling automatic deployment. Sessions use fresh cloud browsers without your local browser's cookies or saved logins.

The browser API requires its MCP token even when reached through the service binding. Siri only needs the agent API. See [Cloudflare's browser deployment guide](https://developers.cloudflare.com/browser-run/how-to/deploy-worker/) and [current account limits](https://developers.cloudflare.com/browser-run/limits/).

## API endpoints

Both Workers expose unauthenticated `GET /health`, returning `status` and `revision`. All other operations require authorization. Errors return JSON such as `{"error":"<error-code>"}`.

### Agent API

Use `Authorization: Bearer <agent-api-token>`.

| Method and path | Behavior |
| --- | --- |
| `POST /agent/run` | JSON with only `instruction`, plus an `Idempotency-Key` header. Returns HTTP 202 with `run_id` and `status`; execution continues in the background. |
| `GET /runs/{run_id}` | Status, timestamps, result, tool events, token usage, revision, and optional error fields. Submitted instruction and internal session/key are omitted. |
| `GET /runs/latest` | Newest retained run, or 404 when none exists. Use a specific ID when tracking one task. |
| `GET /runs/{run_id}/evidence` | Captured URL, title, accessibility snapshot, observations, capture time, and optional base64 JPEG. Returns 404 when evidence is unavailable. |

Submission shape:

```http
POST https://<agent-worker-host>/agent/run
Authorization: Bearer <agent-api-token>
Content-Type: application/json
Idempotency-Key: <unique-request-key>

{"instruction":"<browser-task-instruction>"}
```

Instructions must be nonempty after trimming and at most 4,000 characters. Idempotency keys must contain 8–100 letters, digits, underscores, or hyphens; a generated UUID works. Use a fresh key per task and reuse it when retrying the same submission. A different instruction with the same key returns `409 idempotency_conflict`. Another task during an active run returns `409 busy`.

States are `queued`, `running`, `completed`, `blocked`, `failed`, and `interrupted`. A terminal result contains `status`, `summary`, and an evidence list. HTTP 202 acknowledges submission; it does not mean completion. Fetch a run's status if the client needs its outcome. Results/evidence expire according to `LIMITS.retentionMs`; idempotency protection ends when the retained record expires. Failures do not undo website actions.

### Browser API and MCP

Use `Authorization: Bearer <mcp-api-token>`.

| Method and path | Behavior |
| --- | --- |
| `POST /sessions` | Reserve the single browser lease; HTTP 201 with `session_id` and `expires_at`. Does not launch Chromium yet. |
| `DELETE /sessions` | Requires `X-AgentPilot-Session: <session-id>`; closes/releases the leased browser and returns closed status. |
| `GET /sessions/evidence` | Requires the lease header; captures current browser evidence. |
| `POST /mcp` | MCP JSON-RPC over Streamable HTTP. Send `Content-Type: application/json` and a lease header for browser tools. This is a protocol endpoint, not an instruction-body REST endpoint. |

Other `/mcp` methods follow the MCP transport's behavior. Use an MCP client for initialization and calls. Discovery does not require a lease; browser operations do. The agent manages its lease automatically.

| MCP tool | Inputs / purpose |
| --- | --- |
| `open_page` | `url`; open an allowed page and capture its accessibility snapshot. |
| `page_snapshot` | Optional `wait_for_text` and `timeout_ms`; inspect the current page or wait for confirmation. |
| `click` | Exact accessible `role` and `name`. |
| `fill` | `label` and `value`; fill an identified field. |
| `press_key` | `key`; supported navigation/confirmation keys are defined in the schema. |
| `screenshot` | Optional `full_page`; bounded JPEG capture. |
| `close_browser` | No inputs; release the lease. Further operations need a new lease. |

The server also exposes the `browser://current-page` resource and `test_user_flow` prompt with `url` and `goal` arguments.

## Simple Siri Shortcut

Provide an instruction using Text or Ask for Input, and generate a fresh UUID for the request key. Configure **Get Contents of URL**:

| Setting | Value |
| --- | --- |
| URL | `https://<agent-worker-host>/agent/run` |
| Method | `POST` |
| Header `Authorization` | `Bearer <agent-api-token>` |
| Header `Content-Type` | `application/json` |
| Header `Idempotency-Key` | Generated UUID for this task |
| Request Body | JSON |
| JSON field `instruction` | Text containing the task |

Optionally show the returned `run_id`, and invoke the Shortcut by name with Siri. This simple Shortcut submits the job and exits; Cloudflare continues execution. It does not announce successful completion. To inspect an outcome separately, use **Get Contents of URL**, method `GET`, URL `https://<agent-worker-host>/runs/<run-id>`, with the same agent authorization header. `/runs/latest` can be used for a manual newest-task check.

Siri needs only the agent token. Keep a Shortcut containing credentials private. Apple documents JSON POST bodies in [Get Contents of URL](https://support.apple.com/guide/shortcuts/apd58d46713f/ios).

## Deployed verification commands

Set `BROWSER_WORKER_URL` and `AGENT_WORKER_URL` in your shell to use deployed checks without passing addresses on the command line. Browser checks read the former; agent checks read the latter. An explicit positional URL or `--url` overrides the environment setting. Unit/runtime tests use reserved example hosts and mocked/local transports, never your deployment addresses.

Set `MCP_API_TOKEN` or `AGENT_API_TOKEN` in the shell before the relevant command. These scripts do not automatically load Worker `.dev.vars` files. Use a secure prompt or secret manager rather than typing secret literals into shell history.

```powershell
npm run check:mcp -- https://<browser-worker-host>
npm run test:deployed:mcp -- https://<browser-worker-host>
npm run test:deployed:form -- https://<browser-worker-host>
npm run verify:evidence -- artifacts/<artifact-id>/evidence.json <exact-task-name>
```

For the deployed agent test, set the agent address and token in the same PowerShell session, then run the command from `cloudflare/`:

```powershell
$env:AGENT_WORKER_URL = "https://<agent-worker-host>"
$env:AGENT_API_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'Agent API token' -AsSecureString)).Password
npm run test:deployed:agent
```

Replace the address placeholder with your deployed agent origin. These variables last for the current PowerShell session. `AGENT_WORKER_URL` is used only by verification scripts; it does not need to be set in Cloudflare or Worker `.dev.vars` files.

Replace placeholders before running. The form diagnostic additionally needs `TEST_FORM_URL` and optionally `TEST_FIELD_LABEL`. Deployed task tests and evidence assertions are specific to their demo flow; inspect the scripts before testing a different site. Live browser tests consume browser usage, and the deployed agent test also calls OpenAI. Saved artifacts may contain page text/images and remain ignored.

## Limits and behavior

`shared/contracts.ts` is the source of truth for deadlines, browser lease/idle timeouts, session spacing, daily run limits, model/tool budgets, request/evidence sizes, and retention. These are code settings, not environment variables. Review them against account allowances and model budgets. Token guards check between requests and are not strict monetary spending caps.

There is one active run/browser lease shared by manual and agent calls. Sessions are fresh and destinations are allowlisted. Authentication challenges, blocked dependencies, and lost sessions can prevent completion. A model summary alone does not verify success. Evidence/cleanup failures can turn a claimed completion into a failed run.
