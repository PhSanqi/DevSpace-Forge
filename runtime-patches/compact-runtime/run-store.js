import { homedir } from "node:os";
import path from "node:path";
const DEFAULT_ROOT = path.join(homedir(), ".local", "share", "devspace", "runs");
export function runStoreRoot() {
    return process.env.DEVSPACE_COMPACT_RUN_ROOT || DEFAULT_ROOT;
}
