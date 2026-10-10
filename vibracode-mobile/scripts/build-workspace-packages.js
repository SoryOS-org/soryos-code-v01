#!/usr/bin/env node
// Builds workspace packages' JS into their `build/` folders.
//
// The Expo monorepo normally relies on `expo-module build` / `tsc` to emit the
// compiled output of each package. On EAS the only package built by the root
// `postinstall` is `@expo/cli` (via `taskr`), so packages such as `@expo/config`,
// `@expo/config-plugins` and `@expo/env` have no `build/` directory. As a result
// the project's `expo config` command fails with "Cannot find module
// .../build/index.js" and the EAS build aborts before it starts.
//
// Packages can also ship auxiliary entry points in `cli/`, `plugin/`, `utils/`
// and `scripts/` subdirectories (e.g. `expo-updates` -> `cli/build/cli.js`).
//
// This script compiles every workspace package that has source directories and
// missing build output. It prefers the package's own build pipeline and falls
// back to Babel for packages whose `tsc` step fails on type errors (we only need
// runtime JS, not type declarations).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const AUX_DIRS = ['cli', 'plugin', 'utils', 'scripts'];
const BABEL_IGNORE = '"**/__tests__/**","**/__mocks__/**","**/__typetests__/**"';

function collectPackageDirs() {
  const dirs = [];
  const bases = ['apps', 'packages', path.join('packages', '@expo')];
  for (const base of bases) {
    const abs = path.join(root, base);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs)) {
      const dir = path.join(abs, entry);
      if (fs.existsSync(path.join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs;
}

function run(command, cwd) {
  execSync(command, { cwd, stdio: 'ignore', env: process.env, shell: '/bin/bash' });
}

// A `build/` directory is only useful if it actually contains compiled JS.
// Failed/partial builds can leave an empty directory behind.
function hasCompiledJs(buildDir) {
  if (!fs.existsSync(buildDir)) return false;
  const stack = [buildDir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else if (entry.name.endsWith('.js')) return true;
    }
  }
  return false;
}

// Returns the source -> output pairs that this package is expected to provide.
function getBuildTargets(dir) {
  const targets = [];
  if (fs.existsSync(path.join(dir, 'src'))) {
    targets.push({ src: 'src', out: 'build' });
  }
  for (const aux of AUX_DIRS) {
    if (fs.existsSync(path.join(dir, aux, 'src'))) {
      targets.push({ src: path.join(aux, 'src'), out: path.join(aux, 'build') });
    }
  }
  return targets;
}

let built = 0;
let skipped = 0;
let failed = 0;

for (const dir of collectPackageDirs()) {
  let pkg;
  try {
    pkg = require(path.join(dir, 'package.json'));
  } catch {
    continue;
  }

  // `@expo/cli` is built by `taskr` and uses a different module layout.
  if (pkg.name === '@expo/cli') {
    skipped++;
    continue;
  }

  const targets = getBuildTargets(dir);
  if (targets.length === 0) {
    skipped++;
    continue;
  }

  const missing = targets.filter((t) => !hasCompiledJs(path.join(dir, t.out)));
  if (missing.length === 0) {
    skipped++;
    continue;
  }

  // Clean up any empty/partial output directories left behind.
  for (const target of missing) {
    const outDir = path.join(dir, target.out);
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  }

  const buildScript = (pkg.scripts && pkg.scripts.build) || '';
  const bespoke = /taskr|ncc|bash -c/.test(buildScript);

  // 1) Try the package's own build pipeline (handles tsc project references,
  //    asset copying, etc.).
  if (buildScript && !bespoke) {
    try {
      run('yarn -s run build', dir);
    } catch {
      // Fall back to Babel below.
    }
  }

  // 2) Compile any target that still has no output with Babel.
  for (const target of missing) {
    if (hasCompiledJs(path.join(dir, target.out))) continue;
    try {
      run(
        `yarn -s babel ${target.src} --out-dir ${target.out} --extensions ".ts,.tsx,.js" --source-maps --ignore ${BABEL_IGNORE}`,
        dir
      );
    } catch {
      // Reported below based on final output presence.
    }
  }

  const stillMissing = missing.filter((t) => !hasCompiledJs(path.join(dir, t.out)));
  if (stillMissing.length === 0) {
    built++;
  } else {
    failed++;
    console.warn(
      `[build-workspace-packages] missing output for ${pkg.name}: ${stillMissing
        .map((t) => t.out)
        .join(', ')}`
    );
  }
}

console.log(`[build-workspace-packages] built=${built} skipped=${skipped} failed=${failed}`);
