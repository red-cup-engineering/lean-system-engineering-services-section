/** Runs inside the parent's existing lock, deadline and lean.slice scope.
 * Rebuild the library, then execute the snapshotted producer source directly:
 * a differently configured `witledger` Lake target cannot impersonate it. */
import { spawnSync } from "node:child_process";
const [lake] = process.argv.slice(2);
for (const args of [["build", "Obsmetrologia"], ["env", "lean", "--run", "scripts/WitLedger.lean"]]) {
    const result = spawnSync(lake, args, { stdio: "inherit", env: process.env });
    if (result.error) {
        process.stderr.write(`${result.error.message}\n`);
        process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
}
