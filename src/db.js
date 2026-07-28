import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newId, now } from './util.js';
import { normalizeModelRecipe } from './model-recipes.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  system_prompt TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  temperature REAL,
  use_memory INTEGER NOT NULL DEFAULT 1,
  use_knowledge INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  persona_id TEXT,
  title TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  embedded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, idx);
CREATE TABLE IF NOT EXISTS model_recipes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  name TEXT NOT NULL,
  base TEXT NOT NULL,
  system TEXT NOT NULL DEFAULT '',
  parameters TEXT NOT NULL DEFAULT '{}',
  template TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  messages TEXT NOT NULL DEFAULT '[]',
  quantize TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_built_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_recipes_updated ON model_recipes(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_recipes_name_nocase ON model_recipes(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS training_projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  base_model TEXT NOT NULL,
  target_persona_id TEXT,
  method TEXT NOT NULL DEFAULT 'sft-lora',
  status TEXT NOT NULL DEFAULT 'draft',
  consent TEXT NOT NULL DEFAULT '{}',
  source_conversations TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (target_persona_id) REFERENCES personas(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_training_projects_updated ON training_projects(updated_at DESC);
CREATE TABLE IF NOT EXISTS training_examples (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  system TEXT NOT NULL DEFAULT '',
  user TEXT NOT NULL,
  assistant TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT '{}',
  included INTEGER NOT NULL DEFAULT 1,
  reviewed INTEGER NOT NULL DEFAULT 0,
  risk_flags TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES training_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_training_examples_project ON training_examples(project_id, created_at);
CREATE TABLE IF NOT EXISTS training_datasets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  format TEXT NOT NULL,
  hash TEXT NOT NULL,
  manifest TEXT NOT NULL,
  train_jsonl TEXT NOT NULL,
  eval_jsonl TEXT NOT NULL,
  train_count INTEGER NOT NULL,
  eval_count INTEGER NOT NULL,
  consent TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES training_projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_training_datasets_project ON training_datasets(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS training_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  remote_job_id TEXT,
  status TEXT NOT NULL,
  progress REAL,
  stage TEXT NOT NULL DEFAULT '',
  hyperparameters TEXT NOT NULL DEFAULT '{}',
  submission_consent TEXT NOT NULL DEFAULT '{}',
  metrics TEXT NOT NULL DEFAULT '{}',
  artifact TEXT,
  error TEXT,
  evaluation_decision TEXT,
  evaluation_notes TEXT NOT NULL DEFAULT '',
  deployed_persona_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deployed_at TEXT,
  FOREIGN KEY (project_id) REFERENCES training_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id) REFERENCES training_datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (deployed_persona_id) REFERENCES personas(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_training_runs_project ON training_runs(project_id, created_at DESC);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  tightenPermissions(dataDir, 0o700);
  const dbFile = path.join(dataDir, 'sovereign.db');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 5000;');
  // Keep enforcement enabled for compatible/future schemas. The current
  // tables predate FK clauses, so Store methods still own manual cascades.
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  ensureColumn(db, 'training_examples', 'reviewed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'training_runs', 'submission_consent', "TEXT NOT NULL DEFAULT '{}'");
  for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    if (fs.existsSync(file)) tightenPermissions(file, 0o600);
  }
  return new Store(db);
}

function tightenPermissions(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'ENOSYS') throw err;
  }
}

function ensureColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export class Store {
  constructor(db) {
    this.db = db;
    this.knowledgeRevision = 0;
  }

  getCounts() {
    const row = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM personas) AS personas,
          (SELECT COUNT(*) FROM conversations) AS conversations,
          (SELECT COUNT(*) FROM documents) AS documents,
          (SELECT COUNT(*) FROM memories) AS memories,
          (SELECT COUNT(*) FROM training_projects) AS training_projects`
      )
      .get();
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  }

  /** Largest approved (locked) training dataset across all projects, for the model-fit/fine-tune recommendation. */
  getFineTuningReadiness() {
    const row = this.db.prepare('SELECT MAX(train_count) AS maxTrainCount FROM training_datasets').get();
    return { maxTrainCount: row.maxTrainCount === null ? 0 : Number(row.maxTrainCount) };
  }

  isEmptyExceptPersonas() {
    const row = this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM conversations) +
        (SELECT COUNT(*) FROM messages) +
        (SELECT COUNT(*) FROM memories) +
        (SELECT COUNT(*) FROM documents) +
        (SELECT COUNT(*) FROM chunks) +
        (SELECT COUNT(*) FROM model_recipes) +
        (SELECT COUNT(*) FROM training_projects) +
        (SELECT COUNT(*) FROM training_examples) +
        (SELECT COUNT(*) FROM training_datasets) +
        (SELECT COUNT(*) FROM training_runs) AS count`
    ).get();
    return Number(row.count) === 0;
  }

  getKnowledgeVersion() {
    const external = Number(this.db.prepare('PRAGMA data_version').get().data_version);
    return `${this.knowledgeRevision}:${external}`;
  }

  // ---- Personas ----
  listPersonas() {
    return this.db.prepare('SELECT * FROM personas ORDER BY created_at').all();
  }

  getPersona(id) {
    return this.db.prepare('SELECT * FROM personas WHERE id = ?').get(id);
  }

  createPersona(p) {
    const row = {
      id: p.id ?? newId(),
      name: p.name,
      description: p.description ?? '',
      system_prompt: p.system_prompt,
      provider: p.provider ?? null,
      model: p.model ?? null,
      temperature: p.temperature ?? null,
      use_memory: p.use_memory ? 1 : 0,
      use_knowledge: p.use_knowledge ? 1 : 0,
      created_at: now(),
      updated_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO personas (id, name, description, system_prompt, provider, model, temperature, use_memory, use_knowledge, created_at, updated_at)
         VALUES (:id, :name, :description, :system_prompt, :provider, :model, :temperature, :use_memory, :use_knowledge, :created_at, :updated_at)`
      )
      .run(row);
    return this.getPersona(row.id);
  }

  updatePersona(id, p) {
    const existing = this.getPersona(id);
    if (!existing) return null;
    const row = {
      id,
      name: p.name ?? existing.name,
      description: p.description ?? existing.description,
      system_prompt: p.system_prompt ?? existing.system_prompt,
      provider: p.provider !== undefined ? p.provider : existing.provider,
      model: p.model !== undefined ? p.model : existing.model,
      temperature: p.temperature !== undefined ? p.temperature : existing.temperature,
      use_memory: p.use_memory !== undefined ? (p.use_memory ? 1 : 0) : existing.use_memory,
      use_knowledge: p.use_knowledge !== undefined ? (p.use_knowledge ? 1 : 0) : existing.use_knowledge,
      updated_at: now(),
    };
    this.db
      .prepare(
        `UPDATE personas SET name=:name, description=:description, system_prompt=:system_prompt, provider=:provider,
         model=:model, temperature=:temperature, use_memory=:use_memory, use_knowledge=:use_knowledge, updated_at=:updated_at
         WHERE id=:id`
      )
      .run(row);
    return this.getPersona(id);
  }

  deletePersona(id) {
    return atomic(this.db, () => {
      this.db.prepare('UPDATE conversations SET persona_id = NULL WHERE persona_id = ?').run(id);
      return this.db.prepare('DELETE FROM personas WHERE id = ?').run(id);
    });
  }

  // ---- Conversations ----
  listConversations() {
    return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
  }

  getConversation(id) {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  createConversation({ persona_id, title = '' }) {
    const row = { id: newId(), persona_id: persona_id ?? null, title, created_at: now(), updated_at: now() };
    this.db
      .prepare('INSERT INTO conversations (id, persona_id, title, created_at, updated_at) VALUES (:id, :persona_id, :title, :created_at, :updated_at)')
      .run(row);
    return this.getConversation(row.id);
  }

  touchConversation(id, title) {
    if (title !== undefined) {
      this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), id);
    } else {
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), id);
    }
  }

  renameConversation(id, title) {
    const result = this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), id);
    return result.changes ? this.getConversation(id) : null;
  }

  deleteConversation(id) {
    return atomic(this.db, () => {
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
      return this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    });
  }

  // ---- Messages ----
  listMessages(conversationId) {
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversationId);
  }

  addMessage(m) {
    const row = {
      id: m.id ?? newId(),
      conversation_id: m.conversation_id,
      role: m.role,
      content: m.content,
      provider: m.provider ?? null,
      model: m.model ?? null,
      tokens_in: m.tokens_in ?? null,
      tokens_out: m.tokens_out ?? null,
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, provider, model, tokens_in, tokens_out, created_at)
         VALUES (:id, :conversation_id, :role, :content, :provider, :model, :tokens_in, :tokens_out, :created_at)`
      )
      .run(row);
    return row;
  }

  // ---- Memories (long-term notes) ----
  listMemories() {
    return this.db.prepare('SELECT * FROM memories ORDER BY created_at').all();
  }

  listRecentMemories(limit = 1000) {
    const bounded = Math.max(1, Math.min(10_000, Number(limit) || 1000));
    return this.db
      .prepare('SELECT * FROM memories ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(bounded)
      .reverse();
  }

  addMemory(content) {
    const row = { id: newId(), content, created_at: now() };
    this.db.prepare('INSERT INTO memories (id, content, created_at) VALUES (:id, :content, :created_at)').run(row);
    return row;
  }

  updateMemory(id, content) {
    const result = this.db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, id);
    return result.changes ? this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) : null;
  }

  deleteMemory(id) {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  // ---- Documents & chunks (knowledge base) ----
  listDocuments() {
    return this.db.prepare('SELECT * FROM documents ORDER BY created_at DESC').all();
  }

  addDocument({ name, size, chunks, embedded }) {
    const doc = { id: newId(), name, size, chunk_count: chunks.length, embedded: embedded ? 1 : 0, created_at: now() };
    const result = atomic(this.db, () => {
      this.db
        .prepare('INSERT INTO documents (id, name, size, chunk_count, embedded, created_at) VALUES (:id, :name, :size, :chunk_count, :embedded, :created_at)')
        .run(doc);
      const insert = this.db.prepare('INSERT INTO chunks (id, document_id, idx, content, embedding) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < chunks.length; i++) {
        insert.run(newId(), doc.id, i, chunks[i].content, chunks[i].embedding ? JSON.stringify(chunks[i].embedding) : null);
      }
      return doc;
    });
    this.knowledgeRevision++;
    return result;
  }

  deleteDocument(id) {
    const result = atomic(this.db, () => {
      this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
      return this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    });
    if (result.changes) this.knowledgeRevision++;
    return result;
  }

  listAllChunks() {
    return this.db
      .prepare(
        `SELECT chunks.id, chunks.document_id, chunks.idx, chunks.content, chunks.embedding, documents.name AS document_name
         FROM chunks JOIN documents ON documents.id = chunks.document_id`
      )
      .all();
  }

  // ---- Model Studio recipes ----
  listModelRecipes() {
    return this.db
      .prepare('SELECT * FROM model_recipes ORDER BY updated_at DESC, rowid DESC')
      .all()
      .map(modelRecipeFromRow);
  }

  listModelRecipeSummaries() {
    return this.db.prepare(
      `SELECT id, title, name, base, quantize, created_at, updated_at, last_built_at
       FROM model_recipes
       ORDER BY updated_at DESC, rowid DESC`
    ).all();
  }

  getModelRecipe(id) {
    const row = this.db.prepare('SELECT * FROM model_recipes WHERE id = ?').get(id);
    return row ? modelRecipeFromRow(row) : null;
  }

  findModelRecipeByName(name) {
    const row = this.db
      .prepare('SELECT * FROM model_recipes WHERE name = ? COLLATE NOCASE LIMIT 1')
      .get(name);
    return row ? modelRecipeFromRow(row) : null;
  }

  createModelRecipe(recipe) {
    const normalized = normalizeModelRecipe(recipe);
    if (this.findModelRecipeByName(normalized.name)) throw new ModelRecipeConflictError(normalized.name);
    const stamp = now();
    const row = modelRecipeToRow({
      ...normalized,
      id: recipe.id ?? newId(),
      created_at: stamp,
      updated_at: stamp,
      last_built_at: recipe.last_built_at ?? null,
    });
    try {
      this.db.prepare(
        `INSERT INTO model_recipes
         (id, title, name, base, system, parameters, template, license, messages, quantize, created_at, updated_at, last_built_at)
         VALUES (:id, :title, :name, :base, :system, :parameters, :template, :license, :messages, :quantize, :created_at, :updated_at, :last_built_at)`
      ).run(row);
    } catch (err) {
      rethrowModelRecipeNameConflict(err, normalized.name);
    }
    return this.getModelRecipe(row.id);
  }

  updateModelRecipe(id, update) {
    const existing = this.getModelRecipe(id);
    if (!existing) return null;
    const normalized = normalizeModelRecipe(update, { existing });
    const conflict = this.findModelRecipeByName(normalized.name);
    if (conflict && conflict.id !== id) throw new ModelRecipeConflictError(normalized.name);
    const buildChanged = modelRecipeBuildSignature(normalized) !== modelRecipeBuildSignature(existing);
    const row = modelRecipeToRow({
      ...normalized,
      id,
      created_at: existing.created_at,
      updated_at: now(),
      last_built_at: buildChanged ? null : existing.last_built_at,
    });
    const { created_at: _createdAt, ...updateRow } = row;
    try {
      this.db.prepare(
        `UPDATE model_recipes SET
         title=:title, name=:name, base=:base, system=:system, parameters=:parameters,
         template=:template, license=:license, messages=:messages, quantize=:quantize,
         updated_at=:updated_at, last_built_at=:last_built_at
         WHERE id=:id`
      ).run(updateRow);
    } catch (err) {
      rethrowModelRecipeNameConflict(err, normalized.name);
    }
    return this.getModelRecipe(id);
  }

  upsertModelRecipeByName(recipe) {
    const existing = this.findModelRecipeByName(recipe.name);
    if (existing) return this.updateModelRecipe(existing.id, recipe);
    try {
      return this.createModelRecipe(recipe);
    } catch (err) {
      // Another Store/process may have inserted the same artifact name after
      // the lookup. Preserve the compatibility endpoint's upsert behavior.
      if (!(err instanceof ModelRecipeConflictError)) throw err;
      const raced = this.findModelRecipeByName(recipe.name);
      if (!raced) throw err;
      return this.updateModelRecipe(raced.id, recipe);
    }
  }

  markModelRecipeBuilt(id, { expected = null } = {}) {
    const stamp = now();
    let result;
    if (expected) {
      const snapshot = modelRecipeToRow(normalizeModelRecipe(expected));
      result = this.db.prepare(
        `UPDATE model_recipes SET last_built_at = :stamp, updated_at = :stamp
         WHERE id = :id
           AND name = :expected_name
           AND base = :expected_base
           AND system = :expected_system
           AND parameters = :expected_parameters
           AND template = :expected_template
           AND license = :expected_license
           AND messages = :expected_messages
           AND quantize IS :expected_quantize`
      ).run({
        stamp,
        id,
        expected_name: snapshot.name,
        expected_base: snapshot.base,
        expected_system: snapshot.system,
        expected_parameters: snapshot.parameters,
        expected_template: snapshot.template,
        expected_license: snapshot.license,
        expected_messages: snapshot.messages,
        expected_quantize: snapshot.quantize,
      });
    } else {
      result = this.db
        .prepare('UPDATE model_recipes SET last_built_at = ?, updated_at = ? WHERE id = ?')
        .run(stamp, stamp, id);
    }
    return result.changes ? this.getModelRecipe(id) : null;
  }

  deleteModelRecipe(id) {
    return this.db.prepare('DELETE FROM model_recipes WHERE id = ?').run(id);
  }

  // ---- Fine-Tuning Studio ----
  listTrainingProjects() {
    return this.db.prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM training_examples e WHERE e.project_id = p.id AND e.included = 1) AS example_count,
        (SELECT COUNT(*) FROM training_datasets d WHERE d.project_id = p.id) AS dataset_count,
        (SELECT COUNT(*) FROM training_runs r WHERE r.project_id = p.id) AS run_count
       FROM training_projects p ORDER BY p.updated_at DESC, p.rowid DESC`
    ).all().map(trainingProjectFromRow);
  }

  getTrainingProject(id) {
    const row = this.db.prepare('SELECT * FROM training_projects WHERE id = ?').get(id);
    return row ? trainingProjectFromRow(row) : null;
  }

  createTrainingProject(project) {
    const stamp = now();
    const row = trainingProjectToRow({
      id: project.id ?? newId(),
      title: project.title,
      goal: project.goal ?? '',
      base_model: project.base_model,
      target_persona_id: project.target_persona_id ?? null,
      method: project.method ?? 'sft-lora',
      status: project.status ?? 'draft',
      consent: project.consent ?? {},
      source_conversations: project.source_conversations ?? [],
      created_at: project.created_at ?? stamp,
      updated_at: project.updated_at ?? stamp,
    });
    this.db.prepare(
      `INSERT INTO training_projects
       (id,title,goal,base_model,target_persona_id,method,status,consent,source_conversations,created_at,updated_at)
       VALUES (:id,:title,:goal,:base_model,:target_persona_id,:method,:status,:consent,:source_conversations,:created_at,:updated_at)`
    ).run(row);
    return this.getTrainingProject(row.id);
  }

  updateTrainingProject(id, update) {
    const existing = this.getTrainingProject(id);
    if (!existing) return null;
    const row = trainingProjectToRow({
      ...existing,
      ...update,
      id,
      created_at: existing.created_at,
      updated_at: now(),
    });
    const { created_at: _createdAt, ...updateRow } = row;
    this.db.prepare(
      `UPDATE training_projects SET title=:title,goal=:goal,base_model=:base_model,
       target_persona_id=:target_persona_id,method=:method,status=:status,consent=:consent,
       source_conversations=:source_conversations,updated_at=:updated_at WHERE id=:id`
    ).run(updateRow);
    return this.getTrainingProject(id);
  }

  deleteTrainingProject(id) {
    return this.db.prepare('DELETE FROM training_projects WHERE id = ?').run(id);
  }

  listTrainingExamples(projectId) {
    return this.db.prepare('SELECT * FROM training_examples WHERE project_id = ? ORDER BY created_at, rowid').all(projectId).map(trainingExampleFromRow);
  }

  getTrainingExample(id) {
    const row = this.db.prepare('SELECT * FROM training_examples WHERE id = ?').get(id);
    return row ? trainingExampleFromRow(row) : null;
  }

  replaceTrainingExamples(projectId, examples, { sourceConversations = [], consent = {} } = {}) {
    return atomic(this.db, () => {
      this.db.prepare('DELETE FROM training_examples WHERE project_id = ?').run(projectId);
      const insert = this.db.prepare(
        `INSERT INTO training_examples
         (id,project_id,system,user,assistant,provenance,included,reviewed,risk_flags,content_hash,created_at,updated_at)
         VALUES (:id,:project_id,:system,:user,:assistant,:provenance,:included,:reviewed,:risk_flags,:content_hash,:created_at,:updated_at)`
      );
      for (const example of examples) {
        const stamp = now();
        insert.run(trainingExampleToRow({
          ...example,
          id: example.id ?? newId(),
          project_id: projectId,
          included: example.included ?? 1,
          created_at: example.created_at ?? stamp,
          updated_at: example.updated_at ?? stamp,
        }));
      }
      this.updateTrainingProject(projectId, {
        status: 'review',
        consent,
        source_conversations: sourceConversations,
      });
      return this.listTrainingExamples(projectId);
    });
  }

  updateTrainingExample(id, update) {
    const existing = this.getTrainingExample(id);
    if (!existing) return null;
    const row = trainingExampleToRow({ ...existing, ...update, id, project_id: existing.project_id, created_at: existing.created_at, updated_at: now() });
    const { project_id: _projectId, created_at: _createdAt, ...updateRow } = row;
    this.db.prepare(
      `UPDATE training_examples SET system=:system,user=:user,assistant=:assistant,provenance=:provenance,
       included=:included,reviewed=:reviewed,risk_flags=:risk_flags,content_hash=:content_hash,updated_at=:updated_at WHERE id=:id`
    ).run(updateRow);
    this.updateTrainingProject(existing.project_id, { status: 'review' });
    return this.getTrainingExample(id);
  }

  listTrainingDatasets(projectId) {
    return this.db.prepare('SELECT * FROM training_datasets WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId).map(trainingDatasetFromRow);
  }

  getTrainingDataset(id) {
    const row = this.db.prepare('SELECT * FROM training_datasets WHERE id = ?').get(id);
    return row ? trainingDatasetFromRow(row) : null;
  }

  createTrainingDataset(dataset) {
    const stamp = now();
    const row = trainingDatasetToRow({
      ...dataset,
      id: dataset.id ?? newId(),
      created_at: dataset.created_at ?? stamp,
      approved_at: dataset.approved_at ?? stamp,
    });
    this.db.prepare(
      `INSERT INTO training_datasets
       (id,project_id,format,hash,manifest,train_jsonl,eval_jsonl,train_count,eval_count,consent,approved_at,created_at)
       VALUES (:id,:project_id,:format,:hash,:manifest,:train_jsonl,:eval_jsonl,:train_count,:eval_count,:consent,:approved_at,:created_at)`
    ).run(row);
    this.updateTrainingProject(dataset.project_id, { status: 'approved' });
    return this.getTrainingDataset(row.id);
  }

  listTrainingRuns(projectId) {
    return this.db.prepare('SELECT * FROM training_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').all(projectId).map(trainingRunFromRow);
  }

  getTrainingRun(id) {
    const row = this.db.prepare('SELECT * FROM training_runs WHERE id = ?').get(id);
    return row ? trainingRunFromRow(row) : null;
  }

  createTrainingRun(run) {
    const stamp = now();
    const row = trainingRunToRow({
      id: run.id ?? newId(),
      project_id: run.project_id,
      dataset_id: run.dataset_id,
      endpoint: run.endpoint,
      remote_job_id: run.remote_job_id ?? null,
      status: run.status ?? 'preparing',
      progress: run.progress ?? null,
      stage: run.stage ?? '',
      hyperparameters: run.hyperparameters ?? {},
      submission_consent: run.submission_consent ?? {},
      metrics: run.metrics ?? {},
      artifact: run.artifact ?? null,
      error: run.error ?? null,
      evaluation_decision: run.evaluation_decision ?? null,
      evaluation_notes: run.evaluation_notes ?? '',
      deployed_persona_id: run.deployed_persona_id ?? null,
      created_at: run.created_at ?? stamp,
      updated_at: run.updated_at ?? stamp,
      completed_at: run.completed_at ?? null,
      deployed_at: run.deployed_at ?? null,
    });
    this.db.prepare(
      `INSERT INTO training_runs
       (id,project_id,dataset_id,endpoint,remote_job_id,status,progress,stage,hyperparameters,submission_consent,metrics,artifact,error,
        evaluation_decision,evaluation_notes,deployed_persona_id,created_at,updated_at,completed_at,deployed_at)
       VALUES (:id,:project_id,:dataset_id,:endpoint,:remote_job_id,:status,:progress,:stage,:hyperparameters,:submission_consent,:metrics,:artifact,:error,
        :evaluation_decision,:evaluation_notes,:deployed_persona_id,:created_at,:updated_at,:completed_at,:deployed_at)`
    ).run(row);
    this.updateTrainingProject(run.project_id, { status: row.status });
    return this.getTrainingRun(row.id);
  }

  updateTrainingRun(id, update) {
    const existing = this.getTrainingRun(id);
    if (!existing) return null;
    const row = trainingRunToRow({ ...existing, ...update, id, project_id: existing.project_id, dataset_id: existing.dataset_id, created_at: existing.created_at, updated_at: now() });
    const { project_id: _projectId, dataset_id: _datasetId, created_at: _createdAt, ...updateRow } = row;
    this.db.prepare(
      `UPDATE training_runs SET endpoint=:endpoint,remote_job_id=:remote_job_id,status=:status,progress=:progress,
       stage=:stage,hyperparameters=:hyperparameters,submission_consent=:submission_consent,metrics=:metrics,artifact=:artifact,error=:error,
       evaluation_decision=:evaluation_decision,evaluation_notes=:evaluation_notes,deployed_persona_id=:deployed_persona_id,
       updated_at=:updated_at,completed_at=:completed_at,deployed_at=:deployed_at WHERE id=:id`
    ).run(updateRow);
    this.updateTrainingProject(existing.project_id, { status: row.status === 'succeeded' && row.deployed_at ? 'deployed' : row.status });
    return this.getTrainingRun(id);
  }

  // ---- Export / import (data portability) ----
  exportAll() {
    return {
      personas: this.listPersonas(),
      conversations: this.listConversations(),
      messages: this.db.prepare('SELECT * FROM messages ORDER BY created_at, rowid').all(),
      memories: this.listMemories(),
      documents: this.listDocuments(),
      chunks: this.db.prepare('SELECT * FROM chunks').all(),
      model_recipes: this.listModelRecipes(),
      training_projects: this.listTrainingProjects().map(({ example_count, dataset_count, run_count, ...project }) => project),
      training_examples: this.db.prepare('SELECT * FROM training_examples ORDER BY created_at, rowid').all().map(trainingExampleFromRow),
      training_datasets: this.db.prepare('SELECT * FROM training_datasets ORDER BY created_at, rowid').all().map(trainingDatasetFromRow),
      training_runs: this.db.prepare('SELECT * FROM training_runs ORDER BY created_at, rowid').all().map(trainingRunFromRow),
    };
  }

  importAll(data, { replacePersonas = false } = {}) {
    const tables = {
      personas: 'INSERT OR REPLACE INTO personas (id, name, description, system_prompt, provider, model, temperature, use_memory, use_knowledge, created_at, updated_at) VALUES (:id, :name, :description, :system_prompt, :provider, :model, :temperature, :use_memory, :use_knowledge, :created_at, :updated_at)',
      conversations: 'INSERT OR REPLACE INTO conversations (id, persona_id, title, created_at, updated_at) VALUES (:id, :persona_id, :title, :created_at, :updated_at)',
      messages: 'INSERT OR REPLACE INTO messages (id, conversation_id, role, content, provider, model, tokens_in, tokens_out, created_at) VALUES (:id, :conversation_id, :role, :content, :provider, :model, :tokens_in, :tokens_out, :created_at)',
      memories: 'INSERT OR REPLACE INTO memories (id, content, created_at) VALUES (:id, :content, :created_at)',
      documents: 'INSERT OR REPLACE INTO documents (id, name, size, chunk_count, embedded, created_at) VALUES (:id, :name, :size, :chunk_count, :embedded, :created_at)',
      chunks: 'INSERT OR REPLACE INTO chunks (id, document_id, idx, content, embedding) VALUES (:id, :document_id, :idx, :content, :embedding)',
      model_recipes: `INSERT OR REPLACE INTO model_recipes
        (id, title, name, base, system, parameters, template, license, messages, quantize, created_at, updated_at, last_built_at)
        VALUES (:id, :title, :name, :base, :system, :parameters, :template, :license, :messages, :quantize, :created_at, :updated_at, :last_built_at)`,
      training_projects: `INSERT INTO training_projects
        (id,title,goal,base_model,target_persona_id,method,status,consent,source_conversations,created_at,updated_at)
        VALUES (:id,:title,:goal,:base_model,:target_persona_id,:method,:status,:consent,:source_conversations,:created_at,:updated_at)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,goal=excluded.goal,base_model=excluded.base_model,
        target_persona_id=excluded.target_persona_id,method=excluded.method,status=excluded.status,consent=excluded.consent,
        source_conversations=excluded.source_conversations,created_at=excluded.created_at,updated_at=excluded.updated_at`,
      training_examples: `INSERT OR REPLACE INTO training_examples
        (id,project_id,system,user,assistant,provenance,included,reviewed,risk_flags,content_hash,created_at,updated_at)
        VALUES (:id,:project_id,:system,:user,:assistant,:provenance,:included,:reviewed,:risk_flags,:content_hash,:created_at,:updated_at)`,
      training_datasets: `INSERT INTO training_datasets
        (id,project_id,format,hash,manifest,train_jsonl,eval_jsonl,train_count,eval_count,consent,approved_at,created_at)
        VALUES (:id,:project_id,:format,:hash,:manifest,:train_jsonl,:eval_jsonl,:train_count,:eval_count,:consent,:approved_at,:created_at)
        ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,format=excluded.format,hash=excluded.hash,
        manifest=excluded.manifest,train_jsonl=excluded.train_jsonl,eval_jsonl=excluded.eval_jsonl,
        train_count=excluded.train_count,eval_count=excluded.eval_count,consent=excluded.consent,
        approved_at=excluded.approved_at,created_at=excluded.created_at`,
      training_runs: `INSERT OR REPLACE INTO training_runs
        (id,project_id,dataset_id,endpoint,remote_job_id,status,progress,stage,hyperparameters,submission_consent,metrics,artifact,error,
         evaluation_decision,evaluation_notes,deployed_persona_id,created_at,updated_at,completed_at,deployed_at)
        VALUES (:id,:project_id,:dataset_id,:endpoint,:remote_job_id,:status,:progress,:stage,:hyperparameters,:submission_consent,:metrics,:artifact,:error,
         :evaluation_decision,:evaluation_notes,:deployed_persona_id,:created_at,:updated_at,:completed_at,:deployed_at)`,
    };
    const counts = atomic(this.db, () => {
      // createApp seeds three starter personas before a restore request can be
      // received. A verified-pristine caller may replace only those bootstrap
      // rows so a fresh restore does not duplicate every default persona.
      if (replacePersonas) this.db.prepare('DELETE FROM personas').run();
      // Validate the entire payload before the first INSERT while holding one
      // transaction snapshot, so relationship checks cannot race the writes.
      const validated = validateImport(data, this.db);
      const counts = {};
      for (const [table, sql] of Object.entries(tables)) {
        const rows = validated[table];
        if (!rows) continue;
        const stmt = this.db.prepare(sql);
        for (const row of rows) stmt.run(row);
        counts[table] = rows.length;
      }
      return counts;
    });
    if ((counts.documents ?? 0) > 0 || (counts.chunks ?? 0) > 0) this.knowledgeRevision++;
    return counts;
  }

  close() {
    this.db.close();
  }
}

export class ImportValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

export class ModelRecipeConflictError extends Error {
  constructor(name) {
    super(`A model recipe for artifact "${name}" already exists`);
    this.name = 'ModelRecipeConflictError';
    this.modelName = name;
  }
}

let savepointSequence = 0;

/** A savepoint is atomic and remains safe when a caller already owns a transaction. */
function atomic(db, action) {
  const savepoint = `sovereign_store_${++savepointSequence}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = action();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    } catch {
      // Preserve the original failure; the connection may itself have failed.
    }
    try {
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // Preserve the original failure.
    }
    throw err;
  }
}

