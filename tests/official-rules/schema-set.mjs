// Test helper: register every repository schema not yet added, so a schema under test can resolve shared references.
import { readFile, readdir } from 'node:fs/promises';

export async function registerSharedSchemas(ajv, already) {
  const dir = new URL('../../schemas/', import.meta.url);
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.schema.json')).sort()) {
    const schema = JSON.parse(await readFile(new URL(name, dir), 'utf8'));
    if (!already.includes(schema.$id)) ajv.addSchema(schema);
  }
}
