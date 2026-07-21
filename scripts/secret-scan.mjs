#!/usr/bin/env node
/**
 * LA FORJA — dependency-free secret scanner.
 *
 * Doc §9 / hard constraint 5: only `.env.example` is versioned, nothing that
 * looks like a real credential may ever enter the repository or the client
 * bundle. This script is wired two ways:
 *   - `.githooks/pre-commit`  -> default mode, scans STAGED files only.
 *   - `.github/workflows/ci.yml` -> `--all`, scans the whole tracked tree.
 *
 * Usage:
 *   node scripts/secret-scan.mjs           # staged files (pre-commit)
 *   node scripts/secret-scan.mjs --all     # whole tracked tree (CI)
 *   CI=true node scripts/secret-scan.mjs   # `--all` is implied when CI is set
 *
 * Exit codes: 0 = clean, 1 = at least one finding, 2 = scanner error.
 *
 * ---------------------------------------------------------------------------
 * SELF-TEST — how to verify this scanner actually fires
 * ---------------------------------------------------------------------------
 * Every sample below is assembled by string concatenation so that writing it
 * here does NOT trip the scanner against its own source. To verify:
 *
 *   1. Clean tree passes:
 *        node scripts/secret-scan.mjs --all     # expect "OK" and exit 0
 *
 *   2. OpenAI-style key is caught:
 *        node -e 'const p="sk-";require("fs").writeFileSync("/tmp/forja-leak.txt",
 *          "OPENAI_API_KEY="+p+"a".repeat(40))'
 *        node scripts/secret-scan.mjs /tmp/forja-leak.txt   # expect exit 1
 *
 *   3. AWS access key id is caught:
 *        node -e 'const p="AKIA";require("fs").writeFileSync("/tmp/forja-aws.txt",
 *          p+"ABCDEFGHIJKLMNOP")'
 *        node scripts/secret-scan.mjs /tmp/forja-aws.txt    # expect exit 1
 *
 *   4. Placeholders are NOT caught (no false positive on the committed example):
 *        node scripts/secret-scan.mjs .env.example          # expect exit 0
 *
 *   5. A staged `.env` is caught TWICE: once by filename, and once for each
 *      credential inside it. `.env` is git-ignored, so this only fires on a
 *      force-add — which is precisely when a live key would slip through:
 *        node -e 'const p="sk-";require("fs").mkdirSync("/tmp/forja-env",{recursive:true});
 *          require("fs").writeFileSync("/tmp/forja-env/.env","OPENAI_API_KEY="+p+"a".repeat(40))'
 *        node scripts/secret-scan.mjs /tmp/forja-env/.env   # expect exit 1, 2 findings
 *
 *      `.env.example` is the ONLY exempt basename, and it is exempt from the
 *      FILENAME rule only — its contents are read and scanned like any other
 *      file, with self-evident placeholders filtered out.
 *
 * Remember to delete the temp files afterwards.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// fileURLToPath (not URL.pathname) so paths containing spaces resolve correctly.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories never worth scanning. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'out',
  'coverage',
  '.vitest',
  '.turbo',
  '.vercel',
]);

/** Lockfiles: huge, machine-generated, and full of hash-like noise. */
const SKIP_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
]);

/** Binary-ish extensions we do not read. */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.wav', '.webm', '.avi',
  '.db', '.sqlite', '.sqlite3', '.wasm', '.node', '.dylib', '.so', '.dll',
]);

/**
 * The ONLY environment file exempt from the "env files must not be committed"
 * filename rule — and only because it holds placeholders on purpose.
 * `.env.example` is the only environment file that is versioned (constraint 5).
 *
 * Deliberately NOT a broader set. `.env.sample` / `.env.template` are not part
 * of this repo's contract, so a file with either name is treated like any other
 * stray env file: flagged, and its contents scanned.
 *
 * NOTE the scope: being on this list exempts a file from the FILENAME rule only.
 * Its contents are still scanned — see `scanFile`. An allowlist that skipped
 * reading would be a hole big enough to drive a live key through.
 */
const ALLOWLISTED_BASENAMES = new Set(['.env.example']);