const IMPORT_NORMALIZERS = {
  personas: normalizePersona,
  conversations: normalizeConversation,
  messages: normalizeMessage,
  memories: normalizeMemory,
  documents: normalizeDocument,
  chunks: normalizeChunk,
  model_recipes: normalizeModelRecipeRow,
  training_projects: normalizeTrainingProjectRow,
  training_examples: normalizeTrainingExampleRow,
  training_datasets: normalizeTrainingDatasetRow,
  training_runs: normalizeTrainingRunRow,
};

function validateImport(data, db) {
  if (!isObject(data)) throw new ImportValidationError('Import data must be an object');
  const validated = {};
  for (const [table, normalize] of Object.entries(IMPORT_NORMALIZERS)) {
    if (data[table] === undefined) continue;
    if (!Array.isArray(data[table])) throw new ImportValidationError(`Import field "${table}" must be an array`);
    const ids = new Set();
    validated[table] = data[table].map((row, index) => {
      try {
        if (!isObject(row)) throw new Error('row must be an object');
        const normalized = normalize(row);
        if (ids.has(normalized.id)) throw new Error(`duplicate id "${normalized.id}"`);
        ids.add(normalized.id);
        return normalized;
      } catch (err) {
        throw new ImportValidationError(`Invalid ${table}[${index}]: ${err.message}`);
      }
    });
  }
  validateImportRelationships(validated, db);
  return validated;
}

