/**
 * @dxpert/uns-tools test runner
 *
 * Drives the real stdio MCP server over Content-Length framed JSON-RPC,
 * exactly the way an MCP client would. The diagnostic endpoint is mocked on
 * localhost - production is never called from tests.
 *
 * Covers:
 *   1. MCP handshake + tools/list
 *   2. lint_sparkplug_topic (local, no network)
 *   3. check_uns_namespace (local, no network)
 *   4. run_readiness_diagnostic against the mock, incl. the source header,
 *      the absence of any API key, and honest pass-through of `scope`
 *   5. Parity: vendored logic == the standalone validator packages
 *   6. The whole server running with NO environment variables at all
 */

import assert from 'assert';
import http from 'http';
import { spawn } from 'child_process';
import { once } from 'events';

// The originals, read straight out of the sibling packages...
import { lintTopic as sourceLintTopic } from '../../sparkplug-topic-lint/src/index.js';
import { checkNamespace as sourceCheckNamespace } from '../../uns-naming-check/src/index.js';
// ...and the vendored copies this server actually ships with.
import { lintTopic as vendoredLintTopic } from '../src/sparkplug-topic-lint.js';
import { checkNamespace as vendoredCheckNamespace } from '../src/uns-naming-check.js';

const packageDir = new URL('..', import.meta.url);

