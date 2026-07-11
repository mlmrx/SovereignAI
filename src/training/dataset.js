import crypto from 'node:crypto';

export const TRAINING_DATASET_SCHEMA = 'sovereignai.training-dataset/v1';

const MAX_EXAMPLES = 100_000;
const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_EXAMPLE_CHARS = 1_000_000;
const MAX_ID_CHARS = 512;
const MAX_PROVENANCE_IDS = 256;
const EXAMPLE_STATES = new Set(['draft', 'approved', 'excluded']);
const TRAINING_METHODS = new Set(['sft-lora', 'sft-qlora']);

const HYPERPARAMETER_DEFAULTS = Object.freeze({
  epochs: 3,
  learningRate: 0.0002,
  batchSize: 2,
  gradientAccumulationSteps: 8,
  loraRank: 16,
  loraAlpha: 32,
  loraDropout: 0.05,
  maxSequenceLength: 2048,
  warmupRatio: 0.03,
  weightDecay: 0,
  seed: 42,
});

const HYPERPARAMETER_ALIASES = Object.freeze({
  learning_rate: 'learningRate',
  batch_size: 'batchSize',
  gradient_accumulation_steps: 'gradientAccumulationSteps',
  lora_rank: 'loraRank',
  lora_alpha: 'loraAlpha',
  lora_dropout: 'loraDropout',
  max_sequence_length: 'maxSequenceLength',
  warmup_ratio: 'warmupRatio',
  weight_decay: 'weightDecay',
});

const HYPERPARAMETER_RULES = Object.freeze({
  epochs: { min: 1, max: 100 },
  learningRate: { min: 1e-8, max: 1 },
  batchSize: { min: 1, max: 1024, integer: true },
  gradientAccumulationSteps: { min: 1, max: 4096, integer: true },
  loraRank: { min: 1, max: 1024, integer: true },
  loraAlpha: { min: 1, max: 8192 },
  loraDropout: { min: 0, max: 1 },
  maxSequenceLength: { min: 128, max: 262_144, integer: true },
  warmupRatio: { min: 0, max: 1 },
  weightDecay: { min: 0, max: 10 },
  seed: { min: 0, max: 2_147_483_647, integer: true },
});

export class TrainingValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrainingValidationError';
  }
}

/**
 * Convert persisted conversations into reviewable SFT examples. Each complete
 * user/assistant exchange becomes one example; no workspace data is selected
 * implicitly and no provider call is made.
 */
export function buildConversationExamples({ conversations, messagesByConversation, personas }) {
  if (!Array.isArray(conversations)) fail('conversations must be an array');
  if (conversations.length > MAX_EXAMPLES) fail(`conversations may contain at most ${MAX_EXAMPLES} records`);

  const personaLookup = makeLookup(personas, 'personas');
  const messageLookup = makeMessageLookup(messagesByConversation);
  const orderedConversations = conversations
    .map((conversation, index) => ({ conversation, index }))
    .sort((a, b) => compareConversation(a.conversation, b.conversation) || a.index - b.index);

  const examples = [];
  const seen = new Set();

  for (const { conversation } of orderedConversations) {
    assertObject(conversation, 'conversation');
    const conversationId = requiredId(conversation.id, 'conversation.id');
    const personaId = nullableId(conversation.persona_id ?? conversation.personaId, 'conversation.persona_id');
    const persona = personaId ? personaLookup.get(personaId) : null;
    const systemPrompt = typeof persona?.system_prompt === 'string'
      ? persona.system_prompt
      : typeof persona?.systemPrompt === 'string'
        ? persona.systemPrompt
        : '';
    const rawMessages = messageLookup.get(conversationId) ?? [];
    if (!Array.isArray(rawMessages)) fail(`messages for conversation ${conversationId} must be an array`);

    const orderedMessages = rawMessages
      .map((message, index) => ({ message, index }))
      .sort((a, b) => compareMessage(a.message, b.message) || a.index - b.index)
      .map((entry) => entry.message);

    let pendingUser = null;
    for (const message of orderedMessages) {
      if (!isObject(message)) continue;
      const role = message.role;
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (role === 'user') {
        pendingUser = content ? message : null;
        continue;
      }
      if (role !== 'assistant' || !pendingUser || !content) continue;

      const userContent = String(pendingUser.content).trim();
      const messages = [
        ...(systemPrompt.trim() ? [{ role: 'system', content: systemPrompt.trim() }] : []),
        { role: 'user', content: userContent },
        { role: 'assistant', content },
      ];
      const example = normalizeTrainingExample({
        messages,
        state: 'draft',
        provenance: {
          sourceType: 'conversation',
          conversationId,
          conversationTitle: optionalText(conversation.title, 10_000),
          personaId,
          messageIds: [pendingUser.id, message.id].filter((id) => typeof id === 'string' && id.trim()),
        },
      });
      pendingUser = null;
      if (seen.has(example.contentHash)) continue;
      seen.add(example.contentHash);
      examples.push(example);
      if (examples.length > MAX_EXAMPLES) fail(`conversation selection produced more than ${MAX_EXAMPLES} examples`);
    }
  }

  return examples;
}