function validateImportRelationships(data, db) {
  const importedPersonas = new Set((data.personas ?? []).map((row) => row.id));
  const importedConversations = new Set((data.conversations ?? []).map((row) => row.id));
  const importedDocuments = new Set((data.documents ?? []).map((row) => row.id));
  const importedTrainingProjects = new Set((data.training_projects ?? []).map((row) => row.id));
  const importedTrainingDatasets = new Set((data.training_datasets ?? []).map((row) => row.id));
  const personaExists = db.prepare('SELECT 1 AS found FROM personas WHERE id = ?');
  const conversationExists = db.prepare('SELECT 1 AS found FROM conversations WHERE id = ?');
  const documentExists = db.prepare('SELECT 1 AS found FROM documents WHERE id = ?');
  const trainingProjectExists = db.prepare('SELECT 1 AS found FROM training_projects WHERE id = ?');
  const trainingDatasetExists = db.prepare('SELECT 1 AS found FROM training_datasets WHERE id = ?');
  const chunkAtPosition = db.prepare('SELECT id FROM chunks WHERE document_id = ? AND idx = ? LIMIT 1');
  const modelRecipeByName = db.prepare('SELECT id FROM model_recipes WHERE name = ? COLLATE NOCASE LIMIT 1');

  // Older databases could retain conversations after their persona was
  // deleted. Preserve those exports without recreating a dangling reference.
  for (const conversation of data.conversations ?? []) {
    if (
      conversation.persona_id &&
      !importedPersonas.has(conversation.persona_id) &&
      !personaExists.get(conversation.persona_id)
    ) {
      conversation.persona_id = null;
    }
  }

  for (const [index, message] of (data.messages ?? []).entries()) {
    if (!importedConversations.has(message.conversation_id) && !conversationExists.get(message.conversation_id)) {
      throw new ImportValidationError(`Invalid messages[${index}]: conversation_id does not reference an imported or existing conversation`);
    }
  }

  const chunkPositions = new Set();
  for (const [index, chunk] of (data.chunks ?? []).entries()) {
    if (!importedDocuments.has(chunk.document_id) && !documentExists.get(chunk.document_id)) {
      throw new ImportValidationError(`Invalid chunks[${index}]: document_id does not reference an imported or existing document`);
    }
    const position = `${chunk.document_id}\0${chunk.idx}`;
    if (chunkPositions.has(position)) {
      throw new ImportValidationError(`Invalid chunks[${index}]: duplicate idx ${chunk.idx} for document ${chunk.document_id}`);
    }
    const existing = chunkAtPosition.get(chunk.document_id, chunk.idx);
    if (existing && existing.id !== chunk.id) {
      throw new ImportValidationError(`Invalid chunks[${index}]: document already has a different chunk at idx ${chunk.idx}`);
    }
    chunkPositions.add(position);
  }

  if (data.documents && data.chunks) {
    const chunksPerDocument = new Map();
    for (const chunk of data.chunks) {
      chunksPerDocument.set(chunk.document_id, (chunksPerDocument.get(chunk.document_id) ?? 0) + 1);
    }
    for (const [index, document] of data.documents.entries()) {
      const actual = chunksPerDocument.get(document.id) ?? 0;
      if (document.chunk_count !== actual) {
        throw new ImportValidationError(
          `Invalid documents[${index}]: chunk_count is ${document.chunk_count}, but import contains ${actual} chunks`
        );
      }
    }
  }

  const importedRecipeIds = new Set((data.model_recipes ?? []).map((row) => row.id));
  const importedRecipeNames = new Set();
  for (const [index, recipe] of (data.model_recipes ?? []).entries()) {
    const key = recipe.name.toLowerCase();
    if (importedRecipeNames.has(key)) {
      throw new ImportValidationError(`Invalid model_recipes[${index}]: duplicate artifact name "${recipe.name}"`);
    }
    const existing = modelRecipeByName.get(recipe.name);
    if (existing && existing.id !== recipe.id && !importedRecipeIds.has(existing.id)) {
      throw new ImportValidationError(
        `Invalid model_recipes[${index}]: artifact name "${recipe.name}" already belongs to another recipe`
      );
    }
    importedRecipeNames.add(key);
  }

  for (const project of data.training_projects ?? []) {
    if (project.target_persona_id && !importedPersonas.has(project.target_persona_id) && !personaExists.get(project.target_persona_id)) {
      project.target_persona_id = null;
    }
  }
  for (const [index, example] of (data.training_examples ?? []).entries()) {
    if (!importedTrainingProjects.has(example.project_id) && !trainingProjectExists.get(example.project_id)) {
      throw new ImportValidationError(`Invalid training_examples[${index}]: project_id does not reference an imported or existing training project`);
    }
  }
  for (const [index, dataset] of (data.training_datasets ?? []).entries()) {
    if (!importedTrainingProjects.has(dataset.project_id) && !trainingProjectExists.get(dataset.project_id)) {
      throw new ImportValidationError(`Invalid training_datasets[${index}]: project_id does not reference an imported or existing training project`);
    }
  }
  for (const [index, run] of (data.training_runs ?? []).entries()) {
    if (!importedTrainingProjects.has(run.project_id) && !trainingProjectExists.get(run.project_id)) {
      throw new ImportValidationError(`Invalid training_runs[${index}]: project_id does not reference an imported or existing training project`);
    }
    if (!importedTrainingDatasets.has(run.dataset_id) && !trainingDatasetExists.get(run.dataset_id)) {
      throw new ImportValidationError(`Invalid training_runs[${index}]: dataset_id does not reference an imported or existing training dataset`);
    }
    if (run.deployed_persona_id && !importedPersonas.has(run.deployed_persona_id) && !personaExists.get(run.deployed_persona_id)) {
      run.deployed_persona_id = null;
    }
  }
}

