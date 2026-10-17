// OpenCode hook tests. The plugin mutates the event in place and returns
// nothing, so these tests drive the registered callbacks with plain objects.
const test = require('node:test');
const assert = require('node:assert');
const plugin = require('../index.js');

async function session() {
 const registered = {};
 await plugin.setup({ tool: { hook: async (name, callback) => { registered[name] = callback; } } });
 return registered;
}

test('satisfies the OpenCode loader contract', () => {
 assert.strictEqual(plugin.id, 'omp-harness-fix');
 assert.strictEqual(typeof plugin.setup, 'function');
 assert.strictEqual(typeof plugin.onToolCall, 'function', 'OMP hooks must survive the OpenCode entry');
});

test('execute.before fills the gaps OpenCode does not cover', async () => {
 const { 'execute.before': before } = await session();

 const md = { tool: 'read', id: 'c2', input: { filePath: '/proj/[notes.md](http://notes.md)' } };
 await before(md);
 assert.strictEqual(md.input.filePath, '/proj/notes.md');

 const go = { tool: 'shell', id: 'c3', input: { command: 'go test' } };
 await before(go);
 assert.strictEqual(go.input.command, 'go test ./...');

 const svelte = { tool: 'shell', id: 'c4', input: { command: 'npm run svelte-check' } };
 await before(svelte);
 assert.strictEqual(svelte.input.command, 'npm run svelte-check --tsconfig ./tsconfig.json');
});

test('execute.before leaves the four shapes to the runtime', async () => {
 const { 'execute.before': before } = await session();

 // OpenCode's built-in repair owns these, schema-driven; doing them here too
 // would be a coarser second pass that can corrupt a valid string.
 const shapes = { tool: 'edit', id: 'c1', input: { path: null, tags: '["a","b"]', extra: {} } };
 await before(shapes);
 assert.deepStrictEqual(shapes.input, { path: null, tags: '["a","b"]', extra: {} });
});

test('execute.before leaves valid input alone', async () => {
 const { 'execute.before': before } = await session();

 const real = { tool: 'write', id: 'c1', input: { filePath: 'a.md', content: '[click](https://x.com)' } };
 await before(real);
 assert.deepStrictEqual(real.input, { filePath: 'a.md', content: '[click](https://x.com)' });

 const paired = { tool: 'read', id: 'c2', input: { offset: 10, limit: 5 } };
 await before(paired);
 assert.deepStrictEqual(paired.input, { offset: 10, limit: 5 });

 // CodeMode sends `execute` a code string, not an object — it must survive intact
 const code = { tool: 'execute', id: 'c3', input: 'const a = 1' };
 await before(code);
 assert.strictEqual(code.input, 'const a = 1');
});

test('a defaulted range is surfaced on the tool result', async () => {
 const { 'execute.before': before, 'execute.after': after } = await session();

 const call = { tool: 'read', id: 'c1', input: { limit: 30 } };
 await before(call);
 assert.deepStrictEqual(call.input, { limit: 30, offset: 0 });

 const result = { tool: 'read', id: 'c1', status: 'completed', result: { content: [{ type: 'text', text: 'body' }], output: '' } };
 await after(result);
 assert.strictEqual(result.result.content.length, 2);
 assert.match(result.result.content[1].text, /offset=0/);
 assert.strictEqual(result.result.content[1].type, 'text');

 // both fields given: nothing was defaulted, nothing is said
 const paired = { tool: 'read', id: 'c2', input: { offset: 10, limit: 5 } };
 await before(paired);
 const quiet = { tool: 'read', id: 'c2', status: 'completed', result: { content: [{ type: 'text', text: 'body' }] } };
 await after(quiet);
 assert.strictEqual(quiet.result.content.length, 1);
});

test('only raw schema blobs are humanized', async () => {
 const { 'execute.before': before, 'execute.after': after } = await session();

 const call = { tool: 'read', id: 'c1', input: { limit: 30 } };
 await before(call);
 const failed = { tool: 'read', id: 'c1', status: 'error', error: { message: 'invalid_type: Expected string, received null' } };
 await after(failed);
 assert.match(failed.error.message, /\[Tool Input Error in 'read'\]/);

 const ordinary = { tool: 'read', id: 'c2', status: 'error', error: { message: 'File not found: a.md' } };
 await after(ordinary);
 assert.strictEqual(ordinary.error.message, 'File not found: a.md');
});
