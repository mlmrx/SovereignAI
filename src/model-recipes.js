/**
 * A portable, provider-specific blueprint for an Ollama model artifact.
 *
 * Creating an Ollama model from one of these recipes packages configuration
 * around a source model and may optionally create a quantized derivative. It
 * is deliberately described as a build rather than fine-tuning: no training
 * job runs and the source model is not mutated.
 */

export const MODEL_RECIPE_FORMAT = 'sovereignai.model-recipe';
export const MODEL_RECIPE_VERSION = 1;

const MAX_NAME = 350 + 1 + 80 + 1 + 80 + 1 + 80;
const MAX_BASE = 2048;
const MAX_TITLE = 200;
const MAX_SYSTEM = 128 * 1024;
const MAX_TEMPLATE = 256 * 1024;
const MAX_LICENSE = 128 * 1024;
const MAX_MESSAGES = 128;
const MAX_MESSAGE_CONTENT = 64 * 1024;
const MAX_STOP_SEQUENCES = 64;
const MAX_STOP_LENGTH = 4096;
const QUANTIZE_LEVELS = new Set(['q8_0', 'q4_K_S', 'q4_K_M']);
const MODEL_RECIPE_CORE_FIELDS = Object.freeze([
  'title',
  'name',
  'base',
  'system',
  'parameters',
  'template',
  'license',
  'messages',
  'quantize',
]);
const MODEL_RECIPE_LEGACY_FIELDS = Object.freeze(['model', 'base_model', 'system_prompt']);

const PARAMETER_RULES = {
  temperature: { type: 'number', min: 0, max: 2 },
  num_ctx: { type: 'integer', min: 128, max: 1_048_576 },
  top_k: { type: 'integer', min: 0, max: 1000 },
  top_p: { type: 'number', min: 0, max: 1 },
  min_p: { type: 'number', min: 0, max: 1 },
  repeat_last_n: { type: 'integer', min: -1, max: 1_048_576 },
  repeat_penalty: { type: 'number', min: 0, max: 5 },
  seed: { type: 'integer', min: -1, max: 2_147_483_647 },
  num_predict: { type: 'integer', min: -1, max: 1_048_576 },
};

export const MODEL_PARAMETER_NAMES = Object.freeze([...Object.keys(PARAMETER_RULES), 'stop']);

export class ModelRecipeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelRecipeValidationError';
  }
}

/** Accept a recipe core or strictly unwrap a versioned portable envelope. */
export function unwrapPortableModelRecipe(input) {
  if (!isObject(input)) return input;
  const envelopeKeys = ['format', 'version', 'recipe'];
  if (!envelopeKeys.some((key) => Object.hasOwn(input, key))) return input;

  if (input.format !== MODEL_RECIPE_FORMAT) {
    throw new ModelRecipeValidationError(`format must be "${MODEL_RECIPE_FORMAT}"`);
  }
  if (input.version !== MODEL_RECIPE_VERSION) {
    throw new ModelRecipeValidationError(`Unsupported model recipe version: ${String(input.version)}`);
  }
  if (!isObject(input.recipe)) throw new ModelRecipeValidationError('recipe must be an object');
  const unknown = Object.keys(input).filter((key) => !envelopeKeys.includes(key));
  if (unknown.length) {
    throw new ModelRecipeValidationError(`Unsupported portable recipe field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
  return normalizeModelRecipe(input.recipe, { strict: true, allowLegacyAliases: false });
}

/** Normalize API input. Missing update fields inherit from `existing`. */
export function normalizeModelRecipe(
  input,
  { existing = null, strict = false, allowLegacyAliases = true } = {}
) {
  if (!isObject(input)) throw new ModelRecipeValidationError('Model recipe must be an object');
  if (strict) {
    const allowed = allowLegacyAliases
      ? [...MODEL_RECIPE_CORE_FIELDS, ...MODEL_RECIPE_LEGACY_FIELDS]
      : MODEL_RECIPE_CORE_FIELDS;
    const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
    if (unknown.length) {
      const scope = allowLegacyAliases ? 'model recipe' : 'portable recipe core';
      throw new ModelRecipeValidationError(`Unsupported ${scope} field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
    }
  }

  const name = boundedRequired(
    pick(input, ['name', 'model'], existing?.name),
    'name',
    MAX_NAME
  ).trim();
  validateModelName(name);

  const titleValue = pick(input, ['title'], existing?.title ?? name);
  const title = boundedRequired(titleValue, 'title', MAX_TITLE).trim();
  const base = boundedRequired(
    pick(input, ['base', 'base_model'], existing?.base),
    'base',
    MAX_BASE
  ).trim();
  if (/\r|\n|\0/.test(base)) throw new ModelRecipeValidationError('base must be a single-line model name or path');

  const system = boundedText(
    pick(input, ['system', 'system_prompt'], existing?.system ?? ''),
    'system',
    MAX_SYSTEM
  );
  const template = boundedText(pick(input, ['template'], existing?.template ?? ''), 'template', MAX_TEMPLATE);
  const license = boundedText(pick(input, ['license'], existing?.license ?? ''), 'license', MAX_LICENSE);
  const quantize = normalizeQuantize(pick(input, ['quantize'], existing?.quantize ?? null));
  const parameters = normalizeParameters(
    input.parameters === undefined ? existing?.parameters ?? {} : input.parameters
  );
  const messages = normalizeMessages(
    input.messages === undefined ? existing?.messages ?? [] : input.messages,
    { strict }
  );

  // Triple-quoted blocks are the only portable multiline representation in a
  // Modelfile. Reject their terminator rather than returning a blueprint that
  // looks valid but changes meaning when rebuilt outside SovereignAI.
  for (const [label, value] of [['system', system], ['template', template], ['license', license]]) {
    rejectBlockTerminator(value, label);
  }
  for (const [index, message] of messages.entries()) rejectBlockTerminator(message.content, `messages[${index}].content`);

  return { title, name, base, system, parameters, template, license, messages, quantize };
}