function normalizePersona(row) {
  return {
    id: requiredId(row.id, 'id'),
    name: requiredText(row.name, 'name', 4096),
    description: optionalNullableText(row.description, '', 'description', 1024 * 1024),
    system_prompt: requiredText(row.system_prompt, 'system_prompt', 20 * 1024 * 1024),
    provider: nullableText(row.provider, 'provider', 2048),
    model: nullableText(row.model, 'model', 2048),
    temperature: nullableNumber(row.temperature, 'temperature'),
    use_memory: binaryFlag(row.use_memory, 'use_memory', 1),
    use_knowledge: binaryFlag(row.use_knowledge, 'use_knowledge', 0),
    created_at: timestamp(row.created_at, 'created_at'),
    updated_at: timestamp(row.updated_at, 'updated_at'),
  };
}

function normalizeConversation(row) {
  return {
    id: requiredId(row.id, 'id'),
    persona_id: nullableText(row.persona_id, 'persona_id', 512),
    title: optionalNullableText(row.title, '', 'title', 10000),
    created_at: timestamp(row.created_at, 'created_at'),
    updated_at: timestamp(row.updated_at, 'updated_at'),
  };
}

function normalizeMessage(row) {
  const role = requiredText(row.role, 'role', 32);
  if (!['user', 'assistant', 'system'].includes(role)) throw new Error('role must be user, assistant, or system');
  return {
    id: requiredId(row.id, 'id'),
    conversation_id: requiredId(row.conversation_id, 'conversation_id'),
    role,
    content: text(row.content, 'content', 20 * 1024 * 1024),
    provider: nullableText(row.provider, 'provider', 2048),
    model: nullableText(row.model, 'model', 2048),
    tokens_in: nullableInteger(row.tokens_in, 'tokens_in', 0),
    tokens_out: nullableInteger(row.tokens_out, 'tokens_out', 0),
    created_at: timestamp(row.created_at, 'created_at'),
  };
}