// ---------------------------------------------------------------- mock API
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    seen.push({
      url: req.url,
      key: req.headers['x-api-key'],
      auth: req.headers['authorization'],
      source: req.headers['x-dxpert-source'],
      body: JSON.parse(body || '{}')
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/diagnostic') {
      res.end(JSON.stringify({
        scores: { axes: { uns_state: 1 }, acatech_stage: 2, ai_readiness_gate: ['uns_state'], confidence: 0.7 },
        report_markdown: 'diag ok',
        scope: 'preliminary'
      }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

// ------------------------------------------------------------- MCP client
function connect(env) {
  const child = spawn(process.execPath, ['bin/uns-tools-mcp.js'], {
    cwd: packageDir,
    env,
    stdio: ['pipe', 'pipe', 'inherit']
  });

  let buffer = Buffer.alloc(0);
  const replies = [];
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const header = buffer.slice(0, marker).toString('ascii');
      const len = Number(/content-length:\s*(\d+)/i.exec(header)[1]);
      const start = marker + 4;
      if (buffer.length < start + len) return;
      replies.push(JSON.parse(buffer.slice(start, start + len).toString('utf8')));
      buffer = buffer.slice(start + len);
    }
  });

  function send(message) {
    const payload = Buffer.from(JSON.stringify(message));
    child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    child.stdin.write(payload);
  }

  async function next() {
    for (let i = 0; i < 100; i++) {
      if (replies.length) return replies.shift();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('timed out waiting for MCP reply');
  }

  async function close() {
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  }

  return { send, next, close };
}

async function call(client, id, name, args) {
  client.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  return client.next();
}

function textOf(reply) {
  assert.ok(!reply.error, `unexpected MCP error: ${JSON.stringify(reply.error)}`);
  return reply.result.content[0].text;
}

// ============================================================ main session
// A normal session: only DXPERT_API_BASE is set, pointing at the mock.
const main = connect({ ...process.env, DXPERT_API_BASE: `http://127.0.0.1:${port}` });

main.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
let r = await main.next();
assert.strictEqual(r.result.serverInfo.name, '@dxpert/uns-tools');
assert.strictEqual(r.result.serverInfo.version, '0.1.0');
assert.strictEqual(r.result.protocolVersion, '2024-11-05');

main.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
r = await main.next();
const tools = r.result.tools;
assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['check_uns_namespace', 'lint_sparkplug_topic', 'run_readiness_diagnostic']);
// Every tool description must tell a model when to use it and that it is free.
for (const tool of tools) {
  assert.ok(tool.description.length > 200, `${tool.name} description is too thin to steer a model`);
  assert.match(tool.description, /[Ff]ree/, `${tool.name} must say it is free`);
  assert.ok(tool.inputSchema && tool.inputSchema.type === 'object');
}

// -------------------------------------------------- 2. Sparkplug B linting
// A deliberately bad set: wrong namespace case, lowercase message type, a
// node message carrying a device_id, and a publish-side wildcard.
const badTopics = [
  'spBv1.0/Montreal/ddata/Line-1/Press-01',
  'spBv1.0/Montreal/NDATA/Edge-1/Press-01',
  'spbv1.0/Montreal/DDATA/Edge-1/Press-01',
  'spBv1.0/Montreal/+/Edge-1'
];
let out = textOf(await call(main, 3, 'lint_sparkplug_topic', { topics: badTopics }));
assert.match(out, /4 topic\(s\) checked, 4 with error\(s\)/);
assert.match(out, /is not a Sparkplug B message type/);
assert.match(out, /Message types are upper-case: did you mean DDATA\?/);
assert.match(out, /node-level message - it must not carry a device_id/);
assert.match(out, /namespace is case-sensitive/);
assert.match(out, /MQTT wildcards are for subscriptions only/);
assert.match(out, /Source: dxpert\.ai/);

// A single string, and a valid topic.
out = textOf(await call(main, 4, 'lint_sparkplug_topic', { topics: 'spBv1.0/Montreal/DDATA/Edge-1/Press-01' }));
assert.match(out, /1 topic\(s\) checked, 0 with error\(s\)/);
assert.match(out, /Well-formed Sparkplug B device topic/);
assert.match(out, /\[PARSED\] group_id = Montreal/);
assert.ok(!out.includes('<code>'), 'findings must be rendered as plain text for the model');

// The legacy Sparkplug 2.2 STATE form is a warning, not an error.
out = textOf(await call(main, 5, 'lint_sparkplug_topic', { topics: 'STATE/scada-host-01' }));
assert.match(out, /legacy Sparkplug 2\.2 STATE form/);
assert.match(out, /0 with error\(s\)/);

// Bad input is a clean tool error, not a crash.
r = await call(main, 6, 'lint_sparkplug_topic', { topics: [] });
assert.ok(r.error, 'empty topic list must be an error');
assert.match(r.error.message, /empty/i);

// --------------------------------------------------- 3. UNS naming checks
const badPaths = [
  'Acme/Montreal/Line-1/Press-01',
  'Acme/montreal/Line-1/Press-02',
  'Acme/Montreal/line_2/PressThree/extra',
  'Acme/Montreal/Line 3/Press 04',
  'Acme/Montreal/Line-1/Press-01'
];
out = textOf(await call(main, 7, 'check_uns_namespace', { topics: badPaths }));
assert.match(out, /UNS namespace convention check - 5 path\(s\)/);
assert.match(out, /Case-collision: Acme\/Montreal vs Acme\/montreal/);
assert.match(out, /Duplicate path: Acme\/Montreal\/Line-1\/Press-01/);
assert.match(out, /contains whitespace/);
assert.match(out, /Inconsistent depth/);
assert.match(out, /Source: dxpert\.ai/);

// Newline-delimited single string is accepted too, and a clean set passes.
out = textOf(await call(main, 8, 'check_uns_namespace', { topics: 'Acme/Montreal/Line-1/Press-01\nAcme/Montreal/Line-1/Press-02\n' }));
assert.match(out, /\[VALID\] No issues found\. 2 path\(s\)/);

// ------------------------------------------------- 4. readiness diagnostic
const intake = {
  sector: 'discrete_mfg',
  site_count: 3,
  data_off_floor: 'scada_only',
  common_model: 'per_system',
  realtime_visibility: 'on_request',
  historian_depth: 'local',
  edge_vs_poll: 'poll',
  uns_state: 'point_to_point',
  data_ready_for_use_case: 'no',
  otit_security: 'partial',
  data_ownership: 'tribal',
  ai_ambition: { text: 'Predict downtime on the press line.', target: 'pilot' },
  prior_attempts: 'A stalled MES rollout.',
  personal_stakes: 'The plant manager owns the number.',
  who_they_trust: 'The maintenance lead.',
  politically_useful: 'A visible win before budget season.'
};
out = textOf(await call(main, 9, 'run_readiness_diagnostic', { intake }));
assert.match(out, /diag ok/);
// Scope is surfaced honestly rather than quietly dropped.
assert.match(out, /^Scope: preliminary - this is a self-reported readiness screening/m);
assert.match(out, /not an audit/);
assert.match(out, /Source: dxpert\.ai/);

assert.strictEqual(seen.length, 1, 'only the diagnostic tool may touch the network');
assert.strictEqual(seen[0].url, '/api/diagnostic');
assert.deepStrictEqual(seen[0].body, intake);
// The whole point of this server: no key is sent, and traffic is attributable.
assert.strictEqual(seen[0].key, undefined, 'the no-key server must never send an API key');
assert.strictEqual(seen[0].auth, undefined, 'the no-key server must never send an Authorization header');
assert.strictEqual(seen[0].source, 'mcp-uns-tools');

r = await call(main, 10, 'run_readiness_diagnostic', { intake: 'not-an-object' });
assert.ok(r.error);
assert.match(r.error.message, /intake must be an object/);

// Unknown tools fail cleanly.
r = await call(main, 11, 'no_such_tool', {});
assert.ok(r.error);
assert.match(r.error.message, /unknown tool/);

await main.close();

// ================================= 5. parity with the standalone packages
// The vendored copies must produce byte-identical findings to the packages
// they were copied from, or the free web tools and this server would disagree.
assert.deepStrictEqual(
  badTopics.map((t) => sourceLintTopic(t)),
  badTopics.map((t) => vendoredLintTopic(t))
);
assert.deepStrictEqual(sourceCheckNamespace(badPaths), vendoredCheckNamespace(badPaths));
// Spot-check that the shared input really is a "bad" one, so parity is not
// trivially true over two empty result sets.
assert.ok(sourceLintTopic(badTopics[0]).some((f) => f.kind === 'fail'));
assert.ok(sourceCheckNamespace(badPaths).some((f) => f.kind === 'fail'));

// ======================================== 6. NO ENVIRONMENT VARIABLES AT ALL
// The headline promise: a bare `node bin/uns-tools-mcp.js` with an empty
// environment starts, handshakes, lists tools, and runs the local validators.
const bare = connect({});
bare.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'no-env', version: '0' } } });
r = await bare.next();
assert.strictEqual(r.result.serverInfo.name, '@dxpert/uns-tools');

bare.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
r = await bare.next();
assert.deepStrictEqual(r.result.tools.map((t) => t.name).sort(), ['check_uns_namespace', 'lint_sparkplug_topic', 'run_readiness_diagnostic']);

out = textOf(await call(bare, 3, 'lint_sparkplug_topic', { topics: 'spBv1.0/Montreal/NDATA/Edge-1' }));
assert.match(out, /Well-formed Sparkplug B node topic/);
out = textOf(await call(bare, 4, 'check_uns_namespace', { topics: ['Acme/Montreal/Line-1/Press-01', 'Acme/montreal/Line-1/Press-02'] }));
assert.match(out, /Case-collision/);
await bare.close();

assert.strictEqual(seen.length, 1, 'the no-env session must not have called the network');

server.close();

console.log('ok - MCP handshake, 3 no-key tools, source-package parity, and a no-env-vars start all passed');
