/**
 * Parser for OpenAI ChatGPT's official data export (Settings → Data
 * controls → Export data), specifically the `conversations.json` file inside
 * the emailed ZIP. This is a well-documented, stable format many open-source
 * tools already parse, so this is built with real confidence — unlike the
 * BYOC GPU marketplace clients, there is no live API here to drift out from
 * under this code; the risk is entirely "did the export schema change,"
 * which is why every field access below is defensive rather than assuming
 * shape.
 *
 * Each conversation is a tree (`mapping`): every node is a message plus
 * parent/children pointers, because ChatGPT lets you regenerate a response
 * and branch. This only imports the currently-active branch (the path from
 * `current_node` back to the root) — the same conversation you'd see
 * scrolling it in ChatGPT today — not every abandoned regeneration. That's a
 * deliberate scope decision, not an oversight.
 */

import { ChatImportError, MAX_CONVERSATIONS, finalizeConversation, joinTextParts, toIso } from './shared.js';

export function detect(parsed) {
  return Array.isArray(parsed) && parsed.some((c) => c && typeof c === 'object' && isObject(c.mapping));
}

export function parse(parsed) {
  if (!Array.isArray(parsed)) throw new ChatImportError('Expected the ChatGPT export\'s conversations.json to be a JSON array');
  const warnings = [];
  const conversations = [];

  for (const [index, raw] of parsed.slice(0, MAX_CONVERSATIONS).entries()) {
    if (!isObject(raw) || !isObject(raw.mapping)) {
      warnings.push(`Skipped conversation #${index + 1}: missing a message tree ("mapping")`);
      continue;
    }
    try {
      const messages = walkActiveBranch(raw);
      if (!messages.length) {
        warnings.push(`Skipped "${raw.title || 'Untitled'}": no importable user/assistant messages found`);
        continue;
      }
      conversations.push(
        finalizeConversation({
          externalId: raw.conversation_id ?? raw.id ?? `chatgpt-${index}`,
          title: raw.title,
          createdAt: toIso(raw.create_time),
          updatedAt: toIso(raw.update_time),
          messages,
        })
      );
    } catch (err) {
      warnings.push(`Skipped "${raw.title || `conversation #${index + 1}`}": ${err.message}`);
    }
  }
  if (parsed.length > MAX_CONVERSATIONS) {
    warnings.push(`Export contains more than ${MAX_CONVERSATIONS} conversations; only the first ${MAX_CONVERSATIONS} were read`);
  }
  return { conversations, warnings };
}

function walkActiveBranch(conversation) {
  const mapping = conversation.mapping;
  const path = [];
  let nodeId = conversation.current_node;

  // Fall back to the most recently created childless leaf, if current_node is
  // absent or dangling — picking an arbitrary leaf (e.g. by key order) risks
  // landing on an abandoned regeneration branch instead of where the
  // conversation actually ends.
  if (!nodeId || !mapping[nodeId]) {
    let bestId = null;
    let bestTime = -Infinity;
    for (const [id, node] of Object.entries(mapping)) {
      if (!Array.isArray(node?.children) || node.children.length !== 0) continue;
      const time = Number(node?.message?.create_time);
      const effectiveTime = Number.isFinite(time) ? time : -Infinity;
      if (bestId === null || effectiveTime > bestTime) {
        bestId = id;
        bestTime = effectiveTime;
      }
    }
    nodeId = bestId;
  }

  const seen = new Set();
  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    path.push(nodeId);
    nodeId = mapping[nodeId].parent;
  }
  path.reverse();

  const messages = [];
  for (const id of path) {
    const message = mapping[id]?.message;
    if (!message || !isObject(message.author)) continue;
    if (message.metadata?.is_visually_hidden_from_conversation) continue;
    const role = message.author.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;

    const content = message.content;
    let text = '';
    if (Array.isArray(content?.parts)) text = joinTextParts(content.parts);
    else if (typeof content?.text === 'string') text = content.text.trim();
    if (!text) continue;

    messages.push({ role, content: text, createdAt: toIso(message.create_time) });
  }
  return messages;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
