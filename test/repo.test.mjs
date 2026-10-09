// Repository consistency guards: versions, tool names across docs and code, plugin root layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createTools } from '../server/lib/tools.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
const PREFIX = `mcp__plugin_${plugin.name}_telegram__`;
const toolNames = createTools({ tokenError: 'x', pairing: { currentBinding: () => null }, quiet: { enabled: false }, redact: (s) => s }).list().map((t) => t.name);

test('version is the same in plugin.json, package.json, main.mjs and index.mjs; CHANGELOG has it', () => {
  const v = plugin.version;
  assert.equal(JSON.parse(read('package.json')).version, v);
  assert.match(read('server/main.mjs'), new RegExp(`const VERSION = '${v.replace(/\./g, '\\.')}'`));
  assert.match(read('server/index.mjs'), new RegExp(`version: '${v.replace(/\./g, '\\.')}'`));
  assert.match(read('CHANGELOG.md'), new RegExp(`## \\[${v.replace(/\./g, '\\.')}\\]`));
});

test('marketplace lists this plugin under the same name', () => {
  const m = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.equal(m.name, plugin.name);
  assert.deepEqual(m.plugins.map((p) => p.name), [plugin.name]);
});

test('fallback tool lists in index.mjs and main.mjs match the real tools', () => {
  for (const file of ['server/index.mjs', 'server/main.mjs']) {
    const list = /(?:TOOL_NAMES|FALLBACK_TOOL_NAMES) = \[([^\]]+)\]/.exec(read(file))[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1));
    assert.deepEqual(list, toolNames, file);
  }
});

test('every tool named in the skill, the command and the README exists', () => {
  for (const file of ['skills/telegram/SKILL.md', 'commands/rebind.md', 'README.md', 'docs/development.md']) {
    const named = [...read(file).matchAll(/mcp__plugin_[\w-]+?_telegram__(\w+)/g)];
    for (const [full, tool] of named) {
      assert.ok(full.startsWith(PREFIX), `${file}: ${full} has a wrong plugin prefix`);
      assert.ok(toolNames.includes(tool), `${file}: unknown tool ${tool}`);
    }
  }
});

test('no CLAUDE.md at the plugin root (breaks claude plugin validate --strict); rules live in AGENTS.md', () => {
  assert.equal(existsSync(new URL('../CLAUDE.md', import.meta.url)), false);
  assert.match(read('.claude/CLAUDE.md'), /@\.\.\/AGENTS\.md/);
});
