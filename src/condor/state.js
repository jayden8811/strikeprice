// Bot state (open positions, last entry) and the trade log, kept as local files.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const DIR = new URL('../../data/condor/', import.meta.url);
const STATE = new URL('state.json', DIR);
const LOG = new URL('log.jsonl', DIR);

const EMPTY = { positions: [], closed: [], lastEntryAt: null, week: null };

export async function loadState() {
  try {
    return { ...EMPTY, ...JSON.parse(await readFile(STATE, 'utf8')) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export async function saveState(state) {
  await mkdir(DIR, { recursive: true });
  await writeFile(STATE, JSON.stringify(state, null, 1));
}

// One JSON line per event: entries, exits, orders, skips, errors.
export async function log(event) {
  await mkdir(DIR, { recursive: true });
  await appendFile(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export async function readLog(limit = 200) {
  try {
    const lines = (await readFile(LOG, 'utf8')).trim().split('\n');
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