function normalizeMemory(row) {
  return {
    id: requiredId(row.id, 'id'),
    content: requiredText(row.content, 'content', 20 * 1024 * 1024),
    created_at: timestamp(row.created_at, 'created_at'),
  };
}

function normalizeDocument(row) {
  return {
    id: requiredId(row.id, 'id'),
    name: requiredText(row.name, 'name', 4096),
    size: integer(row.size, 'size', 0),
    chunk_count: integer(row.chunk_count, 'chunk_count', 0),
    embedded: binaryFlag(row.embedded, 'embedded', 0),
    created_at: timestamp(row.created_at, 'created_at'),
  };
}

function normalizeChunk(row) {
  return {
    id: requiredId(row.id, 'id'),
    document_id: requiredId(row.document_id, 'document_id'),
    idx: integer(row.idx, 'idx', 0),
    content: text(row.content, 'content', 20 * 1024 * 1024),
    embedding: normalizeEmbedding(row.embedding),
  };
}

const TRAINING_PROJECT_STATUSES = new Set([
  'draft', 'review', 'approved', 'preparing', 'uploading', 'queued', 'running',
  'evaluating', 'exporting', 'succeeded', 'failed', 'cancel_requested', 'cancelled',
  'unreachable', 'deployed',
]);
const TRAINING_RUN_STATUSES = new Set([
  'preparing', 'uploading', 'queued', 'running', 'evaluating', 'exporting',
  'succeeded', 'failed', 'cancel_requested', 'cancelled', 'unreachable',
]);

