#!/usr/bin/env node
// Assembles the static site: the landing at the root and the built Yaksok terminal at terminal/,
// one folder (site/) that any static host serves as is, under any path (GitHub Pages, for example
// /zec-pq-intents/ and /zec-pq-intents/terminal/). Run `pnpm build:site` (it builds both first).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = join(root, 'site');
const terminal = join(root, 'packages/dashboard/dist');
if (!existsSync(join(terminal, 'index.html'))) throw new Error('build the terminal first: pnpm --filter @pqi/dashboard build');
if (!existsSync(join(here, 'assets/tape.js'))) throw new Error('build the landing first: node packages/landing/build.mjs');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync(join(here, 'index.html'), join(out, 'index.html'));
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });
cpSync(terminal, join(out, 'terminal'), { recursive: true });
console.log(`site built: ${out} (landing at /, terminal at /terminal/)`);
