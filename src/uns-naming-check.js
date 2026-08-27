/**
 * VENDORED COPY - do not edit here in isolation.
 *
 * This file is a verbatim copy of the pure logic in the standalone package
 * @dxpert/uns-naming-check (src/index.js), inlined so that @dxpert/uns-tools
 * has ZERO runtime dependencies and works fully offline.
 *
 * Kept in sync with @dxpert/uns-naming-check. If you change the namespace
 * convention rules, change them in that package first and re-copy the file
 * here so both surfaces produce identical findings for identical input.
 *
 * Source of the verdict: dxpert.ai
 */

/**
 * uns-naming-check
 *
 * Pure, dependency-free logic for checking a set of Unified Namespace (UNS)
 * topic paths for the things that quietly rot a namespace over time:
 * inconsistent depth, mixed casing styles, spaces, case-collisions between
 * siblings, duplicate paths, and stray MQTT wildcards.
 *
 * No DOM, no globals, no dependencies. Safe to use in a browser, in Node,
 * or bundled into any tool.
 */

/**
 * Classify the casing style of a single path segment.
 * @param {string} s
 * @returns {string} one of: kebab-case, snake_case, UPPER, PascalCase,
 *   camelCase, Title-Case, lower, mixed/other
 */
export function caseStyle(s) {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(s)) return 'kebab-case';
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(s)) return 'snake_case';
  if (/^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)*$/.test(s)) return 'UPPER';
  if (/^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(s)) return 'PascalCase';
  if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(s)) return 'camelCase';
  if (/^[A-Z][a-z0-9]*(?:[-_](?:[A-Z][a-z0-9]*|[0-9]+))*$/.test(s)) return 'Title-Case';
  if (/^[a-z0-9]+$/.test(s)) return 'lower';
  return 'mixed/other';
}

/**
 * @typedef {Object} Finding
 * @property {'fail'|'warn'|'pass'|'info'} kind
 * @property {string} label
 * @property {string} message  May contain simple `<code>...</code>` markup.
 */

/**
 * Check a set of UNS topic paths for namespace convention problems.
 *
 * @param {string[]} paths  Topic paths, already split into an array
 *   (one entry per line). Blank entries are ignored.
 * @returns {Finding[]} Ordered list of findings, starting with a summary
 *   pass/warn/fail line and ending with a SUMMARY info line. Empty input
 *   yields a single 'fail' finding.
 */
export function checkNamespace(paths) {
  const lines = (paths || []).map((s) => (s == null ? '' : String(s).trim())).filter(Boolean);
  if (!lines.length) {
    return [{ kind: 'fail', label: 'ERROR', message: 'No paths to check. Provide topic paths, one per line.' }];
  }

  const out = [];
  const depths = {};
  const styles = {};
  const seen = {};
  const dups = {};
  const caseMap = {};
  const collisions = {};
  let errN = 0;
  let warnN = 0;

  lines.forEach((p, i) => {
    const where = `Line ${i + 1} <code>${p}</code>`;

    if (/[+#]/.test(p)) {
      out.push({ kind: 'fail', label: 'ERROR', message: `${where}: contains an MQTT wildcard (<code>+</code>/<code>#</code>) - never valid in a stored namespace path.` });
      errN++;
    }

    const parts = p.split('/');
    if (parts.some((x) => x === '')) {
      out.push({ kind: 'fail', label: 'ERROR', message: `${where}: empty level (leading/trailing or double slash).` });
      errN++;
      return;
    }

    depths[parts.length] = (depths[parts.length] || 0) + 1;

    if (seen[p]) {
      if (!dups[p]) {
        out.push({ kind: 'warn', label: 'WARN', message: `Duplicate path: <code>${p}</code> appears more than once.` });
        warnN++;
        dups[p] = 1;
      }
    }
    seen[p] = 1;

    // Case-collisions at every node level, not just full paths.
    const acc = [];
    parts.forEach((seg) => {
      acc.push(seg);
      const node = acc.join('/');
      const lower = node.toLowerCase();
      if (caseMap[lower] && caseMap[lower] !== node && !collisions[lower]) {
        out.push({ kind: 'fail', label: 'ERROR', message: `Case-collision: <code>${caseMap[lower]}</code> vs <code>${node}</code>. MQTT topics are case-sensitive - these read as one namespace but are two.` });
        errN++;
        collisions[lower] = 1;
      }
      if (!caseMap[lower]) caseMap[lower] = node;
    });

    parts.forEach((seg) => {
      if (/\s/.test(seg)) {
        out.push({ kind: 'warn', label: 'WARN', message: `${where}: segment <code>${seg}</code> contains whitespace - prefer <code>-</code> or <code>_</code>.` });
        warnN++;
      }
      const st = caseStyle(seg);
      styles[st] = (styles[st] || 0) + 1;
    });
  });

  const depthKeys = Object.keys(depths);
  if (depthKeys.length > 1) {
    out.push({
      kind: 'warn',
      label: 'WARN',
      message: `Inconsistent depth: ${depthKeys.map((d) => `${depths[d]} path(s) at ${d} levels`).join(', ')}. A UNS aligned to ISA-95 usually keeps one consistent depth (e.g. Enterprise/Site/Area/Line/Unit) with clear rules for shallower nodes.`,
    });
    warnN++;
  }

  const namedStyles = Object.keys(styles);
  if (namedStyles.length > 2) {
    out.push({
      kind: 'warn',
      label: 'WARN',
      message: `Mixed naming styles across segments: ${namedStyles.map((k) => `${k} (${styles[k]})`).join(', ')}. Pick one convention and enforce it - consistency is the whole point of a namespace.`,
    });
    warnN++;
  }

  if (!errN && !warnN) {
    out.unshift({ kind: 'pass', label: 'VALID', message: `No issues found. ${lines.length} path(s), consistent depth, one naming style.` });
  } else {
    out.unshift({
      kind: errN ? 'fail' : 'warn',
      label: errN ? 'ISSUES' : 'REVIEW',
      message: `${lines.length} path(s) checked - ${errN} error(s), ${warnN} warning(s).`,
    });
  }

  out.push({
    kind: 'info',
    label: 'SUMMARY',
    message: `${Object.keys(seen).length} unique path(s) - depth(s): ${depthKeys.join(', ')} - styles: ${namedStyles.join(', ')}`,
  });

  return out;
}

/**
 * Convenience wrapper: split raw multi-line text into paths and check.
 * @param {string} rawText
 * @returns {Finding[]}
 */
export function checkNamespaceText(rawText) {
  const lines = (rawText || '').split(/\r?\n/);
  return checkNamespace(lines);
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