/**
 * True when the file is an environment file whose mere presence in a commit is
 * a finding: `.env`, `.env.local`, `.env.production.local`, and friends.
 *
 * These are all git-ignored, so in normal use this never fires — it exists to
 * catch the one that gets `git add -f`-ed, which is exactly the case where a
 * real credential reaches the index.
 */
function isForbiddenEnvFile(basename) {
  if (ALLOWLISTED_BASENAMES.has(basename)) return false;
  return basename === '.env' || basename.startsWith('.env.');
}

/** Skip anything larger than this (bytes); real secrets are small. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Detection rules
//
// Every pattern is built from concatenated fragments so this file passes its
// own scan: the literal shapes below never appear contiguously in the source.
// ---------------------------------------------------------------------------

const KEY_CHARS = '[A-Za-z0-9_-]';

/** Names that make a long quoted literal suspicious. */
const SENSITIVE_NAMES = [
  'API' + '_KEY',
  'API' + 'KEY',
  'ACCESS' + '_KEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
];

/** Values that are obviously not real credentials. */
const PLACEHOLDER = new RegExp(
  [
    'REPLACE',
    'PLACEHOLDER',
    'EXAMPLE',
    'CHANGE_?ME',
    'YOUR[_-]?',
    'DUMMY',
    'SAMPLE',
    'REDACT',
    'FAKE',
    'TODO',
    'XXXX',
    '\\.\\.\\.',
    '<[^>]*>',
    '\\$\\{',
    'process\\.env',
    'import\\.meta\\.env',
  ].join('|'),
  'i',
);

const RULES = [
  {
    id: 'openai-key',
    label: 'OpenAI-style API key',
    // sk- (optionally sk-proj-) followed by 20+ key characters.
    pattern: new RegExp('\\b' + 's' + 'k-(?:proj-)?' + KEY_CHARS + '{20,}', 'g'),
  },
  {
    id: 'aws-access-key-id',
    label: 'AWS access key id',
    pattern: new RegExp('\\b' + 'AKI' + 'A' + '[A-Z0-9]{16}\\b', 'g'),
  },
  {
    id: 'generic-assignment',
    label: 'Credential-shaped assignment',
    // FOO_API_KEY = "…16+ chars…" / secret: '…' / token=`…`
    pattern: new RegExp(
      '\\b[A-Za-z0-9_]*(?:' + SENSITIVE_NAMES.join('|') + ')[A-Za-z0-9_]*' +
        '\\s*[:=]\\s*([\'"`])([^\'"`\\n]{16,})\\1',
      'gi',
    ),
    /** Group 2 holds the literal value; skip obvious placeholders. */
    valueGroup: 2,
  },
  {
    id: 'private-key-pem',
    label: 'Private key PEM header',
    pattern: new RegExp('-' + '----' + 'BEGIN [A-Z0-9 ]*PRIVATE KEY' + '----' + '-', 'g'),
  },
];

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

/** Run git and return trimmed stdout, or null when git is unavailable. */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function isGitRepo() {
  return git(['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** Recursively walk the working tree when git is not available. */
function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(REPO_ROOT, full));
    }
  }
  return acc;
}

/**
 * Resolve the list of repo-relative paths to scan.
 * Returns { files, mode } where mode describes the selection for the report.
 */