export function modelRecipeCore(recipe) {
  const normalized = normalizeModelRecipe(recipe);
  return {
    title: normalized.title,
    name: normalized.name,
    base: normalized.base,
    system: normalized.system,
    parameters: structuredClone(normalized.parameters),
    template: normalized.template,
    license: normalized.license,
    messages: structuredClone(normalized.messages),
    quantize: normalized.quantize,
  };
}

export function portableModelRecipe(recipe) {
  return {
    format: MODEL_RECIPE_FORMAT,
    version: MODEL_RECIPE_VERSION,
    recipe: modelRecipeCore(recipe),
  };
}

export function renderModelfile(recipe) {
  const value = normalizeModelRecipe(recipe);
  const lines = [
    '# SovereignAI portable model blueprint',
    '# This defines model configuration; it does not perform weight training.',
    `FROM ${value.base}`,
  ];

  for (const key of Object.keys(PARAMETER_RULES)) {
    if (value.parameters[key] !== undefined) lines.push(`PARAMETER ${key} ${value.parameters[key]}`);
  }
  for (const stop of value.parameters.stop ?? []) lines.push(`PARAMETER stop ${JSON.stringify(stop)}`);
  if (value.template) lines.push(`TEMPLATE \"\"\"${value.template}\"\"\"`);
  if (value.system) lines.push(`SYSTEM \"\"\"${value.system}\"\"\"`);
  if (value.license) lines.push(`LICENSE \"\"\"${value.license}\"\"\"`);
  for (const message of value.messages) lines.push(`MESSAGE ${message.role} \"\"\"${message.content}\"\"\"`);
  if (value.quantize) {
    lines.push(`# Build option: quantize ${value.quantize} (creates a derived quantized artifact; pass --quantize when rebuilding)`);
  }
  return `${lines.join('\n')}\n`;
}

export function presentModelRecipe(recipe, { ollamaBaseUrl } = {}) {
  const portable = portableModelRecipe(recipe);
  return {
    ...recipe,
    ...portable.recipe,
    portable,
    modelfile: renderModelfile(recipe),
    ownership: describeOwnership(ollamaBaseUrl, portable.recipe),
  };
}

export function describeOwnership(baseUrl, { quantize = null } = {}) {
  const endpoint = safeEndpoint(baseUrl);
  const local = isLoopbackEndpoint(baseUrl);
  const quantized = Boolean(quantize);
  return {
    recipeStorage: 'local SQLite database',
    recipePortable: true,
    modelArtifactEndpoint: endpoint,
    modelArtifactLocation: local ? 'local-ollama' : 'configured-ollama-endpoint',
    modelArtifactControl: local
      ? 'The model artifact is created on this device\'s Ollama endpoint.'
      : 'The model artifact is created at the configured Ollama endpoint; storage and control follow that endpoint.',
    buildKind: quantized
      ? 'configuration packaging with derived-weight quantization, not weight training'
      : 'configuration packaging, not weight training',
    trainingPerformed: false,
    sourceWeightsChanged: false,
    artifactWeightsQuantized: quantized,
    // Kept for API compatibility; this describes the derived artifact rather
    // than mutation of the source model.
    weightsChanged: quantized,
  };
}