/** Normalize a manual, imported, or conversation-derived training example. */
export function normalizeTrainingExample(input, { existing = null } = {}) {
  assertObject(input, 'training example');
  if (existing !== null) assertObject(existing, 'existing training example');

  const source = { ...(existing ?? {}), ...input };
  const messages = normalizeMessages(source.messages);
  const contentHash = hashHex(stableStringify(messages));
  const id = source.id === undefined || source.id === null || source.id === ''
    ? `te_${contentHash.slice(0, 24)}`
    : requiredId(source.id, 'id');
  const state = source.state ?? 'draft';
  if (!EXAMPLE_STATES.has(state)) fail(`state must be one of: ${[...EXAMPLE_STATES].join(', ')}`);

  return {
    id,
    messages,
    provenance: normalizeProvenance(source.provenance ?? {}),
    state,
    riskFlags: detectRiskFlags(messages),
    contentHash,
  };
}

/**
 * Freeze approved examples into deterministic train/eval JSONL. All examples
 * from one conversation stay in the same split to prevent evaluation leakage.
 */
export function buildDatasetSnapshot({ project, examples, consent, createdAt = new Date().toISOString() }) {
  assertObject(project, 'project');
  if (!Array.isArray(examples)) fail('examples must be an array');
  if (examples.length > MAX_EXAMPLES) fail(`examples may contain at most ${MAX_EXAMPLES} records`);
  assertObject(consent, 'consent');
  if (consent.accepted !== true) fail('consent.accepted must be true before a dataset snapshot can be created');
  const timestamp = normalizeTimestamp(createdAt, 'createdAt');

  const projectValue = normalizeProject(project);
  const approved = [];
  const seen = new Set();
  for (const candidate of examples) {
    const example = normalizeTrainingExample(candidate);
    if (example.state !== 'approved' || seen.has(example.contentHash)) continue;
    seen.add(example.contentHash);
    approved.push(example);
  }
  if (approved.length === 0) fail('At least one approved training example is required');

  const groups = new Map();
  for (const example of approved) {
    const conversationId = example.provenance.conversationId;
    const groupId = conversationId ? `conversation:${conversationId}` : `example:${example.id}`;
    const group = groups.get(groupId) ?? [];
    group.push(example);
    groups.set(groupId, group);
  }

  const rankedGroups = [...groups.entries()]
    .map(([id, items]) => ({ id, items, rank: hashHex(`${projectValue.id}\0${id}`) }))
    .sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id));
  if (rankedGroups.length < 2) {
    fail('At least two independent conversation groups are required for leakage-safe train and eval splits');
  }
  const evalGroupCount = rankedGroups.length > 1
    ? Math.min(rankedGroups.length - 1, Math.max(1, Math.round(rankedGroups.length * 0.2)))
    : 0;
  const evalGroups = new Set(rankedGroups.slice(0, evalGroupCount).map((group) => group.id));

  const train = [];
  const evaluation = [];
  for (const group of rankedGroups) {
    const target = evalGroups.has(group.id) ? evaluation : train;
    group.items.sort((a, b) => a.id.localeCompare(b.id));
    target.push(...group.items);
  }

  const trainJsonl = toJsonl(train);
  const evalJsonl = toJsonl(evaluation);
  const counts = {
    total: train.length + evaluation.length,
    train: train.length,
    eval: evaluation.length,
    groups: rankedGroups.length,
  };
  const trainBytes = Buffer.byteLength(trainJsonl);
  const evalBytes = Buffer.byteLength(evalJsonl);
  const consentValue = cloneJson(consent, 'consent', 256 * 1024);
  const manifestCore = {
    schema: TRAINING_DATASET_SCHEMA,
    createdAt: timestamp,
    project: projectValue,
    consent: consentValue,
    split: {
      strategy: 'conversation-hash',
      seed: projectValue.id,
      evalRatio: 0.2,
      leakageProtected: true,
    },
    files: {
      train: {
        name: 'train.jsonl',
        sha256: hashHex(trainJsonl),
        bytes: trainBytes,
        records: train.length,
      },
      eval: {
        name: 'eval.jsonl',
        sha256: hashHex(evalJsonl),
        bytes: evalBytes,
        records: evaluation.length,
      },
    },
    counts,
  };
  const hash = hashHex(stableStringify(manifestCore));
  const manifest = { ...manifestCore, hash };

  return { hash, manifest, trainJsonl, evalJsonl, counts };
}

