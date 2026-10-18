// Native q6t/J6t/Z6t in app-initial-90eb42395b7d.js (offsets 2293537+):
// Sites mutations are approved only for a canonical, reviewable change and
// cannot grant session/always approval for subsequent executions.
const SITES = 'connector_20205bf7d4e99a89d7154bb849718324';
const TOOLS = new Set(['sites.execute_database_update', 'sites.execute_database_insert', 'sites.execute_database_delete']);
const COMMON = ['approval_version', 'binding_name', 'deployment_id', 'primary_key_column', 'primary_key_value', 'project_id', 'table_name'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const emptyApprovalForm = schema => schema?.type === 'object' && object(schema.properties) && Object.keys(schema.properties).length === 0
  && (schema.required === undefined || Array.isArray(schema.required) && schema.required.length === 0);

function compareCodePoints(left, right) {
  const a = Array.from(left, ch => ch.codePointAt(0)), b = Array.from(right, ch => ch.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function canonical(value) {
  if (typeof value === 'string') return JSON.stringify(value).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort(compareCodePoints).map(key => `${canonical(key)}:${canonical(value[key])}`).join(',')}}`;
}
function validSummary(value, tool) {
  if (!object(value) || value.approval_version !== 1 || COMMON.slice(1).some(key => typeof value[key] !== 'string')) return false;
  if (tool === 'sites.execute_database_update') {
    return exactKeys(value, [...COMMON, 'column', 'new_value', 'old_value']) && typeof value.column === 'string'
      && typeof value.new_value === 'string' && (value.old_value === null || typeof value.old_value === 'string');
  }
  const operation = tool === 'sites.execute_database_insert' ? 'insert' : 'delete';
  if (!exactKeys(value, [...COMMON, 'operation', 'values']) || value.operation !== operation || !object(value.values)
      || !Object.hasOwn(value.values, value.primary_key_column)) return false;
  const entries = Object.values(value.values), primary = value.values[value.primary_key_column];
  if (operation === 'insert') return entries.every(entry => typeof entry === 'string') && primary === value.primary_key_value;
  return entries.every(entry => entry === null || typeof entry === 'string' || Number.isSafeInteger(entry))
    && primary !== null && String(primary) === value.primary_key_value;
}

export function inspectSiteApproval(params) {
  const metadata = params?._meta;
  if (params?.mode !== 'form' || params.serverName !== 'codex_apps' || !object(metadata)
      || metadata.codex_approval_kind !== 'mcp_tool_call' || metadata.connector_id !== SITES) return null;
  let tool = typeof metadata.tool_name === 'string' ? metadata.tool_name.trim() : undefined;
  const args = metadata.tool_params;
  if (!TOOLS.has(tool)) {
    if (tool || !object(args) || !Object.hasOwn(args, 'confirmation_summary') && !Object.hasOwn(args, 'plan_token')) return null;
    tool = 'sites.execute_database_update';
  }
  let summary = null;
  // Dot's card tn parser admits MCP approvals only with an empty object form.
  if (emptyApprovalForm(params.requestedSchema) && object(args) && exactKeys(args, ['confirmation_summary', 'plan_token'])
      && typeof args.plan_token === 'string' && args.plan_token.trim()
      && typeof args.confirmation_summary === 'string' && args.confirmation_summary.length <= 500) {
    try {
      const value = JSON.parse(args.confirmation_summary);
      if (validSummary(value, tool) && canonical(value) === args.confirmation_summary) summary = value;
    } catch { /* An unreviewable change remains declinable but cannot be accepted. */ }
  }
  return { executionBound: true, approvalDisabled: summary === null, approvalDetails: { toolName: tool, summary } };
}

export function inspectNativeApproval(params) {
  // The same normalized default is used when reporting and answering forms.
  if ((params?.mode ?? 'form') !== 'form' || !['mcp_tool_call', 'tool_suggestion'].includes(params?._meta?.codex_approval_kind)) return null;
  const site = inspectSiteApproval({ ...params, mode: 'form' });
  // Dot card tn applies this shape restriction to both native approval kinds,
  // regardless of connector. Decline/cancel remain available for invalid ones.
  return { ...site, approvalDisabled: !emptyApprovalForm(params.requestedSchema) || site?.approvalDisabled === true };
}