function normalizeTrainingProjectRow(row) {
  const method = requiredText(row.method ?? 'sft-lora', 'method', 64);
  if (!['sft-lora', 'sft-qlora'].includes(method)) throw new Error('method must be sft-lora or sft-qlora');
  const status = requiredText(row.status ?? 'draft', 'status', 64);
  if (!TRAINING_PROJECT_STATUSES.has(status)) throw new Error(`unsupported training project status "${status}"`);
  return trainingProjectToRow({
    id: requiredId(row.id, 'id'),
    title: requiredText(row.title, 'title', 200),
    goal: text(row.goal ?? '', 'goal', 20 * 1024),
    base_model: requiredText(row.base_model, 'base_model', 2048),
    target_persona_id: nullableText(row.target_persona_id, 'target_persona_id', 512),
    method,
    status,
    consent: jsonObject(row.consent, 'consent'),
    source_conversations: jsonStringArray(row.source_conversations, 'source_conversations', 10_000),
    created_at: timestamp(row.created_at, 'created_at'),
    updated_at: timestamp(row.updated_at, 'updated_at'),
  });
}

function trainingProjectToRow(project) {
  return {
    id: project.id,
    title: project.title,
    goal: project.goal,
    base_model: project.base_model,
    target_persona_id: project.target_persona_id ?? null,
    method: project.method,
    status: project.status,
    consent: JSON.stringify(project.consent ?? {}),
    source_conversations: JSON.stringify(project.source_conversations ?? []),
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

function trainingProjectFromRow(row) {
  return {
    ...row,
    example_count: row.example_count === undefined ? undefined : Number(row.example_count),
    dataset_count: row.dataset_count === undefined ? undefined : Number(row.dataset_count),
    run_count: row.run_count === undefined ? undefined : Number(row.run_count),
    consent: jsonObject(row.consent, 'consent'),
    source_conversations: jsonStringArray(row.source_conversations, 'source_conversations', 10_000),
  };
}

function normalizeTrainingExampleRow(row) {
  return trainingExampleToRow({
    id: requiredId(row.id, 'id'),
    project_id: requiredId(row.project_id, 'project_id'),
    system: text(row.system ?? '', 'system', 128 * 1024),
    user: requiredText(row.user, 'user', 256 * 1024),
    assistant: requiredText(row.assistant, 'assistant', 256 * 1024),
    provenance: jsonObject(row.provenance, 'provenance'),
    included: binaryFlag(row.included, 'included', 1),
    reviewed: binaryFlag(row.reviewed, 'reviewed', 0),
    risk_flags: jsonStringArray(row.risk_flags, 'risk_flags', 64),
    content_hash: sha256Text(row.content_hash, 'content_hash'),
    created_at: timestamp(row.created_at, 'created_at'),
    updated_at: timestamp(row.updated_at, 'updated_at'),
  });
}

function trainingExampleToRow(example) {
  return {
    id: example.id,
    project_id: example.project_id,
    system: example.system ?? '',
    user: example.user,
    assistant: example.assistant,
    provenance: JSON.stringify(example.provenance ?? {}),
    included: example.included ? 1 : 0,
    reviewed: example.reviewed ? 1 : 0,
    risk_flags: JSON.stringify(example.risk_flags ?? []),
    content_hash: example.content_hash,
    created_at: example.created_at,
    updated_at: example.updated_at,
  };
}

function trainingExampleFromRow(row) {
  return {
    ...row,
    included: Boolean(row.included),
    reviewed: Boolean(row.reviewed),
    provenance: jsonObject(row.provenance, 'provenance'),
    risk_flags: jsonStringArray(row.risk_flags, 'risk_flags', 64),
  };
}

function normalizeTrainingDatasetRow(row) {
  return trainingDatasetToRow({
    id: requiredId(row.id, 'id'),
    project_id: requiredId(row.project_id, 'project_id'),
    format: requiredText(row.format, 'format', 128),
    hash: sha256Text(row.hash, 'hash'),
    manifest: jsonObject(row.manifest, 'manifest'),
    train_jsonl: text(row.train_jsonl, 'train_jsonl', 20 * 1024 * 1024),
    eval_jsonl: text(row.eval_jsonl ?? '', 'eval_jsonl', 20 * 1024 * 1024),
    train_count: integer(row.train_count, 'train_count', 0),
    eval_count: integer(row.eval_count, 'eval_count', 0),
    consent: jsonObject(row.consent, 'consent'),
    approved_at: timestamp(row.approved_at, 'approved_at'),
    created_at: timestamp(row.created_at, 'created_at'),
  });
}

function trainingDatasetToRow(dataset) {
  return {
    id: dataset.id,
    project_id: dataset.project_id,
    format: dataset.format,
    hash: dataset.hash,
    manifest: JSON.stringify(dataset.manifest ?? {}),
    train_jsonl: dataset.train_jsonl,
    eval_jsonl: dataset.eval_jsonl ?? '',
    train_count: dataset.train_count,
    eval_count: dataset.eval_count,
    consent: JSON.stringify(dataset.consent ?? {}),
    approved_at: dataset.approved_at,
    created_at: dataset.created_at,
  };
}

function trainingDatasetFromRow(row) {
  return {
    ...row,
    train_count: Number(row.train_count),
    eval_count: Number(row.eval_count),
    manifest: jsonObject(row.manifest, 'manifest'),
    consent: jsonObject(row.consent, 'consent'),
  };
}

function normalizeTrainingRunRow(row) {
  const status = requiredText(row.status, 'status', 64);
  if (!TRAINING_RUN_STATUSES.has(status)) throw new Error(`unsupported training run status "${status}"`);
  const decision = row.evaluation_decision === undefined || row.evaluation_decision === null
    ? null
    : requiredText(row.evaluation_decision, 'evaluation_decision', 32);
  if (decision && !['approved', 'rejected', 'skipped'].includes(decision)) {
    throw new Error('evaluation_decision must be approved, rejected, skipped, or null');
  }
  const progress = nullableNumber(row.progress, 'progress');
  if (progress !== null && (progress < 0 || progress > 1)) throw new Error('progress must be between 0 and 1');
  return trainingRunToRow({
    id: requiredId(row.id, 'id'),
    project_id: requiredId(row.project_id, 'project_id'),
    dataset_id: requiredId(row.dataset_id, 'dataset_id'),
    endpoint: requiredText(row.endpoint, 'endpoint', 2048),
    remote_job_id: nullableText(row.remote_job_id, 'remote_job_id', 512),
    status,
    progress,
    stage: text(row.stage ?? '', 'stage', 1024),
    hyperparameters: jsonObject(row.hyperparameters, 'hyperparameters'),
    submission_consent: jsonObject(row.submission_consent ?? {}, 'submission_consent'),
    metrics: jsonObject(row.metrics, 'metrics'),
    artifact: jsonNullableObject(row.artifact, 'artifact'),
    error: nullableText(row.error, 'error', 64 * 1024),
    evaluation_decision: decision,
    evaluation_notes: text(row.evaluation_notes ?? '', 'evaluation_notes', 64 * 1024),
    deployed_persona_id: nullableText(row.deployed_persona_id, 'deployed_persona_id', 512),
    created_at: timestamp(row.created_at, 'created_at'),
    updated_at: timestamp(row.updated_at, 'updated_at'),
    completed_at: nullableTimestamp(row.completed_at, 'completed_at'),
    deployed_at: nullableTimestamp(row.deployed_at, 'deployed_at'),
  });
}

function trainingRunToRow(run) {
  return {
    id: run.id,
    project_id: run.project_id,
    dataset_id: run.dataset_id,
    endpoint: run.endpoint,
    remote_job_id: run.remote_job_id ?? null,
    status: run.status,
    progress: run.progress ?? null,
    stage: run.stage ?? '',
    hyperparameters: JSON.stringify(run.hyperparameters ?? {}),
    submission_consent: JSON.stringify(run.submission_consent ?? {}),
    metrics: JSON.stringify(run.metrics ?? {}),
    artifact: run.artifact === null || run.artifact === undefined ? null : JSON.stringify(run.artifact),
    error: run.error ?? null,
    evaluation_decision: run.evaluation_decision ?? null,
    evaluation_notes: run.evaluation_notes ?? '',
    deployed_persona_id: run.deployed_persona_id ?? null,
    created_at: run.created_at,
    updated_at: run.updated_at,
    completed_at: run.completed_at ?? null,
    deployed_at: run.deployed_at ?? null,
  };
}

function trainingRunFromRow(row) {
  return {
    ...row,
    progress: row.progress === null ? null : Number(row.progress),
    hyperparameters: jsonObject(row.hyperparameters, 'hyperparameters'),
    submission_consent: jsonObject(row.submission_consent ?? {}, 'submission_consent'),
    metrics: jsonObject(row.metrics, 'metrics'),
    artifact: jsonNullableObject(row.artifact, 'artifact'),
  };
}

function normalizeModelRecipeRow(row) {
  let parameters = row.parameters;
  let messages = row.messages;
  try {
    if (typeof parameters === 'string') parameters = JSON.parse(parameters);
  } catch {
    throw new Error('parameters must contain valid JSON');
  }
  try {
    if (typeof messages === 'string') messages = JSON.parse(messages);
  } catch {
    throw new Error('messages must contain valid JSON');
  }

  let normalized;
  try {
    normalized = normalizeModelRecipe({ ...row, parameters, messages });
  } catch (err) {
    throw new Error(err.message);
  }
  return modelRecipeToRow({
    ...normalized,
    id: requiredId(row.id, 'id'),
    created_at: timestamp(row.created_at, 'created_at'),
    updated_at: timestamp(row.updated_at, 'updated_at'),
    last_built_at: nullableTimestamp(row.last_built_at, 'last_built_at'),
  });
}

function modelRecipeToRow(recipe) {
  return {
    id: recipe.id,
    title: recipe.title,
    name: recipe.name,
    base: recipe.base,
    system: recipe.system,
    parameters: JSON.stringify(recipe.parameters),
    template: recipe.template,
    license: recipe.license,
    messages: JSON.stringify(recipe.messages),
    quantize: recipe.quantize,
    created_at: recipe.created_at,
    updated_at: recipe.updated_at,
    last_built_at: recipe.last_built_at ?? null,
  };
}

function modelRecipeFromRow(row) {
  return {
    ...row,
    parameters: JSON.parse(row.parameters),
    messages: JSON.parse(row.messages),
  };
}

function modelRecipeBuildSignature(recipe) {
  return JSON.stringify({
    name: recipe.name,
    base: recipe.base,
    system: recipe.system,
    parameters: recipe.parameters,
    template: recipe.template,
    license: recipe.license,
    messages: recipe.messages,
    quantize: recipe.quantize,
  });
}

function rethrowModelRecipeNameConflict(err, name) {
  if (/UNIQUE constraint failed/i.test(err?.message ?? '') && /model_recipes|idx_model_recipes_name_nocase/i.test(err.message)) {
    throw new ModelRecipeConflictError(name);
  }
  throw err;
}

function requiredId(value, label) {
  return requiredText(value, label, 512);
}

function requiredText(value, label, max) {
  const valueAsText = text(value, label, max);
  if (!valueAsText.trim()) throw new Error(`${label} must not be empty`);
  return valueAsText;
}

function text(value, label, max) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return value;
}

function optionalNullableText(value, fallback, label, max) {
  if (value === undefined) return fallback;
  return value === null ? null : text(value, label, max);
}

function nullableText(value, label, max) {
  return value === undefined || value === null ? null : text(value, label, max);
}

function timestamp(value, label) {
  return value === undefined ? now() : requiredText(value, label, 128);
}

function nullableTimestamp(value, label) {
  return value === undefined || value === null ? null : requiredText(value, label, 128);
}

function integer(value, label, min) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${label} must be a safe integer of at least ${min}`);
  return value;
}

function nullableInteger(value, label, min) {
  return value === undefined || value === null ? null : integer(value, label, min);
}

function nullableNumber(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number or null`);
  return value;
}

