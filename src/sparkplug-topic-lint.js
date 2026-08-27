/**
 * VENDORED COPY - do not edit here in isolation.
 *
 * This file is a verbatim copy of the pure logic in the standalone package
 * @dxpert/sparkplug-topic-lint (src/index.js), inlined so that
 * @dxpert/uns-tools has ZERO runtime dependencies and works fully offline.
 *
 * Kept in sync with @dxpert/sparkplug-topic-lint. If you change the topic
 * grammar rules, change them in that package first and re-copy the file here
 * so both surfaces produce identical findings for identical input.
 *
 * Source of the verdict: dxpert.ai
 */

/**
 * sparkplug-topic-lint
 *
 * Pure, dependency-free logic for validating MQTT topics against the
 * Sparkplug B topic grammar (Sparkplug 3.0):
 *
 *   spBv1.0/{group_id}/{message_type}/{edge_node_id}[/{device_id}]
 *   spBv1.0/STATE/{sparkplug_host_id}
 *   STATE/{scada_host_id}          (legacy Sparkplug 2.2 form)
 *
 * No DOM, no globals, no dependencies. Safe to use in a browser, in Node,
 * or bundled into any tool.
 */

export const SP_MESSAGE_TYPES = [
  'NBIRTH', 'NDEATH', 'DBIRTH', 'DDEATH', 'NDATA', 'DDATA', 'NCMD', 'DCMD',
];

/**
 * @typedef {Object} Finding
 * @property {'fail'|'warn'|'pass'|'info'} kind
 * @property {string} label   Short machine-ish tag, e.g. "ERROR", "WARN", "VALID", "PARSED".
 * @property {string} message Human-readable explanation (may contain simple
 *   inline `<code>...</code>` markup for emphasis; plain text otherwise).
 */

/**
 * @param {string} id
 * @param {string} role  e.g. "group_id", "edge_node_id", "device_id", "host_id"
 * @returns {Finding[]}
 */
function idIssues(id, role) {
  const out = [];
  if (/\s/.test(id)) {
    out.push({
      kind: 'warn',
      label: 'WARN',
      message: `The ${role} <code>${id}</code> contains whitespace. Legal in MQTT, but a reliable source of downstream pain (historians, SQL columns, file paths). Prefer <code>-</code> or <code>_</code>.`,
    });
  }
  if (/[^A-Za-z0-9_\-.]/.test(id)) {
    out.push({
      kind: 'warn',
      label: 'WARN',
      message: `The ${role} <code>${id}</code> uses characters outside <code>A-Z a-z 0-9 _ - .</code> - allowed by Sparkplug, but check every consumer in your chain can handle them.`,
    });
  }
  return out;
}

/**
 * Lint a single MQTT topic string against the Sparkplug B grammar.
 *
 * @param {string} rawTopic
 * @returns {Finding[]} Ordered list of findings. Empty input always yields
 *   exactly one 'fail' finding. A structurally valid topic yields a leading
 *   'pass' finding plus a trailing 'info' finding with the parsed parts.
 */
