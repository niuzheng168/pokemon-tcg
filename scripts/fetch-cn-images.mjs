// Copy the reviewed CN card images from the local read-only card library into
// public/img/cn-cards/ (gitignored). Each copy must still match its review fingerprint.
// The CN official-mode page falls back to text cards when an image is absent.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_STORES, PRESENTATION, REVIEW_RECORDS } from '../catalog/zh-CN/V20261019/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let copied = 0;
for (const record of REVIEW_RECORDS) {
  const bytes = await readFile(join(IMAGE_STORES[record.image.store], record.image.path));
  if (createHash('sha256').update(bytes).digest('hex') !== record.image.sha256)
    throw new Error(`Image no longer matches its review: ${record.printingId}`);
  const target = join(root, 'public', PRESENTATION[record.printingId].image);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  copied++;
}
console.log(`Copied ${copied} reviewed CN card images into public/img/cn-cards/.`);
