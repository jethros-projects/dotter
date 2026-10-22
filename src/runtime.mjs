const MINIMUMS = new Map([[22, [23, 4]], [24, [22, 1]], [26, [12, 1]]]);

/** Internal startup gate: npm's engines warning does not prevent execution. */
export function assertSupportedNode(version = process.versions.node) {
  const parts = typeof version === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)
    ? version.split('.').map(Number) : [];
  const [major, minor, patch] = parts;
  const minimum = MINIMUMS.get(major);
  const canonical = parts.length === 3 && parts.every(Number.isSafeInteger) && version === parts.join('.');
  if (canonical && minimum
    && (minor > minimum[0] || minor === minimum[0] && patch >= minimum[1])) return;

  const found = canonical ? version : 'unknown';
  const error = new Error(`Dotter requires a security-patched Node.js release: 22.23.4+, 24.22.1+, or 26.12.1+ on the corresponding major. Found Node.js ${found}. Upgrade Node.js: https://nodejs.org/en/download`);
  error.code = 'UNSUPPORTED_NODE_VERSION';
  throw error;
}

assertSupportedNode();
