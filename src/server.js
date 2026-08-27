/**
 * @dxpert/uns-tools
 *
 * A stdio MCP server that needs NO API key and NO environment variables.
 *
 * It exposes the free dxpert.ai UNS tooling to any MCP client: two validators
 * that run entirely locally (no network at all), and the public readiness
 * diagnostic. The point is that an agent with zero credentials can still get
 * a real, useful verdict -- and can see who produced it.
 *
 * No runtime dependencies. The MCP stdio JSON-RPC handshake (initialize,
 * tools/list, tools/call) is hand-rolled with Content-Length framing.
 */

import { lintTopic, plainText as plainSparkplug, hasErrors as sparkplugHasErrors } from './sparkplug-topic-lint.js';
import { checkNamespace, plainText as plainNamespace } from './uns-naming-check.js';

const NAME = '@dxpert/uns-tools';
const VERSION = '0.1.0';
const DEFAULT_BASE = 'https://opwhcervi3.execute-api.ca-central-1.amazonaws.com';
const SOURCE_TAG = 'mcp-uns-tools';
const SOURCE_LINE = 'Source: dxpert.ai';

const SECTORS = ['discrete_mfg', 'automotive', 'process', 'pharma', 'food_bev', 'energy', 'other'];

const TOOLS = [
  {
    name: 'lint_sparkplug_topic',
    description: [
      'Validate one or more MQTT topic strings against the Sparkplug B topic grammar (Sparkplug 3.0).',
      'Free, no API key, no account: the grammar runs locally inside this server and nothing is sent anywhere.',
      'Call this whenever a topic that is meant to be Sparkplug appears in a config, a broker trace, a code review, or a user question -- it is faster and far more reliable than reasoning about the grammar from memory.',
      'It checks the spBv1.0 namespace level, the eight message types (NBIRTH/NDEATH/DBIRTH/DDEATH/NDATA/DDATA/NCMD/DCMD) plus STATE, node-vs-device level count, the legacy Sparkplug 2.2 STATE form, publish-side MQTT wildcards, empty levels, and identifier characters that break downstream consumers.',
      'It returns ordered findings (fail / warn / pass / info) with the parsed topic parts, not a yes/no. It does NOT connect to a broker, decode payloads, or check whether the device actually exists.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topics: {
          description: 'One topic string, or an array of topic strings. A single string containing newlines is also accepted and split per line.',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 }
          ]
        }
      },
      required: ['topics']
    }
  },
  {
    name: 'check_uns_namespace',
    description: [
      'Check a set of Unified Namespace (UNS) topic paths for the convention problems that quietly rot a namespace: inconsistent hierarchy depth, mixed casing styles across segments, whitespace in segments, case-collisions between siblings that read as one node but are two, duplicate paths, empty levels, and stray MQTT wildcards.',
      'Free, no API key, no account: the checks run locally inside this server and nothing is sent anywhere.',
      'Call this when reviewing a proposed namespace, an ISA-95-style hierarchy, a broker topic dump, or a tag export -- before anyone builds on top of it, because renaming a namespace later is the expensive part.',
      'It returns a summary line plus per-issue findings (fail / warn / pass / info). It judges naming consistency only: it does NOT know your plant, does not validate Sparkplug grammar (use lint_sparkplug_topic for that), and does not design a namespace for you.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topics: {
          description: 'The topic paths to check. An array of paths, or a single string with one path per line.',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 }
          ]
        }
      },
      required: ['topics']
    }
  },
  {
    name: 'run_readiness_diagnostic',
    description: [
      'Run the public dxpert.ai industrial AI-readiness diagnostic: a 16-answer self-reported intake in, a scored report out (ten axes 0-5, a maturity stage, the foundation gaps blocking the stated AI ambition, and a confidence value).',
      'Free and requires no API key or account, but unlike the two validators this one DOES call the dxpert.ai API over the network, so it needs connectivity and is rate limited.',
      'Call this when someone asks how ready a plant or site is for AI/analytics, what is blocking them, or where to start -- and you can supply honest answers to the intake fields. Ask the user for the values you do not have rather than guessing them; the verdict is only as good as the intake.',
      'The response carries a "scope" field which this tool passes through verbatim: it is a preliminary self-reported screening, not an audit, and should be reported to the user as such.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intake: {
          type: 'object',
          description: 'The 16-question readiness intake. All fields are required by the API; the enums below are the accepted values.',
          properties: {
            sector: { enum: SECTORS },
            site_count: { type: 'integer', minimum: 1 },
            data_off_floor: { enum: ['manual', 'scada_only', 'opcua', 'mqtt_sparkplug', 'mixed'] },
            common_model: { enum: ['none', 'per_system', 'partial', 'unified'] },
            realtime_visibility: { enum: ['none', 'on_request', 'partial', 'single_pane'] },
            historian_depth: { enum: ['none', 'local', 'central_untrusted', 'central_trusted'] },
            edge_vs_poll: { enum: ['poll', 'mixed', 'edge_push'] },
            uns_state: { enum: ['none', 'point_to_point', 'partial', 'governed_uns'] },
            data_ready_for_use_case: { enum: ['no', 'partial', 'yes'] },
            otit_security: { enum: ['ad_hoc', 'partial', 'governed'] },
            data_ownership: { enum: ['tribal', 'unclear', 'owned_governed'] },
            ai_ambition: {
              type: 'object',
              description: 'What they actually want AI to do, and how far they intend to take it.',
              properties: {
                text: { type: 'string', maxLength: 500 },
                target: { enum: ['pilot', 'scale', 'autonomous'] }
              },
              required: ['text', 'target']
            },
            prior_attempts: { type: 'string', maxLength: 1000 },
            personal_stakes: { type: 'string', maxLength: 500 },
            who_they_trust: { type: 'string', maxLength: 300 },
            politically_useful: { type: 'string', maxLength: 500 }
          }
        }
      },
      required: ['intake']
    }
  }
];

