// Test fixture for the native C# GUI preflight. Never uses a production store.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const [stateDir, status] = process.argv.slice(2);
if (!stateDir || !path.isAbsolute(stateDir) || !['running', 'succeeded'].includes(status)) {
  process.exit(2);
}
const jobsDir = path.join(stateDir, 'jobs');
mkdirSync(jobsDir, { recursive: true });
const db = new DatabaseSync(path.join(jobsDir, 'jobs.sqlite'));
try {
  db.exec('CREATE TABLE IF NOT EXISTS durable_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
  db.prepare('INSERT OR REPLACE INTO durable_jobs (id,status) VALUES (?,?)').run('job_native_fixture', status);
} finally { db.close(); }