function normalizeParameters(value) {
  if (!isObject(value)) throw new ModelRecipeValidationError('parameters must be an object');
  const unknown = Object.keys(value).filter((key) => !MODEL_PARAMETER_NAMES.includes(key));
  if (unknown.length) {
    throw new ModelRecipeValidationError(`Unsupported model parameter${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }

  const out = {};
  for (const [key, rule] of Object.entries(PARAMETER_RULES)) {
    const setting = value[key];
    if (setting === undefined || setting === null || setting === '') continue;
    if (typeof setting !== 'number' || !Number.isFinite(setting)) {
      throw new ModelRecipeValidationError(`parameters.${key} must be a finite number`);
    }
    if (rule.type === 'integer' && !Number.isSafeInteger(setting)) {
      throw new ModelRecipeValidationError(`parameters.${key} must be an integer`);
    }
    if (setting < rule.min || setting > rule.max) {
      throw new ModelRecipeValidationError(`parameters.${key} must be between ${rule.min} and ${rule.max}`);
    }
    out[key] = setting;
  }

  if (value.stop !== undefined && value.stop !== null) {
    if (!Array.isArray(value.stop)) throw new ModelRecipeValidationError('parameters.stop must be an array of strings');
    if (value.stop.length > MAX_STOP_SEQUENCES) {
      throw new ModelRecipeValidationError(`parameters.stop may contain at most ${MAX_STOP_SEQUENCES} sequences`);
    }
    out.stop = value.stop.map((stop, index) => {
      const normalized = boundedText(stop, `parameters.stop[${index}]`, MAX_STOP_LENGTH);
      if (!normalized) throw new ModelRecipeValidationError(`parameters.stop[${index}] must not be empty`);
      return normalized;
    });
  }
  return out;
}

function normalizeMessages(value, { strict = false } = {}) {
  if (!Array.isArray(value)) throw new ModelRecipeValidationError('messages must be an array');
  if (value.length > MAX_MESSAGES) throw new ModelRecipeValidationError(`messages may contain at most ${MAX_MESSAGES} examples`);
  return value.map((message, index) => {
    if (!isObject(message)) throw new ModelRecipeValidationError(`messages[${index}] must be an object`);
    if (strict) {
      const unknown = Object.keys(message).filter((key) => !['role', 'content'].includes(key));
      if (unknown.length) {
        throw new ModelRecipeValidationError(
          `Unsupported messages[${index}] field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`
        );
      }
    }
    const role = boundedRequired(message.role, `messages[${index}].role`, 16);
    if (!['system', 'user', 'assistant'].includes(role)) {
      throw new ModelRecipeValidationError(`messages[${index}].role must be system, user, or assistant`);
    }
    return {
      role,
      content: boundedRequired(message.content, `messages[${index}].content`, MAX_MESSAGE_CONTENT),
    };
  });
}

function normalizeQuantize(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = boundedRequired(value, 'quantize', 32);
  if (!QUANTIZE_LEVELS.has(normalized)) {
    throw new ModelRecipeValidationError(`quantize must be one of: ${[...QUANTIZE_LEVELS].join(', ')}`);
  }
  return normalized;
}

function validateModelName(name) {
  const lastSlash = name.lastIndexOf('/');
  const lastColon = name.lastIndexOf(':');
  let path = name;
  let tag = null;
  if (lastColon > lastSlash) {
    path = name.slice(0, lastColon);
    tag = name.slice(lastColon + 1);
  }

  const parts = path.split('/');
  if (parts.length > 3) {
    throw new ModelRecipeValidationError('name may contain at most host, namespace, and model path components');
  }
  const [host, namespace, model] = parts.length === 3
    ? parts
    : parts.length === 2
      ? [null, parts[0], parts[1]]
      : [null, null, parts[0]];

  if (host !== null) validateModelNamePart(host, 'host', 350, /^[a-z0-9_][a-z0-9_.:-]*$/i);
  if (namespace !== null) validateModelNamePart(namespace, 'namespace', 80, /^[a-z0-9_][a-z0-9_-]*$/i);
  validateModelNamePart(model, 'model', 80, /^[a-z0-9_][a-z0-9_.-]*$/i);
  if (tag !== null) validateModelNamePart(tag, 'tag', 80, /^[a-z0-9_][a-z0-9_.-]*$/i);
}

function validateModelNamePart(value, label, max, pattern) {
  if (value.length < 1 || value.length > max) {
    throw new ModelRecipeValidationError(`name ${label} must be 1-${max} characters`);
  }
  if (!pattern.test(value)) {
    throw new ModelRecipeValidationError(`name ${label} contains unsupported characters`);
  }
}

function boundedRequired(value, label, max) {
  const normalized = boundedText(value, label, max);
  if (!normalized.trim()) throw new ModelRecipeValidationError(`${label} is required`);
  return normalized;
}

function boundedText(value, label, max) {
  if (typeof value !== 'string') throw new ModelRecipeValidationError(`${label} must be a string`);
  if (value.length > max) throw new ModelRecipeValidationError(`${label} must be at most ${max} characters`);
  if (value.includes('\0')) throw new ModelRecipeValidationError(`${label} must not contain null bytes`);
  return value;
}

function rejectBlockTerminator(value, label) {
  if (value.includes('\"\"\"')) {
    throw new ModelRecipeValidationError(`${label} must not contain a triple-quote sequence because it cannot be represented safely in a Modelfile`);
  }
}

function pick(input, keys, fallback) {
  for (const key of keys) if (input[key] !== undefined) return input[key];
  return fallback;
}

function isLoopbackEndpoint(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function safeEndpoint(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'configured Ollama endpoint';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