/**
 * Revalidate a persisted/imported snapshot before any trainer receives it.
 * This checks the manifest hash, exact blob digests/counts, canonical example
 * envelopes, consent, and conversation-level split isolation.
 */
export function validateDatasetSnapshot(input, { requireEvaluation = true } = {}) {
  assertObject(input, 'snapshot');
  const hash = sha256Text(input.hash, 'snapshot.hash');
  assertObject(input.manifest, 'snapshot.manifest');
  const manifest = cloneJson(input.manifest, 'snapshot.manifest', 512 * 1024);
  if (manifest.schema !== TRAINING_DATASET_SCHEMA) fail(`snapshot.manifest.schema must be "${TRAINING_DATASET_SCHEMA}"`);
  if (manifest.hash !== hash) fail('snapshot.manifest.hash must match snapshot.hash');
  const { hash: _manifestHash, ...manifestCore } = manifest;
  if (hashHex(stableStringify(manifestCore)) !== hash) fail('snapshot manifest content does not match its hash');
  if (manifest.consent?.accepted !== true) fail('snapshot manifest must contain accepted consent');
  validateTrainerEndpoint(manifest.consent.trainerEndpoint);
  if (manifest.split?.strategy !== 'conversation-hash' || manifest.split?.leakageProtected !== true) {
    fail('snapshot manifest must use the leakage-protected conversation-hash split');
  }
  if (typeof input.trainJsonl !== 'string' || typeof input.evalJsonl !== 'string') {
    fail('snapshot trainJsonl and evalJsonl must be strings');
  }
  assertObject(input.counts, 'snapshot.counts');
  const counts = {
    train: nonnegativeInteger(input.counts.train, 'snapshot.counts.train'),
    eval: nonnegativeInteger(input.counts.eval, 'snapshot.counts.eval'),
  };
  if (counts.train < 1) fail('snapshot must contain at least one training record');
  if (requireEvaluation && counts.eval < 1) fail('snapshot must contain at least one independent evaluation record');

  const train = parseAndValidateJsonl(input.trainJsonl, 'train');
  const evaluation = parseAndValidateJsonl(input.evalJsonl, 'eval');
  if (train.length !== counts.train || evaluation.length !== counts.eval) fail('snapshot record counts do not match JSONL content');
  validateManifestFile(manifest.files?.train, input.trainJsonl, train.length, 'train');
  validateManifestFile(manifest.files?.eval, input.evalJsonl, evaluation.length, 'eval');
  if (
    manifest.counts?.train !== counts.train ||
    manifest.counts?.eval !== counts.eval ||
    manifest.counts?.total !== counts.train + counts.eval
  ) {
    fail('snapshot manifest counts do not match snapshot content');
  }

  const ids = new Set();
  const hashes = new Set();
  const groups = new Set();
  for (const example of [...train, ...evaluation]) {
    if (example.provenance.sourceType !== 'conversation' || !example.provenance.conversationId) {
      fail('v1 training snapshots require conversation provenance for every example');
    }
    if (ids.has(example.id)) fail(`snapshot contains duplicate example id "${example.id}"`);
    if (hashes.has(example.contentHash)) fail(`snapshot contains duplicate example content hash "${example.contentHash}"`);
    ids.add(example.id);
    hashes.add(example.contentHash);
    groups.add(example.provenance.conversationId);
  }
  if (manifest.counts.groups !== groups.size) fail('snapshot manifest group count does not match conversation provenance');
  const trainConversations = new Set(train.map((example) => example.provenance.conversationId).filter(Boolean));
  for (const example of evaluation) {
    if (example.provenance.conversationId && trainConversations.has(example.provenance.conversationId)) {
      fail(`conversation "${example.provenance.conversationId}" appears in both train and eval splits`);
    }
  }

  return {
    hash,
    manifest,
    trainJsonl: input.trainJsonl,
    evalJsonl: input.evalJsonl,
    counts,
  };
}

