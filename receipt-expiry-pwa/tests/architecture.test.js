import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.ci-')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const serverFiles = [
  ...walk(path.join(ROOT, 'functions')),
  ...walk(path.join(ROOT, 'ratelimit-worker')),
  ...walk(path.join(ROOT, 'oci')),
];
const sourceFiles = [...serverFiles, ...walk(path.join(ROOT, 'public/js'))];

function owners(pattern) {
  return sourceFiles.filter((file) => pattern.test(read(file))).map(relative).sort();
}

function definitionOwners(name) {
  const declaration = `(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+${name}\\b`;
  const reExport = `export\\s*\\{[^}]*\\b${name}\\b`;
  return owners(new RegExp(`${declaration}|${reExport}`));
}

test('server modules never import browser code', () => {
  const pattern = /\b(?:from|import|require)\s*\(?\s*['"][^'"]*public\/js\//;
  assert.deepEqual(serverFiles.filter((file) => pattern.test(read(file))).map(relative), []);
});

test('notification schedule helpers have a single production definition', () => {
  for (const name of ['jstDate', 'shouldSendAtHour']) {
    assert.deepEqual(definitionOwners(name), ['functions/shared/schedule.js']);
  }
});

test('rate policy constants and subscription limit have a single declaration', () => {
  const names = [
    'ANALYSIS_RATE', 'SUBSCRIPTION_RATE',
    'RATE_PER_MINUTE', 'RATE_PER_DAY',
    'BYOK_RATE_PER_MINUTE', 'BYOK_RATE_PER_DAY', 'BYOK_RATE_DAY',
    'MAX_PER_HOUR', 'MAX_TOTAL', 'RATE_WINDOW_SECONDS', 'VALIDATE_RATE_PER_MINUTE',
  ].join('|');
  assert.deepEqual(
    owners(new RegExp(`(?:export\\s+)?const\\s+(?:${names})\\s*=`)),
    ['functions/shared/limits.js'],
  );
  assert.deepEqual(definitionOwners('isSubscriptionRateLimited'), ['functions/shared/limits.js']);
});

test('shared browser helpers have a single definition', () => {
  assert.deepEqual(definitionOwners('newId'), ['public/js/ids.js']);
  assert.deepEqual(definitionOwners('loadImageElement'), ['public/js/imageProcessor.js']);
});

test('service worker precaches every browser module', () => {
  const sw = read(path.join(ROOT, 'public/sw.js'));
  const precached = new Set([...sw.matchAll(/'(\/js\/[^']+\.js)'/g)].map((match) => match[1]));
  const modules = walk(path.join(ROOT, 'public/js')).map((file) => `/js/${path.basename(file)}`);
  assert.deepEqual(modules.filter((module) => !precached.has(module)), []);
});

test('browser domain values are declared once', () => {
  const browserFiles = walk(path.join(ROOT, 'public/js'));
  for (const name of ['STORAGE_TYPES', 'STORAGE_LABELS', 'CONSUMPTION_REASONS', 'THEMES', 'DEFAULT_NOTIFY_HOUR']) {
    const pattern = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=`);
    assert.deepEqual(
      browserFiles.filter((file) => pattern.test(read(file))).map(relative),
      ['public/js/domain.js'],
    );
  }
});