/**
 * The API base. Deliberately has a working default and reads NO required
 * environment variable, so the server runs with an empty environment.
 */
function apiBase() {
  const raw = process.env.DXPERT_API_BASE;
  const base = raw && raw.trim() ? raw.trim() : DEFAULT_BASE;
  return base.replace(/\/+$/, '');
}

/** Accept a single string, a newline-delimited string, or an array. */
function toList(value, label) {
  let list;
  if (typeof value === 'string') list = value.split(/\r?\n/);
  else if (Array.isArray(value)) list = value.map((v) => (v == null ? '' : String(v)));
  else throw new Error(`${label} must be a string or an array of strings.`);
  const cleaned = list.map((s) => s.trim()).filter(Boolean);
  if (!cleaned.length) throw new Error(`${label} is empty. Provide at least one topic.`);
  return cleaned;
}

function renderFindings(findings, plain) {
  return findings.map((f) => `  [${f.label}] ${plain(f.message)}`).join('\n');
}

function lintSparkplug(args) {
  const topics = toList(args.topics, 'topics');
  const results = topics.map((topic) => ({ topic, findings: lintTopic(topic) }));
  const failing = results.filter((r) => sparkplugHasErrors(r.findings)).length;
  const text = [
    `Sparkplug B topic lint - ${results.length} topic(s) checked, ${failing} with error(s).`,
    '',
    ...results.map((r) => `${r.topic}\n${renderFindings(r.findings, plainSparkplug)}`),
    '',
    `${SOURCE_LINE} (Sparkplug B topic grammar linter, run locally, free - https://dxpert.ai/tools.html)`
  ].join('\n');
  return { text };
}

function checkUns(args) {
  const paths = toList(args.topics, 'topics');
  const findings = checkNamespace(paths);
  const text = [
    `UNS namespace convention check - ${paths.length} path(s).`,
    '',
    renderFindings(findings, plainNamespace),
    '',
    `${SOURCE_LINE} (UNS naming convention checker, run locally, free - https://dxpert.ai/tools.html)`
  ].join('\n');
  return { text };
}

