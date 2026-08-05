import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HfCatalogError, searchGgufModels, listGgufFiles } from '../src/hf-catalog.js';

function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test('searchGgufModels rejects an empty or whitespace-only query without a network call', async () => {
  await withFetch(
    () => {
      throw new Error('must not call fetch for an invalid query');
    },
    async () => {
      await assert.rejects(() => searchGgufModels(''), (err) => err instanceof HfCatalogError && err.status === 400);
      await assert.rejects(() => searchGgufModels('   '), (err) => err instanceof HfCatalogError && err.status === 400);
    }
  );
});

test('searchGgufModels rejects an overlong query', async () => {
  await assert.rejects(() => searchGgufModels('x'.repeat(201)), (err) => err.status === 400);
});

test('searchGgufModels maps Hugging Face results, extracts license tags, and drops entries without an id', async () => {
  let requestedUrl;
  await withFetch(
    async (url) => {
      requestedUrl = url.toString();
      return new Response(
        JSON.stringify([
          {
            id: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
            downloads: 42,
            likes: 7,
            tags: ['gguf', 'license:apache-2.0'],
            lastModified: '2026-01-01T00:00:00Z',
          },
          { id: '', downloads: 1 },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    },
    async () => {
      const results = await searchGgufModels('llama 3.2');
      assert.equal(results.length, 1);
      assert.deepEqual(results[0], {
        id: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
        url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF',
        downloads: 42,
        likes: 7,
        license: 'apache-2.0',
        updatedAt: '2026-01-01T00:00:00Z',
      });
    }
  );
  assert.ok(requestedUrl.startsWith('https://huggingface.co/api/models?'));
  assert.ok(requestedUrl.includes('search=llama'));
  assert.ok(requestedUrl.includes('filter=gguf'));
});

test('searchGgufModels surfaces a Hugging Face HTTP error with a bounded status', async () => {
  await withFetch(
    async () => new Response('rate limited', { status: 429 }),
    async () => {
      await assert.rejects(() => searchGgufModels('llama'), (err) => err instanceof HfCatalogError && err.status === 429);
    }
  );
});

test('searchGgufModels rejects an unexpected (non-array) response shape', async () => {
  await withFetch(
    async () => new Response(JSON.stringify({ not: 'an array' }), { status: 200 }),
    async () => {
      await assert.rejects(() => searchGgufModels('llama'), (err) => err instanceof HfCatalogError && err.status === 502);
    }
  );
});

test('searchGgufModels wraps a network failure without leaking the raw error', async () => {
  await withFetch(
    async () => {
      throw new Error('DNS failure');
    },
    async () => {
      await assert.rejects(
        () => searchGgufModels('llama'),
        (err) => err instanceof HfCatalogError && err.status === 502 && /Could not reach huggingface\.co/.test(err.message)
      );
    }
  );
});

test('listGgufFiles rejects a malformed repo id before any network call', async () => {
  await withFetch(
    () => {
      throw new Error('must not call fetch for an invalid repo id');
    },
    async () => {
      await assert.rejects(() => listGgufFiles(''), (err) => err.status === 400);
      await assert.rejects(() => listGgufFiles('not-a-repo'), (err) => err.status === 400);
      await assert.rejects(() => listGgufFiles('../../etc/passwd'), (err) => err.status === 400);
      await assert.rejects(() => listGgufFiles('owner/name/extra'), (err) => err.status === 400);
    }
  );
});

test('listGgufFiles guesses quantization from GGUF filenames and ignores non-GGUF siblings', async () => {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          siblings: [
            { rfilename: 'model.Q8_0.gguf' },
            { rfilename: 'model.Q4_K_M.gguf' },
            { rfilename: 'model.gguf' },
            { rfilename: 'README.md' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ),
    async () => {
      const { files, license } = await listGgufFiles('bartowski/Llama-3.2-1B-Instruct-GGUF');
      assert.equal(license, null, 'a repo with no license declaration must report null, never a guess');
      assert.deepEqual(files, [
        { filename: 'model.Q4_K_M.gguf', quantization: 'Q4_K_M', base: 'hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M' },
        { filename: 'model.Q8_0.gguf', quantization: 'Q8_0', base: 'hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q8_0' },
        { filename: 'model.gguf', quantization: null, base: 'hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF' },
      ]);
    }
  );
});

test('listGgufFiles recognizes hyphen-separated quant labels, not just dot-separated ones', async () => {
  // Regression: bartowski's GGUF conversions (a very common source) hyphenate
  // the quant label ("Llama-3.2-1B-Instruct-Q4_K_M.gguf") rather than using a
  // dot. Verified against the live huggingface.co/api/models/bartowski/
  // Llama-3.2-1B-Instruct-GGUF response, which contains these exact names.
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          siblings: [
            { rfilename: 'Llama-3.2-1B-Instruct-IQ3_M.gguf' },
            { rfilename: 'Llama-3.2-1B-Instruct-Q4_0_4_4.gguf' },
            { rfilename: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf' },
            { rfilename: 'Llama-3.2-1B-Instruct-Q6_K.gguf' },
            { rfilename: 'Llama-3.2-1B-Instruct-f16.gguf' },
            { rfilename: 'Llama-3.2-1B-Instruct.imatrix' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ),
    async () => {
      const { files } = await listGgufFiles('bartowski/Llama-3.2-1B-Instruct-GGUF');
      assert.deepEqual(
        files.map((f) => f.quantization),
        ['IQ3_M', 'Q4_0_4_4', 'Q4_K_M', 'Q6_K', 'F16']
      );
      assert.equal(
        files.find((f) => f.filename === 'Llama-3.2-1B-Instruct-Q4_K_M.gguf').base,
        'hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M'
      );
    }
  );
});

test('listGgufFiles returns an empty list when the repo has no siblings metadata', async () => {
  await withFetch(
    async () => new Response(JSON.stringify({}), { status: 200 }),
    async () => {
      const { files, license } = await listGgufFiles('owner/repo');
      assert.deepEqual(files, []);
      assert.equal(license, null);
    }
  );
});
