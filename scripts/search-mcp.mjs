#!/usr/bin/env node
// Read-only search for the reviewer: grep and glob over the checked-out repository, through git with no shell,
// since native Claude Code builds dropped the Grep and Glob tools and Bash must stay off while the job holds the
// owner's token. Speaks MCP over stdio (one JSON-RPC message per line). Run it from the repository root.
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';

const git = (args) => new Promise((resolve) => execFile('git', args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 << 20 },
  (err, out) => resolve(err && !out ? '' : out))); // git grep exits 1 on no match and 128 on a bad path: both read as empty
const clip = (text, max) => {
  const lines = text.split('\n').filter(Boolean).map(l => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
  if (lines.length > max) lines.splice(max, lines.length, `… ${lines.length - max} more lines not shown; narrow the search`);
  return lines.join('\n') || 'no matches';
};
// A path must stay inside the repository and cannot be mistaken for an option.
const safePath = (p) => {
  if (typeof p !== 'string' || /^[-/~]|^\.\.(\/|$)|\/\.\.(\/|$)/.test(p)) throw new Error('path must be relative to the repository root');
  return p;
};
// Token by token, so a replacement never rewrites an earlier one: **/ spans directories, * and ? stay within one.
const globToRegExp = (g) => new RegExp(`^${g.replace(/\*\*\/|\*\*|\*|\?|[^*?]+/g, (t) =>
  t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))}$`);

const tools = {
  grep: {
    description: 'Search file contents in the repository with an extended regular expression (git grep). Returns path:line:text, at most 200 lines.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regular expression (POSIX ERE)' },
        path: { type: 'string', description: 'File or directory to search, relative to the repository root; the whole repository when omitted' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive match' },
      },
      required: ['pattern'],
    },
    run: async ({ pattern, path = '.', ignore_case = false }) => {
      if (typeof pattern !== 'string' || !pattern) throw new Error('pattern is required');
      return clip(await git(['grep', '-n', '-I', '-E', '--no-color', ...(ignore_case ? ['-i'] : []), '-e', pattern, '--', safePath(path)]), 200);
    },
  },
  glob: {
    description: 'List tracked files whose path matches a glob, e.g. src/**/*.ts or **/routes.php. Returns at most 500 paths.',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob over paths relative to the repository root; ** spans directories' } }, required: ['pattern'] },
    run: async ({ pattern }) => {
      if (typeof pattern !== 'string' || !pattern) throw new Error('pattern is required');
      const re = globToRegExp(pattern);
      return clip((await git(['ls-files'])).split('\n').filter(f => f && re.test(f)).join('\n'), 500);
    },
  },
};

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notifications need no answer
  switch (method) {
    case 'initialize':
      return reply(id, { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'search', version: '1.0.0' } });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const tool = tools[params.name];
      if (!tool) return fail(id, -32602, `unknown tool ${params.name}`);
      try { return reply(id, { content: [{ type: 'text', text: await tool.run(params.arguments ?? {}) }] }); }
      catch (e) { return reply(id, { content: [{ type: 'text', text: e.message }], isError: true }); }
    }
    default:
      return fail(id, -32601, `unknown method ${method}`);
  }
});