/** Validate the bounded hyperparameter set accepted by the v1 trainer. */
export function normalizeHyperparameters(input = {}) {
  assertObject(input, 'hyperparameters');
  const canonical = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const key = HYPERPARAMETER_ALIASES[rawKey] ?? rawKey;
    if (!Object.hasOwn(HYPERPARAMETER_RULES, key)) fail(`Unsupported hyperparameter: ${rawKey}`);
    if (Object.hasOwn(canonical, key)) fail(`Hyperparameter ${key} was provided more than once`);
    canonical[key] = value;
  }

  const out = { ...HYPERPARAMETER_DEFAULTS };
  for (const [key, value] of Object.entries(canonical)) {
    const rule = HYPERPARAMETER_RULES[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${key} must be a finite number`);
    if (rule.integer && !Number.isSafeInteger(value)) fail(`${key} must be an integer`);
    if (value < rule.min || value > rule.max) fail(`${key} must be between ${rule.min} and ${rule.max}`);
    out[key] = value;
  }
  return out;
}

function normalizeMessages(value) {
  if (!Array.isArray(value)) fail('messages must be an array');
  if (value.length < 2 || value.length > MAX_MESSAGES) fail(`messages must contain 2-${MAX_MESSAGES} entries`);
  let total = 0;
  const messages = value.map((message, index) => {
    assertObject(message, `messages[${index}]`);
    if (!['system', 'user', 'assistant'].includes(message.role)) {
      fail(`messages[${index}].role must be system, user, or assistant`);
    }
    const content = requiredText(message.content, `messages[${index}].content`, MAX_MESSAGE_CHARS).trim();
    total += content.length;
    if (total > MAX_EXAMPLE_CHARS) fail(`messages exceed ${MAX_EXAMPLE_CHARS} total characters`);
    return { role: message.role, content };
  });

  let index = 0;
  if (messages[0].role === 'system') index = 1;
  if (messages.slice(1).some((message) => message.role === 'system')) fail('system messages are allowed only at the beginning');
  if (messages.length - index < 2) fail('messages must contain at least one user/assistant exchange');
  for (let i = index; i < messages.length; i++) {
    const expected = (i - index) % 2 === 0 ? 'user' : 'assistant';
    if (messages[i].role !== expected) fail(`messages[${i}].role must be ${expected}`);
  }
  if (messages.at(-1).role !== 'assistant') fail('messages must end with an assistant response');
  return messages;
}

function normalizeProvenance(value) {
  assertObject(value, 'provenance');
  const sourceType = value.sourceType ?? value.source_type ?? 'manual';
  if (typeof sourceType !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(sourceType)) {
    fail('provenance.sourceType must be a short identifier');
  }
  const messageIds = value.messageIds ?? value.message_ids ?? [];
  if (!Array.isArray(messageIds) || messageIds.length > MAX_PROVENANCE_IDS) {
    fail(`provenance.messageIds must be an array with at most ${MAX_PROVENANCE_IDS} entries`);
  }
  return {
    sourceType,
    conversationId: nullableId(value.conversationId ?? value.conversation_id, 'provenance.conversationId'),
    conversationTitle: optionalText(value.conversationTitle ?? value.conversation_title, 10_000),
    personaId: nullableId(value.personaId ?? value.persona_id, 'provenance.personaId'),
    messageIds: [...new Set(messageIds.map((id, index) => requiredId(id, `provenance.messageIds[${index}]`)))],
  };
}

function normalizeProject(project) {
  const id = requiredId(project.id, 'project.id');
  const method = optionalText(project.method, 128) || 'sft-lora';
  if (!TRAINING_METHODS.has(method)) fail(`project.method must be one of: ${[...TRAINING_METHODS].join(', ')}`);
  const baseModel = project.baseModel ?? project.base_model ?? project.baseRef ?? project.base_ref ?? project.base;
  const baseModelId = typeof baseModel === 'string' ? baseModel : baseModel?.id;
  if (typeof baseModelId !== 'string' || !baseModelId.trim() || baseModelId.length > 2048) {
    fail('project.baseModel must be a model id string or an object with an id');
  }
  return {
    id,
    title: optionalText(project.title, 1000),
    goal: optionalText(project.goal, 2000),
    method,
    baseModel: { id: baseModelId },
  };
}

function detectRiskFlags(messages) {
  const text = messages.map((message) => message.content).join('\n');
  const flags = new Set();
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i.test(text)) flags.add('secret_private_key');
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/.test(text)) {
    flags.add('secret_api_key');
  }
  if (/\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*[^\s,;]{6,}/i.test(text)) {
    flags.add('secret_credential');
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) flags.add('pii_email');
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) flags.add('pii_ssn');
  if (/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/.test(text)) flags.add('pii_phone');
  if (/\u26a0\ufe0f?\s*(?:Stream interrupted|Ollama|OpenAI|Anthropic)|Stream interrupted:/i.test(text)) {
    flags.add('interrupted_response');
  }
  return [...flags].sort();
}

function toJsonl(examples) {
  if (examples.length === 0) return '';
  return `${examples.map((example) => JSON.stringify({
    id: example.id,
    messages: example.messages,
    provenance: example.provenance,
    contentHash: example.contentHash,
    riskFlags: example.riskFlags,
  })).join('\n')}\n`;
}

function parseAndValidateJsonl(value, label) {
  if (!value) return [];
  if (value.includes('\r')) fail(`${label} JSONL must use LF line endings`);
  const lines = value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n');
  if (lines.some((line) => !line)) fail(`${label} JSONL must not contain blank lines`);
  return lines.map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      fail(`${label} JSONL line ${index + 1} is not valid JSON`);
    }
    assertObject(row, `${label} JSONL line ${index + 1}`);
    const allowed = new Set(['id', 'messages', 'provenance', 'contentHash', 'riskFlags']);
    for (const key of Object.keys(row)) if (!allowed.has(key)) fail(`${label} JSONL line ${index + 1} contains unsupported field "${key}"`);
    for (const key of allowed) if (!Object.hasOwn(row, key)) fail(`${label} JSONL line ${index + 1} is missing field "${key}"`);
    const normalized = normalizeTrainingExample({
      id: row.id,
      messages: row.messages,
      provenance: row.provenance,
      state: 'approved',
    });
    if (row.contentHash !== normalized.contentHash) fail(`${label} JSONL line ${index + 1} has an invalid contentHash`);
    if (stableStringify(row.messages) !== stableStringify(normalized.messages)) {
      fail(`${label} JSONL line ${index + 1} messages are not canonical`);
    }
    if (stableStringify(row.provenance) !== stableStringify(normalized.provenance)) {
      fail(`${label} JSONL line ${index + 1} provenance is not canonical`);
    }
    if (stableStringify(row.riskFlags) !== stableStringify(normalized.riskFlags)) {
      fail(`${label} JSONL line ${index + 1} riskFlags do not match the content`);
    }
    return normalized;
  });
}

function validateManifestFile(file, value, records, label) {
  assertObject(file, `snapshot.manifest.files.${label}`);
  if (file.name !== `${label}.jsonl`) fail(`snapshot.manifest.files.${label}.name must be "${label}.jsonl"`);
  if (file.sha256 !== hashHex(value)) fail(`snapshot.manifest.files.${label}.sha256 does not match JSONL bytes`);
  if (file.bytes !== Buffer.byteLength(value)) fail(`snapshot.manifest.files.${label}.bytes does not match JSONL bytes`);
  if (file.records !== records) fail(`snapshot.manifest.files.${label}.records does not match JSONL content`);
}

function validateTrainerEndpoint(value) {
  if (typeof value !== 'string' || !value) fail('snapshot consent must record its trainerEndpoint');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('snapshot consent trainerEndpoint must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail('snapshot consent trainerEndpoint must be a credential-free HTTP(S) origin');
  }
}

function makeLookup(value, label) {
  if (value === undefined || value === null) return new Map();
  if (value instanceof Map) return value;
  if (Array.isArray(value)) {
    const out = new Map();
    for (const [index, row] of value.entries()) {
      assertObject(row, `${label}[${index}]`);
      out.set(requiredId(row.id, `${label}[${index}].id`), row);
    }
    return out;
  }
  if (isObject(value)) return new Map(Object.entries(value));
  fail(`${label} must be an array, object, or Map`);
}

function makeMessageLookup(value) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) {
    const out = new Map();
    for (const message of value) {
      if (!isObject(message)) continue;
      const id = message.conversation_id ?? message.conversationId;
      if (typeof id !== 'string' || !id) continue;
      const rows = out.get(id) ?? [];
      rows.push(message);
      out.set(id, rows);
    }
    return out;
  }
  if (isObject(value)) return new Map(Object.entries(value));
  fail('messagesByConversation must be an array, object, or Map');
}

function compareConversation(a, b) {
  const date = String(a?.created_at ?? a?.createdAt ?? '').localeCompare(String(b?.created_at ?? b?.createdAt ?? ''));
  return date || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

function compareMessage(a, b) {
  return String(a?.created_at ?? a?.createdAt ?? '').localeCompare(String(b?.created_at ?? b?.createdAt ?? ''));
}

function cloneJson(value, label, maxBytes) {
  let encoded;
  try {
    encoded = stableStringify(value);
  } catch (err) {
    fail(`${label} must be JSON-compatible: ${err.message}`);
  }
  if (Buffer.byteLength(encoded) > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
  return JSON.parse(encoded);
}

function stableStringify(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new TypeError(`unsafe key: ${key}`);
      if (value[key] === undefined) throw new TypeError(`${key} must not be undefined`);
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`unsupported ${typeof value} value`);
}

function hashHex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeTimestamp(value, label) {
  const text = requiredText(value, label, 128);
  if (!Number.isFinite(Date.parse(text))) fail(`${label} must be an ISO-8601 timestamp`);
  return text;
}

function sha256Text(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256 value`);
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function requiredId(value, label) {
  return requiredText(value, label, MAX_ID_CHARS).trim();
}

function nullableId(value, label) {
  return value === undefined || value === null || value === '' ? null : requiredId(value, label);
}

function requiredText(value, label, max) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (!value.trim()) fail(`${label} must not be empty`);
  if (value.length > max) fail(`${label} must be at most ${max} characters`);
  if (value.includes('\0')) fail(`${label} must not contain null bytes`);
  return value;
}

function optionalText(value, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return String(value).slice(0, max);
  return value.slice(0, max);
}

function assertObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new TrainingValidationError(message);
}
