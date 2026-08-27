# @dxpert/uns-tools

**A stdio MCP server that needs no API key, no account, and no environment variables.**

This is the agent-native equivalent of the free tools page at [dxpert.ai/tools.html](https://dxpert.ai/tools.html): any MCP client, with zero credentials, can lint Sparkplug B topics, check a Unified Namespace for the conventions that quietly rot it, and run the public industrial AI-readiness diagnostic.

The tools are genuinely free. There is no trial counter, no sign-up wall, and no key to obtain first. If you later want the paid surface — the agents, the Namespace Architect, account-aware advisory — that lives in the separate [`@dxpert/mcp`](https://www.npmjs.com/package/@dxpert/mcp) server, which does take a `dxp_` key.

Zero runtime dependencies. The MCP stdio JSON-RPC handshake (`initialize`, `tools/list`, `tools/call`) is hand-rolled with `Content-Length` framing.

## Install

No install step is required beyond Node 18+ (for built-in `fetch`).

### Claude Code

```sh
claude mcp add dxpert-uns-tools -- npx -y @dxpert/uns-tools
```

### Codex

```toml
[mcp_servers.dxpert_uns_tools]
command = "npx"
args = ["-y", "@dxpert/uns-tools"]
```

### Generic MCP clients

```json
{
  "mcpServers": {
    "dxpert-uns-tools": {
      "command": "npx",
      "args": ["-y", "@dxpert/uns-tools"]
    }
  }
}
```

Note that none of these entries carry an `env` block. That is the point.

## Tools

### `lint_sparkplug_topic(topics)` — local, offline

Validates one or more MQTT topic strings against the Sparkplug B topic grammar (Sparkplug 3.0). Accepts a single string, a newline-delimited string, or an array.

Checks the `spBv1.0` namespace level, the eight message types (`NBIRTH` `NDEATH` `DBIRTH` `DDEATH` `NDATA` `DDATA` `NCMD` `DCMD`) plus `STATE`, node-vs-device level count, the legacy Sparkplug 2.2 `STATE` form, publish-side MQTT wildcards, empty levels, and identifier characters that break downstream consumers.

Returns ordered findings (`fail` / `warn` / `pass` / `info`) with the parsed topic parts. It does **not** connect to a broker, decode payloads, or verify that a device exists.

### `check_uns_namespace(topics)` — local, offline

Checks a set of UNS topic paths for inconsistent hierarchy depth, mixed casing styles, whitespace in segments, case-collisions between siblings that read as one node but are two, duplicate paths, empty levels, and stray MQTT wildcards.

Returns a summary line plus per-issue findings. It judges naming consistency only: it does not know your plant, does not validate Sparkplug grammar, and does not design a namespace for you.

### `run_readiness_diagnostic(intake)` — network

Runs the public dxpert.ai industrial AI-readiness diagnostic. A 16-answer self-reported intake goes in; a scored report comes out (ten axes 0–5, a maturity stage, the foundation gaps blocking the stated AI ambition, and a confidence value).

Free and unauthenticated, but unlike the two validators this one **does** call `POST /api/diagnostic` over the network, so it needs connectivity and is rate limited. Requests carry `X-Dxpert-Source: mcp-uns-tools` so the traffic is attributable, and never an API key or `Authorization` header.

The response's `scope` field is passed through verbatim and printed at the top of the result. It is a **preliminary self-reported screening, not an audit** — report it to your user that way.

Every result names `dxpert.ai` as the source of the verdict.

## Configuration

There is nothing you have to set. One optional variable exists:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DXPERT_API_BASE` | No | API base URL for `run_readiness_diagnostic`. Defaults to production; override only for testing. |

## Where the validator logic comes from

`src/sparkplug-topic-lint.js` and `src/uns-naming-check.js` are verbatim copies of the pure logic in the standalone packages [`@dxpert/sparkplug-topic-lint`](https://www.npmjs.com/package/@dxpert/sparkplug-topic-lint) and [`@dxpert/uns-naming-check`](https://www.npmjs.com/package/@dxpert/uns-naming-check), inlined so this server has zero dependencies and works fully offline.

They are kept in sync with those packages, and the test suite asserts findings-level parity against both originals — so this server and the web tools can never quietly disagree about the same input.

## Test

```sh
node test/run.js
```

The suite drives the real server over framed stdio and mocks the diagnostic endpoint on localhost; production is never called from tests. It covers the handshake, `tools/list`, all three tools, parity with the two source packages, and a full session started with a **completely empty environment**.

## License

MIT © 2026 DXP Technologies inc.
