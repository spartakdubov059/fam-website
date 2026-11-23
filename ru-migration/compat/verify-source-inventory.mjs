#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const compatDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(compatDirectory, '../..');
const sourceRef = process.argv[2] || 'origin/main';
const inventoryPath = path.join(repositoryRoot, 'ru-migration/SUPABASE_MIGRATION_INVENTORY_2026-11-20.md');
const migrationDirectories = [
  path.join(repositoryRoot, 'supabase/migrations'),
  path.join(repositoryRoot, 'ru-migration/source-reference/supabase-migrations'),
];

function fail(message) {
  console.error(`SOURCE_MIGRATION_INVENTORY_FAIL: ${message}`);
  process.exitCode = 1;
}

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trimEnd();
}

let sourceFiles;
try {
  sourceFiles = new Map(git(['ls-tree', '-r', sourceRef, '--', 'supabase/migrations'])
    .split('\n').filter(Boolean).map(line => {
      const match = line.match(/^\d+ blob ([a-f0-9]+)\tsupabase\/migrations\/(.+)$/);
      if (!match) throw new Error(`unexpected Git tree entry: ${line}`);
      return [match[2], match[1]];
    }));
} catch (error) {
  console.error(`Cannot read SQL migration tree for Git ref ${sourceRef}: ${error.message}`);
  process.exit(2);
}

const localFiles = new Map();
for (const directory of migrationDirectories) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    if (localFiles.has(entry.name)) fail(`duplicate local migration filename: ${entry.name}`);
    localFiles.set(entry.name, path.relative(repositoryRoot, path.join(directory, entry.name)));
  }
}

const inventory = await readFile(inventoryPath, 'utf8');
const inventoryFiles = new Set([...inventory.matchAll(/`(?:supabase\/migrations\/)?(\d{14}_[A-Za-z0-9_-]+\.sql)`/g)]
  .map(match => match[1]));

for (const name of sourceFiles.keys()) {
  if (!localFiles.has(name)) fail(`missing local copy of ${name}`);
  if (!inventoryFiles.has(name)) fail(`missing filename in migration inventory: ${name}`);
}
for (const name of localFiles.keys()) {
  if (!sourceFiles.has(name)) fail(`local SQL file is absent from ${sourceRef}: ${name}`);
}
for (const name of inventoryFiles) {
  if (!sourceFiles.has(name)) fail(`inventory filename is absent from ${sourceRef}: ${name}`);
}

let hashMismatches = 0;
for (const [name, localPath] of localFiles) {
  if (!sourceFiles.has(name)) continue;
  const localBlob = git(['hash-object', '--', localPath]);
  if (localBlob !== sourceFiles.get(name)) {
    hashMismatches++;
    fail(`Git blob mismatch for ${name}: source=${sourceFiles.get(name)}, local=${localBlob}`);
  }
}

if (inventoryFiles.size !== sourceFiles.size) {
  fail(`inventory has ${inventoryFiles.size} unique filenames, source tree has ${sourceFiles.size}`);
}

if (process.exitCode) process.exit(process.exitCode);
const checkedRef = git(['rev-parse', sourceRef]);
console.log(`SOURCE_MIGRATION_INVENTORY_PASS: ${sourceFiles.size} upstream files, ${localFiles.size} local copies, ${inventoryFiles.size} inventory names; ${hashMismatches} blob mismatches.`);
console.log(`Source ref: ${sourceRef} (${checkedRef}). SQL was read and hashed only; no migrations were executed.`);
