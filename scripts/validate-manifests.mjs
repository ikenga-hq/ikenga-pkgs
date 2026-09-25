#!/usr/bin/env node
/**
 * validate-manifests.mjs — validate every manifest.json under packages/
 * against @ikenga/contract schemas (ManifestSchema / ArtifactManifestSchema).
 *
 * Exits 1 on any schema validation failure.
 */

import { readFileSync, globSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestSchema, ArtifactManifestSchema } from '@ikenga/contract';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '../..');

const manifestPaths = globSync('packages/**/manifest.json', { cwd: REPO_ROOT })
  .map((p) => p.replace(/\\/g, '/'))
  .sort();

if (manifestPaths.length === 0) {
  console.error('✗ No manifests found under packages/');
  process.exit(1);
}

let failures = 0;
let validated = 0;

for (const relPath of manifestPaths) {
  const fullPath = join(REPO_ROOT, relPath);
  let rawContent;
  try {
    rawContent = readFileSync(fullPath, 'utf8');
  } catch (err) {
    console.error(`✗ ${relPath}: failed to read file: ${err.message}`);
    failures++;
    continue;
  }

  let json;
  try {
    json = JSON.parse(rawContent);
  } catch (err) {
    console.error(`✗ ${relPath}: invalid JSON: ${err.message}`);
    failures++;
    continue;
  }

  // Handle artifact templates (e.g. groundwork artifact template)
  if (json.format === 'ikenga-artifact') {
    let testJson = json;
    if (rawContent.includes('{{')) {
      const substituted = rawContent.replace(/\{\{[^}]+\}\}/g, 'template-placeholder');
      testJson = JSON.parse(substituted);
    }
    if (testJson.dataSources && '_comment' in testJson.dataSources) {
      delete testJson.dataSources._comment;
    }
    const result = ArtifactManifestSchema.safeParse(testJson);
    if (!result.success) {
      console.error(`✗ ${relPath} (artifact manifest):`);
      for (const issue of result.error.issues) {
        console.error(`  - ${issue.path.join('.') || '<root>'}: ${issue.message}`);
      }
      failures++;
      continue;
    }
  } else {
    // Rust serde deserializes null as None for Option<T>. For Zod .optional() fields,
    // normalize null authCommand to undefined.
    if (json.engine?.onboarding?.authCommand === null) {
      delete json.engine.onboarding.authCommand;
    }

    const result = ManifestSchema.safeParse(json);
    if (!result.success) {
      console.error(`✗ ${relPath}:`);
      for (const issue of result.error.issues) {
        console.error(`  - ${issue.path.join('.') || '<root>'}: ${issue.message}`);
      }
      failures++;
      continue;
    }
  }

  validated++;
}

if (failures > 0) {
  console.error(`\n${failures} manifest(s) failed validation out of ${manifestPaths.length}.`);
  process.exit(1);
}

console.log(`\n✓ All ${validated} manifests valid.`);
process.exit(0);