function selectFiles(explicitPaths, scanAll) {
  if (explicitPaths.length > 0) {
    return { files: explicitPaths, mode: 'explicit paths' };
  }
  if (isGitRepo()) {
    if (scanAll) {
      const tracked = git(['ls-files', '-z']);
      if (tracked !== null) {
        return { files: tracked.split('\0').filter(Boolean), mode: 'tracked tree' };
      }
    } else {
      const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']);
      if (staged !== null) {
        return { files: staged.split('\0').filter(Boolean), mode: 'staged files' };
      }
    }
  }
  // No git (or git failed): fall back to a working-tree walk so the scan still runs.
  return { files: walk(REPO_ROOT, []), mode: 'working tree (git unavailable)' };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function shouldSkip(relPath) {
  const base = path.basename(relPath);
  if (SKIP_FILES.has(base)) return true;
  if (SKIP_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return true;
  for (const segment of relPath.split(path.sep)) {
    if (SKIP_DIRS.has(segment)) return true;
  }
  return false;
}

/** Truncate a match so the report never prints a full credential. */
function mask(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 12) return flat;
  return `${flat.slice(0, 8)}…[${flat.length - 10} chars masked]…${flat.slice(-2)}`;
}

/** Map a character offset to a 1-based line/column pair. */
function locate(content, index) {
  const before = content.slice(0, index);
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  return { line, column: index - lastBreak };
}

function scanFile(relPath) {
  const findings = [];
  // Git hands us repo-relative paths; an explicit CLI argument may be absolute
  // or relative to the caller's cwd. Resolve all three shapes.
  const absolute = path.isAbsolute(relPath)
    ? relPath
    : existsSync(path.join(REPO_ROOT, relPath))
      ? path.join(REPO_ROOT, relPath)
      : path.resolve(process.cwd(), relPath);
  const basename = path.basename(relPath);
  // Placeholder file: exempt from the filename rule and from content matches
  // that are self-evidently placeholders — but still READ and still scanned, so
  // a real key pasted into `.env.example` is caught like anywhere else.
  const isPlaceholderFile = ALLOWLISTED_BASENAMES.has(basename);

  if (!isPlaceholderFile && isForbiddenEnvFile(basename)) {
    findings.push({
      file: relPath,
      line: 0,
      column: 0,
      rule: 'env-file-committed',
      label: 'Environment file must never be committed',
      excerpt: basename,
    });
    // Keep going: report the contents too, they are the actual leak.
  }

  if (!existsSync(absolute)) return findings;

  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return findings;
  }
  if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return findings;

  let buffer;
  try {
    buffer = readFileSync(absolute);
  } catch {
    return findings;
  }
  // Binary guard: a NUL byte in the first 8 KiB means "not text".
  if (buffer.subarray(0, 8192).includes(0)) return findings;

  const content = buffer.toString('utf8');

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(content)) !== null) {
      if (match[0].length === 0) {
        rule.pattern.lastIndex += 1;
        continue;
      }
      const value = rule.valueGroup ? match[rule.valueGroup] ?? match[0] : match[0];
      if (rule.valueGroup && PLACEHOLDER.test(value)) continue;
      // In `.env.example` every value is supposed to be a placeholder, so an
      // obvious one is not a finding for ANY rule. A value that does not look
      // like a placeholder still is — that is the whole point of reading it.
      if (isPlaceholderFile && PLACEHOLDER.test(value)) continue;
      const { line, column } = locate(content, match.index);
      findings.push({
        file: relPath,
        line,
        column,
        rule: rule.id,
        label: rule.label,
        excerpt: mask(match[0]),
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const scanAll = argv.includes('--all') || process.env.CI === 'true' || process.env.CI === '1';
  const explicitPaths = argv.filter((arg) => !arg.startsWith('--'));

  const { files, mode } = selectFiles(explicitPaths, scanAll);
  const scannable = files.filter((file) => !shouldSkip(file));

  const findings = [];
  for (const file of scannable) {
    findings.push(...scanFile(file));
  }

  if (findings.length === 0) {
    process.stdout.write(
      `secret-scan OK — no credential patterns in ${scannable.length} file(s) [${mode}]\n`,
    );
    process.exit(0);
  }

  const byFile = new Map();
  for (const finding of findings) {
    const bucket = byFile.get(finding.file);
    if (bucket) bucket.push(finding);
    else byFile.set(finding.file, [finding]);
  }

  process.stderr.write(
    `\nsecret-scan FAILED — ${findings.length} potential secret(s) in ` +
      `${byFile.size} file(s) [${mode}]\n\n`,
  );
  for (const [file, fileFindings] of byFile) {
    process.stderr.write(`  ${file}\n`);
    for (const finding of fileFindings) {
      const where = finding.line > 0 ? `line ${finding.line}, col ${finding.column}` : 'filename';
      process.stderr.write(`    ${where} — ${finding.label} [${finding.rule}]\n`);
      process.stderr.write(`      ${finding.excerpt}\n`);
    }
    process.stderr.write('\n');
  }
  process.stderr.write(
    'Remove the secret, rotate it, and keep credentials in .env.local ' +
      '(git-ignored). Only .env.example is versioned.\n\n',
  );
  process.exit(1);
}

try {
  main();
} catch (error) {
  process.stderr.write(`secret-scan ERROR: ${error instanceof Error ? error.message : error}\n`);
  process.exit(2);
}
