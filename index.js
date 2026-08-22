/**
 * OMP Tool Harness Repair Plugin
 * Inspired by Command Code's "Validate-then-Repair" strategy
 * https://commandcode.ai/blog/how-did-we-make-deepseek-outperform-claude-opus-4.7
 */

function repairInput(rawInput) {
 if (!rawInput || typeof rawInput !== 'object') return rawInput;

 const input = JSON.parse(JSON.stringify(rawInput));

 // ponytail: bare-string→array needs schema; only wrap keys that look like arrays, blocklist content-like keys
 const CONTENT_KEYS = new Set(['content', 'text', 'body', 'message', 'command', 'filePath', 'path', 'absolutePath', 'url', 'file', 'input']);

 for (const key of Object.keys(input)) {
  let value = input[key];

  if (value === null || value === undefined) {
   delete input[key];
   continue;
  }

  if (typeof value === 'string') {
   // Fix 2: degenerate markdown auto-link only — [notes.md](http://notes.md) → notes.md
   // Real markdown [click](https://x.com) must pass through untouched.
   value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, (match, text, url) => {
    const urlWithoutProtocol = url.replace(/^https?:\/\//, '');
    if (text === urlWithoutProtocol || text === url) return text;
    return match;
   });

   // Fix 3: JSON stringified array → real array (must run before bare-string wrap)
   if (value.trim().startsWith('[') && value.trim().endsWith(']')) {
    try {
     const parsed = JSON.parse(value);
     if (Array.isArray(parsed)) {
      value = parsed;
      input[key] = value;
      continue;
     }
    } catch (_) { }
   }

   // Fix 4: bare string where array expected → [string]
   // Eager repair can't know schema; heuristic: only wrap if key hints at array and not a content key.
   // validate-then-repair with Zod issue paths is the correct gate; this is a safe eager fallback.
   if (!CONTENT_KEYS.has(key) && typeof value === 'string' && value.length > 0) {
    // leave valid inputs untouched: only wrap if caller likely expects array.
    // Heuristic: key is plural or known array suffix — prevents corrupting "content: hello world".
    const looksLikeArrayKey = /s$|List$|Array$|Paths?$|Files?$|Ids?$|Items?$|Tags?$|Names?$/.test(key);
    // If we have Zod issue context, wrap unconditionally; eagerly, only wrap on hint.
    if (looksLikeArrayKey) {
     // Don't wrap if it already looks like a path or sentence with spaces + slashes mix is still valid single element
     input[key] = [value];
     continue;
    }
   }

   input[key] = value;
  }

  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
   input[key] = [];
  }
 }

 return input;
}

// Shared bare-string wrap for validate-then-repair path (schema-driven, unconditional)
function wrapBareStringAtPath(input, path) {
 let cur = input;
 for (let i = 0; i < path.length - 1; i++) cur = cur?.[path[i]];
 if (!cur) return false;
 const last = path[path.length - 1];
 if (typeof cur[last] === 'string') {
  cur[last] = [cur[last]];
  return true;
 }
 return false;
}

function applyRelationalDefaults(toolName, input) {
 if (toolName.includes('read') || toolName.includes('file')) {
  if (input.offset !== undefined && input.limit === undefined) {
   input.limit = 2000;
  } else if (input.limit !== undefined && input.offset === undefined) {
   input.offset = 0;
  }
 }
 return input;
}

function humanizeToolError(toolName, error) {
 const rawMsg = error.message || String(error);
 if (rawMsg.includes('invalid_type') || rawMsg.includes('Expected')) {
  return [
   `[Tool Input Error in '${toolName}']`,
   `The arguments you provided contained a formatting issue that could not be automatically repaired:`,
   `Details: ${rawMsg}`,
   `Please check the tool schema and re-issue the tool call with valid types (e.g. use raw JSON arrays, no markdown links, no raw stringified JSON).`
  ].join('\n');
 }
 return `Notice: Tool '${toolName}' failed to execute.\nReason: ${rawMsg}\nPlease review your input parameters and retry.`;
}

function applyLanguageRules(toolName, input) {
 const path = input.filePath || input.path || (Array.isArray(input.args) ? input.args[0] : '');

 // Path-specific fixes (conditional)
 if (path) {
  if (path.endsWith('.go')) {
   if (input.filePath) input.filePath = input.filePath.replace(/^\.\/\.\//, './');
  }
  if (path.endsWith('.svelte')) {
   if (input.filePath) input.filePath = input.filePath.replace(/\/+/g, '/');
  }
 }

 // Shell fixes — NOT gated behind path (were previously unreachable)
 if (toolName === 'shell' && typeof input.command === 'string') {
  if (input.command.includes('go test') && !input.command.includes('./')) {
   input.command = input.command.replace('go test', 'go test ./...');
  }
  if ((input.command.includes('npm run') || input.command.includes('bun run')) && input.command.includes('svelte-check') && !input.command.includes('--')) {
   input.command = input.command.replace('svelte-check', 'svelte-check --tsconfig ./tsconfig.json');
  }
 }

 return input;
}

module.exports = {
 name: 'omp-harness-fix',
 repairInput,
 applyRelationalDefaults,
 humanizeToolError,
 applyLanguageRules,
 wrapBareStringAtPath,

 onToolCall: async ({ toolName, input }) => {
  try {
   let repairedInput = repairInput(input);
   repairedInput = applyRelationalDefaults(toolName, repairedInput);
   repairedInput = applyLanguageRules(toolName, repairedInput);
   return { input: repairedInput };
  } catch (e) {
   return { input };
  }
 },

 onToolError: async ({ toolName, error }) => {
  const friendlyMessage = humanizeToolError(toolName, error);
  return { errorOverride: friendlyMessage };
 }
};
