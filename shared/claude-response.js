// Claude writes separate content-block records for one assistant message.
// Preview and Working must assemble those blocks by the same rules. Pending
// blocks are not answers: publish only on an explicit recorded final boundary.
export const CLAUDE_RESPONSE_TEXT_LIMIT = 2 * 1024 * 1024;
export const isClaudeFinal = entry => entry?.type === "assistant"
 && ["end_turn", "stop_sequence", "max_tokens"].includes(entry.message?.stop_reason);

export function createClaudeResponseAssembler() {
 let currentId;
 /** @type {string[]} */
 let parts = [];
 let size = 0, blocked = false;
 const reset = () => { currentId = undefined; parts = []; size = 0; blocked = false; };
 return entry => {
  if (entry?.isSidechain === true) return null;
  const message = entry?.message;
  if (entry?.isApiErrorMessage === true || ["compaction", "branch_summary"].includes(entry?.type) || entry?.subtype === "compact_boundary"
   || (entry?.type === "user" && !(Array.isArray(message?.content) && message.content.length && message.content.every(block => block?.type === "tool_result")))) {
   reset(); return null;
  }
  if (entry?.type !== "assistant" || !Array.isArray(message?.content)) return null;
  const id = typeof message.id === "string" ? message.id : typeof entry.uuid === "string" ? entry.uuid : undefined;
  if (!id) return null;
  if (id !== currentId) { reset(); currentId = id; }
  const final = isClaudeFinal(entry);
  // Never reuse text from a tool-use/error message as a later final answer.
  if (message.stop_reason != null && !final) { parts = []; blocked = true; }
  if (blocked) return null;
  for (const block of message.content) {
   if (block?.type !== "text" || typeof block.text !== "string" || !block.text.trim()) continue;
   size += block.text.length + (parts.length ? 2 : 0);
   if (size > CLAUDE_RESPONSE_TEXT_LIMIT) { parts = []; blocked = true; return null; }
   parts.push(block.text);
  }
  return final && parts.length ? { key: `claude:${id}`, markdown: parts.join("\n\n") } : null;
 };
}
