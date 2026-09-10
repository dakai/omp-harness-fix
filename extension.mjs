/**
 * OMP/Pi extension entry for omp-harness-fix
 * Wraps the harness repair logic (index.js) as a native extension so
 * `omp plugin doctor` recognises the package (requires omp/pi manifest + extension).
 * Keeps index.js as CommonJS legacy entry for `require('omp-harness-fix')` and
 * old `onToolCall`/`onToolError` harness hooks.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
 repairInput,
 applyRelationalDefaults,
 applyLanguageRules,
 humanizeToolError,
} = require("./index.js");

export default function ompHarnessFixExtension(pi) {
 pi.on("tool_call", async (event) => {
  try {
   const input = event.input ?? {};
   let repaired = repairInput(input);
   repaired = applyRelationalDefaults(event.toolName, repaired);
   repaired = applyLanguageRules(event.toolName, repaired);
   return { input: repaired };
  } catch {
   return undefined;
  }
 });

 pi.on("tool_result", async (event) => {
  if (!event.isError) return undefined;
  try {
   const raw = Array.isArray(event.content)
    ? event.content.map((c) => (typeof c === "string" ? c : c.text ?? String(c))).join("\n")
    : String(event.content ?? event.details ?? "");
   if (raw.includes("invalid_type") || raw.includes("Expected")) {
    const friendly = humanizeToolError(event.toolName, { message: raw });
    return { content: [{ type: "text", text: friendly }] };
   }
  } catch {
   return undefined;
  }
  return undefined;
 });
}
