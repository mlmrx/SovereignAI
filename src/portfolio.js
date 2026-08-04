/**
 * Personal Context Portfolio — the seed crystal.
 *
 * One human-readable markdown document holding the durable context a user
 * would otherwise lose in a switch: who they are (memories, with provenance),
 * how they shaped their AI (personas), and what their AI knows (knowledge
 * inventory). Made to be pasted into ANY tool — another assistant's custom
 * instructions, a ChatGPT memory import, a Claude project — not just restored
 * into SovereignAI. Import doors into other platforms are one-way by design;
 * this is the export door they don't build.
 *
 * It is deliberately NOT a backup: conversations and document contents stay
 * out (that's `sovereign export`). The portfolio is the distilled layer.
 */

export function buildPortfolio(store, config, version) {
  const memories = store.listMemories();
  const personas = store.listPersonas();
  const documents = store.listDocuments();
  const generatedAt = new Date().toISOString();

  const lines = [];
  lines.push(`# Personal Context Portfolio — ${config.name || 'My AI'}`);
  lines.push('');
  lines.push(
    `Generated ${generatedAt.slice(0, 10)} by SovereignAI v${version} from data the owner controls. ` +
      'Paste the parts you want into any AI tool. This document is the portable, distilled context layer — ' +
      'conversations and document contents are not included (use `sovereign export` for a full backup).'
  );
  lines.push('');

  lines.push('## Durable memory');
  lines.push('');
  if (!memories.length) {
    lines.push('_No memories recorded yet._');
  } else {
    const groups = [
      { label: 'Recorded by the owner', match: (m) => m.origin === 'manual' },
      { label: 'Auto-extracted from live chats', match: (m) => m.origin === 'extracted' },
      { label: 'Distilled from imported history', match: (m) => m.origin === 'distilled' },
      { label: 'Recorded before provenance tracking (origin unknown)', match: (m) => !m.origin },
    ];
    for (const group of groups) {
      const rows = memories.filter(group.match);
      if (!rows.length) continue;
      lines.push(`### ${group.label}`);
      lines.push('');
      for (const memory of rows) lines.push(`- ${memoryLine(store, memory)}`);
      lines.push('');
    }
  }

  lines.push('## Personas (how the AI was shaped)');
  lines.push('');
  if (!personas.length) {
    lines.push('_No personas defined._');
    lines.push('');
  }
  for (const persona of personas) {
    lines.push(`### ${persona.name}`);
    if (persona.description) lines.push(`\n${persona.description.trim()}`);
    const runtime = [persona.provider, persona.model].filter(Boolean).join(' / ');
    lines.push('');
    if (runtime) lines.push(`- Preferred runtime: ${runtime}`);
    lines.push(`- Uses memory: ${persona.use_memory ? 'yes' : 'no'} · uses knowledge: ${persona.use_knowledge ? 'yes' : 'no'}`);
    lines.push('');
    lines.push('System prompt:');
    lines.push('');
    const prompt = persona.system_prompt.trim();
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(prompt) + 1));
    lines.push(fence);
    lines.push(prompt);
    lines.push(fence);
    lines.push('');
  }

  lines.push('## Knowledge base inventory');
  lines.push('');
  if (!documents.length) {
    lines.push('_No documents ingested._');
  } else {
    lines.push('Document contents are not exported here; this is the list of what the AI can retrieve from.');
    lines.push('');
    for (const doc of documents) {
      lines.push(`- ${doc.name} (${formatBytes(doc.size)}, added ${String(doc.created_at).slice(0, 10)})`);
    }
  }
  lines.push('');

  const counts = { memories: memories.length, personas: personas.length, documents: documents.length };
  lines.push('---');
  lines.push('');
  lines.push(
    `_${counts.memories} memories · ${counts.personas} personas · ${counts.documents} documents. ` +
      'This file contains personal context — treat it like a diary, not a config file._'
  );
  lines.push('');

  return { markdown: lines.join('\n'), counts, generatedAt };
}

function memoryLine(store, memory) {
  const content = memory.content.replace(/\s*\n\s*/g, ' ').trim();
  const notes = [];
  const date = String(memory.created_at).slice(0, 10);
  if (date) notes.push(date);
  if (memory.source_conversation_id) {
    const conversation = store.getConversation(memory.source_conversation_id);
    if (conversation?.title) notes.push(`from "${conversation.title.slice(0, 80)}"`);
    else if (conversation) notes.push('from a saved conversation');
    else notes.push('from a since-deleted conversation');
  }
  if (memory.updated_at) notes.push(`edited ${String(memory.updated_at).slice(0, 10)}`);
  return notes.length ? `${content} _(${notes.join(', ')})_` : content;
}

function longestBacktickRun(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '? B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
