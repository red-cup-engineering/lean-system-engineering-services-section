import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const producerPath = "scripts/WitLedger.lean";
const ledgerPath = "scripts/wit-ledger.txt";
const ignored = new Set([".git", ".lake", "node_modules"]);
const rootAgentMetadata = new Set([".agents", ".claude", ".codex"]);
const namedInputs = new Set(["lean-toolchain", "lakefile.toml", "lakefile.lean", "lake-manifest.json", ledgerPath]);
const digest = value => "sha256:" + createHash("sha256").update(value).digest("hex");

/** Capture the original audit's local Lean sources and configuration, without
 * changing the ledger. External package bytes are not claimed by this snapshot. */
export async function observeWitLedger(project) {
    const root = await realpath(project);
    const files = [];
    const texts = new Map();
    let bytes = 0;
    async function walk(directory, relative = "") {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory() && ignored.has(entry.name)) continue;
            if (entry.isDirectory() && relative === "" && rootAgentMetadata.has(entry.name)) continue;
            const target = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new TypeError(`lean-check: wit-ledger source symlink: ${name}`);
            if (entry.isDirectory()) { await walk(target, name); continue; }
            if (!entry.isFile() || (!name.endsWith(".lean") && !namedInputs.has(name))) continue;
            const size = (await lstat(target)).size;
            bytes += size;
            if (files.length >= 20000 || bytes > 128 * 1024 * 1024)
                throw new TypeError("lean-check: wit-ledger local source snapshot exceeds its bound");
            const value = await readFile(target);
            files.push({ path: name, digest: digest(value) });
            if (name === producerPath || name === ledgerPath || name === "lean-toolchain") texts.set(name, value.toString("utf8"));
        }
    }
    await walk(root);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const name of [producerPath, ledgerPath, "lean-toolchain"]) {
        if (!texts.has(name)) throw new TypeError(`lean-check: wit-ledger requires ${name}`);
    }
    const producer = files.find(file => file.path === producerPath);
    const ledger = files.find(file => file.path === ledgerPath);
    return Object.freeze({
        producer: Object.freeze(producer), ledger: Object.freeze(ledger),
        toolchain: texts.get("lean-toolchain").trim(),
        localSources: Object.freeze({ digest: digest(JSON.stringify(files)), count: files.length,
            scope: "local Lean sources, Lake configuration, and committed WIT ledger; external package bytes and root agent metadata (.agents, .claude, .codex) excluded" }),
        ledgerText: texts.get(ledgerPath),
    });
}

function count(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new TypeError("lean-check: invalid wit-ledger count");
    return n;
}
function single(lines, prefix) {
    const matching = lines.filter(line => line.startsWith(prefix));
    if (matching.length !== 1) throw new TypeError(`lean-check: missing or repeated wit-ledger ${prefix} row`);
    return matching[0];
}

/** Receive the original WitLedger producer's successful comparison. This does
 * not recount proofs, classify instruments, pay debt, or invent zero entries. */
export function readWitLedgerInspection(stdout, observed) {
    const lines = stdout.split(/\r?\n/u);
    const ok = single(lines, "witledger: OK");
    const match = /^witledger: OK — (\d+) declaration\(s\), (\d+) constant\(s\) in their closure, measured in \d+\.\d+ s; every wit is witnessed in scripts\/wit-ledger\.txt\.$/u.exec(ok);
    if (match === null) throw new TypeError("lean-check: unsupported wit-ledger success record");
    const total = single(lines, "# Totals:");
    const totals = /^# Totals: (\d+) declaration\(s\) carry wits; (\d+) wit\(s\) paid at (\d+) site\(s\) in the library \(.*\)\.$/u.exec(total);
    if (totals === null) throw new TypeError("lean-check: unsupported wit-ledger totals record");
    const ledgerLines = observed.ledgerText.split(/\r?\n/u);
    if (single(ledgerLines, "# Totals:") !== total) throw new TypeError("lean-check: compiler and committed wit-ledger totals disagree");
    const entries = [];
    const seen = new Set();
    for (const line of ledgerLines) {
        if (line === "" || line.startsWith("#")) continue;
        const row = /^(.+) (\d+) (\d+)$/u.exec(line);
        if (row === null || seen.has(row[1])) throw new TypeError("lean-check: malformed or duplicate wit-ledger entry");
        const own = count(row[2]), carried = count(row[3]);
        if (carried === 0 || carried < own) throw new TypeError("lean-check: inconsistent wit-ledger entry");
        seen.add(row[1]);
        entries.push(Object.freeze({ declaration: row[1], own, carried }));
    }
    const declarations = count(match[1]), constants = count(match[2]);
    const carrying = count(totals[1]), paid = count(totals[2]), sites = count(totals[3]);
    const sum = entries.reduce((n, entry) => n + entry.own, 0);
    if (!Number.isSafeInteger(sum) || entries.length !== carrying || sum !== paid || entries.some(entry => entry.carried > paid) ||
        entries.filter(entry => entry.own > 0).length !== sites || declarations < carrying || constants < declarations)
        throw new TypeError("lean-check: inconsistent wit-ledger totals");
    return Object.freeze({ kind: "obsmetrologia.wit-ledger-inspection", producer: observed.producer,
        ledger: observed.ledger, toolchain: observed.toolchain, localSources: observed.localSources,
        declarations, constants, carrying, paid, sites, entries: Object.freeze(entries) });
}
