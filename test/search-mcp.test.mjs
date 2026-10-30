// Drives scripts/search-mcp.mjs over stdio against a throwaway git repository, the way Claude Code does.
// Usage: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = mkdtempSync(join(tmpdir(), 'search-mcp-'));
mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
writeFileSync(join(repo, 'src', 'deep', 'users.js'), 'function findUser(users, id) {\n  return users.find(u => u.id === id);\n}\n');
writeFileSync(join(repo, 'src', 'hello.txt'), 'hello\n');
writeFileSync(join(repo, 'README.md'), '# Not matched by code globs\n');
// Skipped by default, like the diff step skips them: a lockfile and a vendored copy that both mention the symbol.
writeFileSync(join(repo, 'package-lock.json'), '{"findUser": 1}\n');
mkdirSync(join(repo, 'vendor'));
writeFileSync(join(repo, 'vendor', 'v.js'), 'function findUser() {}\n');
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
git('init', '-q', '.'); git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

// One request, one response line.
async function call(method, params, id = 1) {
  const server = spawn(process.execPath, [new URL('../scripts/search-mcp.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')], { cwd: repo });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  await new Promise((r) => server.on('close', r));
  return JSON.parse(out.trim().split('\n').at(-1));
}
const text = (r) => r.result.content[0].text;

test('initialize answers with the tools capability', async () => {
  const r = await call('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(r.result.serverInfo.name, 'search');
  assert.deepEqual(r.result.capabilities, { tools: {} });
});

test('tools/list names grep and glob', async () => {
  const r = await call('tools/list', {});
  assert.deepEqual(r.result.tools.map((t) => t.name), ['grep', 'glob']);
});

test('grep returns path:line:text', async () => {
  assert.equal(text(await call('tools/call', { name: 'grep', arguments: { pattern: 'findUser' } })), 'src/deep/users.js:1:function findUser(users, id) {');
});

test('grep with a path and no match says so', async () => {
  assert.equal(text(await call('tools/call', { name: 'grep', arguments: { pattern: 'findUser', path: 'README.md' } })), 'no matches');
});

test('a pattern that looks like an option is still a pattern', async () => {
  assert.equal(text(await call('tools/call', { name: 'grep', arguments: { pattern: '-> ' } })), 'no matches');
});

test('glob spans directories with ** and stays within one with *', async () => {
  assert.equal(text(await call('tools/call', { name: 'glob', arguments: { pattern: '**/*.js' } })), 'src/deep/users.js');
  assert.equal(text(await call('tools/call', { name: 'glob', arguments: { pattern: 'src/*.txt' } })), 'src/hello.txt');
  assert.equal(text(await call('tools/call', { name: 'glob', arguments: { pattern: '*.js' } })), 'no matches');
  assert.equal(text(await call('tools/call', { name: 'glob', arguments: { pattern: 'src/**' } })), 'src/deep/users.js\nsrc/hello.txt');
});

test('lockfiles and vendored files are skipped unless include_generated is set', async () => {
  assert.equal(text(await call('tools/call', { name: 'grep', arguments: { pattern: 'findUser', include_generated: true } })),
    'package-lock.json:1:{"findUser": 1}\nsrc/deep/users.js:1:function findUser(users, id) {\nvendor/v.js:1:function findUser() {}');
  assert.equal(text(await call('tools/call', { name: 'grep', arguments: { pattern: 'findUser', path: 'vendor' } })), 'no matches');
  assert.equal(text(await call('tools/call', { name: 'glob', arguments: { pattern: '**/*.js', include_generated: true } })), 'src/deep/users.js\nvendor/v.js');
  assert.equal(text(await call('tools/call', { name: 'glob', arguments: { pattern: '**/*.json' } })), 'no matches');
});

test('a bad regex is an error, not "no matches"; a path with nothing under it is "no matches"', async () => {
  for (const pattern of ['(?=foo)', 'foo(', '[']) {
    const bad = await call('tools/call', { name: 'grep', arguments: { pattern } });
    assert.equal(bad.result.isError, true, pattern);
    assert.match(text(bad), /git grep failed/);
  }
  assert.equal(text(await call('tools/call', { name: 'grep', arguments: { pattern: 'x', path: 'nope/' } })), 'no matches');
});

test('a path outside the repository is refused', async () => {
  for (const path of ['../', '/etc', '~/x', 'src/../../x', '--help']) {
    const r = await call('tools/call', { name: 'grep', arguments: { pattern: 'x', path } });
    assert.equal(r.result.isError, true, path);
  }
});

test('an unknown tool or method is an error', async () => {
  assert.equal((await call('tools/call', { name: 'bash', arguments: {} })).error.code, -32602);
  assert.equal((await call('resources/list', {})).error.code, -32601);
});