function binaryFlag(value, label, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new Error(`${label} must be true, false, 0, or 1`);
}

function jsonParsed(value, label, maxBytes = 20 * 1024 * 1024) {
  let parsed = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`${label} JSON exceeds ${maxBytes} bytes`);
    try { parsed = JSON.parse(value); }
    catch { throw new Error(`${label} must contain valid JSON`); }
  }
  return parsed;
}

function jsonObject(value, label) {
  const parsed = jsonParsed(value ?? {}, label);
  if (!isObject(parsed)) throw new Error(`${label} must be a JSON object`);
  return structuredClone(parsed);
}

function jsonNullableObject(value, label) {
  if (value === undefined || value === null) return null;
  return jsonObject(value, label);
}

function jsonStringArray(value, label, maxItems) {
  const parsed = jsonParsed(value ?? [], label);
  if (!Array.isArray(parsed) || parsed.length > maxItems || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be an array of at most ${maxItems} strings`);
  }
  return [...parsed];
}

function sha256Text(value, label) {
  const normalized = requiredText(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return normalized;
}

function normalizeEmbedding(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('embedding must be a JSON string or null');
  let vector;
  try {
    vector = JSON.parse(value);
  } catch {
    throw new Error('embedding must contain valid JSON');
  }
  if (!Array.isArray(vector) || vector.length > 65536 || !vector.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error('embedding must be an array of finite numbers with at most 65536 dimensions');
  }
  return JSON.stringify(vector);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