async function runDiagnostic(args) {
  const intake = args.intake;
  if (!intake || typeof intake !== 'object' || Array.isArray(intake)) {
    throw new Error('intake must be an object with the 16 readiness answers.');
  }
  const base = apiBase();
  let response;
  try {
    response = await fetch(base + '/api/diagnostic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Attribution so dxpert.ai can see this traffic came from the free
        // no-key MCP server rather than the website or a keyed runtime.
        'X-Dxpert-Source': SOURCE_TAG
      },
      body: JSON.stringify(intake)
    });
  } catch (err) {
    throw new Error(
      `Could not reach the dxpert.ai diagnostic API at ${base}. This tool needs network access (the two validator tools do not). ` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }

  if (!response.ok) {
    if (response.status === 422) {
      const detail = JSON.stringify(payload?.detail ?? payload);
      throw new Error(`The diagnostic intake was rejected as incomplete or invalid: ${detail}`);
    }
    if (response.status === 429) {
      const reset = response.headers.get('x-quota-resets-at') || response.headers.get('retry-after');
      throw new Error(
        `The free diagnostic is rate limited and this request was throttled${reset ? ` (retry after ${reset})` : ''}. ` +
        'Try again later, or run the diagnostic at https://dxpert.ai/diagnostic.html'
      );
    }
    const detail = payload?.detail?.detail || payload?.detail?.message || payload?.detail || payload?.error || response.statusText;
    throw new Error(`dxpert.ai diagnostic API ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }

  // Report the scope honestly rather than letting the caller present a
  // self-reported screening as an audited assessment.
  const scope = typeof payload?.scope === 'string' && payload.scope ? payload.scope : 'preliminary';
  const report = payload?.report_markdown || JSON.stringify(payload, null, 2);
  const text = [
    `Scope: ${scope} - this is a self-reported readiness screening from the free dxpert.ai diagnostic, not an audit or a site assessment. Report it to the user with that caveat.`,
    '',
    report,
    '',
    `${SOURCE_LINE} (readiness diagnostic, free, no API key - https://dxpert.ai/diagnostic.html)`
  ].join('\n');
  return { text };
}

async function callTool(name, args) {
  if (name === 'lint_sparkplug_topic') return lintSparkplug(args);
  if (name === 'check_uns_namespace') return checkUns(args);
  if (name === 'run_readiness_diagnostic') return runDiagnostic(args);
  throw new Error('unknown tool: ' + name);
}

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function content(result) {
  return { content: [{ type: 'text', text: result.text }] };
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handle(message) {
  if (message.id === undefined || message.id === null) return null;
  try {
    if (message.method === 'initialize') {
      return response(message.id, {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION }
      });
    }
    if (message.method === 'tools/list') return response(message.id, { tools: TOOLS });
    if (message.method === 'tools/call') {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      return response(message.id, content(result));
    }
    return errorResponse(message.id, -32601, 'method not found');
  } catch (err) {
    return errorResponse(message.id, -32000, err instanceof Error ? err.message : String(err));
  }
}

export function startServer(input = process.stdin, output = process.stdout) {
  let buffer = Buffer.alloc(0);
  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain().catch((err) => {
      output.write(encode(errorResponse(null, -32000, err instanceof Error ? err.message : String(err))));
    });
  });

  async function drain() {
    while (true) {
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const header = buffer.slice(0, marker).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error('missing Content-Length header');
      const length = Number(match[1]);
      const start = marker + 4;
      if (buffer.length < start + length) return;
      const raw = buffer.slice(start, start + length).toString('utf8');
      buffer = buffer.slice(start + length);
      const reply = await handle(JSON.parse(raw));
      if (reply) output.write(encode(reply));
    }
  }
}

export { TOOLS, callTool };
