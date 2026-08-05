import { distillConversationMemories } from './memory-extract.js';

/**
 * SSE orchestration for distilling durable memories out of imported chat
 * history — the streamed counterpart to the CLI's `sovereign distill`, built
 * for the Arrival experience and the Mind view where the user watches
 * memories ignite as they're extracted.
 *
 * Same contract as the CLI sweep: sequential (one model call per
 * conversation, progress stays readable, local providers aren't flooded),
 * idempotent (a swept conversation is marked distilled_at even when nothing
 * durable was found), and honest about failure (the first provider error
 * stops the run and is reported; the conversation that failed is NOT marked,
 * so a re-run resumes exactly there).
 *
 * Events: `meta` {total, provider, model} → `conversation` {index, total,
 * conversationId, title, facts[]} per sweep → `done` {conversations,
 * memoriesAdded, remaining} or `error` {message, completed}.
 */

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 500;

export async function handleDistill({ store, config, body, sse, signal }) {
  const limit = boundedLimit(body?.limit);
  const all = store.listDistillableConversations();
  const batch = all.slice(0, limit);
  const provider = config.defaults.provider;
  const model = config.defaults.model || '';

  sse.send('meta', { total: batch.length, pending: all.length, provider, model });
  if (!batch.length) {
    sse.send('done', { conversations: 0, memoriesAdded: 0, remaining: 0 });
    sse.end();
    return;
  }

  let done = 0;
  let memoriesAdded = 0;
  for (const [index, conversation] of batch.entries()) {
    if (signal?.aborted) return; // client left — stop cleanly, nothing half-marked
    let facts;
    try {
      facts = await distillConversationMemories({
        store,
        config,
        conversation,
        messages: store.listMessages(conversation.id),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      sse.send('error', { message: err.message, conversationId: conversation.id, completed: done });
      sse.end();
      return;
    }
    store.markConversationDistilled(conversation.id);
    done++;
    memoriesAdded += facts.length;
    sse.send('conversation', {
      index: index + 1,
      total: batch.length,
      conversationId: conversation.id,
      title: conversation.title?.slice(0, 120) || '',
      facts,
    });
  }
  sse.send('done', { conversations: done, memoriesAdded, remaining: all.length - done });
  sse.end();
}

function boundedLimit(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}