export function lintTopic(rawTopic) {
  const raw = rawTopic == null ? '' : String(rawTopic);
  const out = [];
  const t = raw.trim();

  if (raw !== t && t) {
    out.push({
      kind: 'warn',
      label: 'WARN',
      message: 'Leading or trailing whitespace was ignored for this lint - but a real publisher would create a different topic. Trim it.',
    });
  }

  if (!t) {
    return [{ kind: 'fail', label: 'ERROR', message: 'No topic to lint. Provide a topic string.' }];
  }

  if (/[+#]/.test(t)) {
    out.push({
      kind: 'fail',
      label: 'ERROR',
      message: 'Topic contains <code>+</code> or <code>#</code>. MQTT wildcards are for subscriptions only - a published Sparkplug topic must never contain them.',
    });
  }

  const parts = t.split('/');
  if (parts.some((p) => p === '')) {
    out.push({
      kind: 'fail',
      label: 'ERROR',
      message: 'Empty topic level (a leading/trailing slash or a double slash <code>//</code>). Every level must have a name.',
    });
    return out;
  }

  // Legacy Sparkplug 2.2 STATE form: STATE/{scada_host_id}
  if (parts[0] === 'STATE') {
    if (parts.length === 2) {
      out.push({
        kind: 'warn',
        label: 'WARN',
        message: `This is the legacy Sparkplug 2.2 STATE form (<code>STATE/{scada_host_id}</code>). Sparkplug 3.0 moved it under the namespace: <code>spBv1.0/STATE/${parts[1]}</code>.`,
      });
      out.push(...idIssues(parts[1], 'host_id'));
      out.push({ kind: 'info', label: 'PARSED', message: `Legacy STATE message - host_id = <code>${parts[1]}</code>` });
    } else {
      out.push({
        kind: 'fail',
        label: 'ERROR',
        message: `Legacy STATE form must be exactly <code>STATE/{scada_host_id}</code> (2 levels) - got ${parts.length}.`,
      });
    }
    return out;
  }

  if (parts[0] !== 'spBv1.0') {
    const hint = parts[0].toLowerCase() === 'spbv1.0'
      ? ' The namespace is case-sensitive - it must be exactly <code>spBv1.0</code>.'
      : '';
    out.push({
      kind: 'fail',
      label: 'ERROR',
      message: `First level must be the namespace <code>spBv1.0</code> - got <code>${parts[0]}</code>.${hint}`,
    });
  }

  // Sparkplug 3.0 STATE: spBv1.0/STATE/{sparkplug_host_id}
  if (parts[1] === 'STATE') {
    if (parts.length !== 3) {
      out.push({
        kind: 'fail',
        label: 'ERROR',
        message: `A Sparkplug 3.0 STATE topic must be exactly <code>spBv1.0/STATE/{sparkplug_host_id}</code> (3 levels) - got ${parts.length}.`,
      });
    } else {
      const idProblems = idIssues(parts[2], 'sparkplug_host_id');
      out.push(...idProblems);
      if (!out.some((f) => f.kind === 'fail')) {
        out.push({ kind: 'pass', label: 'VALID', message: 'Well-formed Sparkplug 3.0 STATE topic.' });
      }
      out.push({ kind: 'info', label: 'PARSED', message: `STATE message - host_id = <code>${parts[2]}</code>` });
    }
    return out;
  }

  if (parts.length < 4 || parts.length > 5) {
    out.push({
      kind: 'fail',
      label: 'ERROR',
      message: `A Sparkplug B topic has 4 levels (node message) or 5 (device message): <code>spBv1.0/{group_id}/{message_type}/{edge_node_id}[/{device_id}]</code> - got ${parts.length}.`,
    });
    if (parts.length > 1 && SP_MESSAGE_TYPES.indexOf(parts[1]) > -1) {
      out.push({
        kind: 'fail',
        label: 'ERROR',
        message: `<code>${parts[1]}</code> is in the group_id position. The message type is the third level, after the group_id.`,
      });
    }
    return out;
  }

  const group = parts[1];
  const mtype = parts[2];
  const node = parts[3];
  const dev = parts[4];

  if (SP_MESSAGE_TYPES.indexOf(mtype) === -1) {
    const upper = mtype.toUpperCase();
    let hint2 = '';
    if (SP_MESSAGE_TYPES.indexOf(upper) > -1) {
      hint2 = ` Message types are upper-case: did you mean <code>${upper}</code>?`;
    } else if (upper === 'DATA') {
      hint2 = ' There is no plain <code>DATA</code> type - use <code>NDATA</code> (node) or <code>DDATA</code> (device).';
    } else if (upper === 'BIRTH') {
      hint2 = ' There is no plain <code>BIRTH</code> type - use <code>NBIRTH</code> or <code>DBIRTH</code>.';
    }
    out.push({
      kind: 'fail',
      label: 'ERROR',
      message: `<code>${mtype}</code> is not a Sparkplug B message type. Valid: ${SP_MESSAGE_TYPES.join(', ')}, STATE.${hint2}`,
    });
  } else {
    if (mtype.charAt(0) === 'N' && parts.length === 5) {
      out.push({
        kind: 'fail',
        label: 'ERROR',
        message: `<code>${mtype}</code> is a node-level message - it must not carry a device_id. Drop <code>/${dev}</code> or use <code>D${mtype.slice(1)}</code>.`,
      });
    }
    if (mtype.charAt(0) === 'D' && parts.length === 4) {
      out.push({
        kind: 'fail',
        label: 'ERROR',
        message: `<code>${mtype}</code> is a device-level message - it requires a device_id as the 5th level, or use <code>N${mtype.slice(1)}</code>.`,
      });
    }
  }

  out.push(...idIssues(group, 'group_id'));
  out.push(...idIssues(node, 'edge_node_id'));
  if (dev) out.push(...idIssues(dev, 'device_id'));

  const hasErr = out.some((f) => f.kind === 'fail');
  if (!hasErr) {
    out.unshift({
      kind: 'pass',
      label: 'VALID',
      message: `Well-formed Sparkplug B ${dev ? 'device' : 'node'} topic.`,
    });
  }
  out.push({
    kind: 'info',
    label: 'PARSED',
    message: `group_id = <code>${group}</code> - message = <code>${mtype}</code> - edge_node = <code>${node}</code>${dev ? ` - device = <code>${dev}</code>` : ''}`,
  });

  return out;
}

/**
 * Strip the simple `<code>...</code>` markup used in Finding.message,
 * for plain-text (terminal/CLI) output.
 * @param {string} message
 * @returns {string}
 */
export function plainText(message) {
  return message.replace(/<\/?code>/g, '');
}

/**
 * @param {Finding[]} findings
 * @returns {boolean} true if any finding is a 'fail'.
 */
export function hasErrors(findings) {
  return findings.some((f) => f.kind === 'fail');
}
