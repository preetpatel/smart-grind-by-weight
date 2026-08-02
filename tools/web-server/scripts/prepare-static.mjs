// Copies the canonical web flasher (tools/web-flasher) into public/ so the
// Next.js app serves it unchanged. The flasher stays canonical in its own
// directory — public/ is a build artifact and is gitignored.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const flasherDir = path.resolve(here, '../../web-flasher');
const publicDir = path.resolve(here, '../public');

if (!existsSync(flasherDir)) {
    console.error(`web-flasher directory not found at ${flasherDir}`);
    process.exit(1);
}

rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
cpSync(flasherDir, publicDir, { recursive: true });
console.log(`Copied web-flasher static assets into ${publicDir}`);
