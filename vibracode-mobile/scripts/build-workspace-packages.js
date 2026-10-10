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
// This script compiles every workspace package that has a `src/` directory and
// no `build/` directory. It prefers the package's own build pipeline and falls
// back to Babel for packages whose `tsc --emitDeclarationOnly` step fails on
// type errors (we only need runtime JS, not type declarations).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');

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
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.js')) return true;
    }
  }
  return false;
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
  if (!fs.existsSync(path.join(dir, 'src'))) {
    skipped++;
    continue;
  }
  const buildScript = (pkg.scripts && pkg.scripts.build) || '';
  // Packages with bespoke pipelines (bundlers, custom bash) are left alone.
  if (/taskr|ncc|bash -c/.test(buildScript)) {
    skipped++;
    continue;
  }
  const buildDir = path.join(dir, 'build');
  if (hasCompiledJs(buildDir)) {
    skipped++;
    continue;
  }
  // Remove any empty/partial `build/` directory left by a previous failed run.
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }

  const hasBuildDir = () => hasCompiledJs(buildDir);

  try {
    if (/&&\s*babel\b/.test(buildScript)) {
      // Skip the failing `tsc --emitDeclarationOnly` step and run only Babel.
      const babelPart = buildScript.slice(buildScript.indexOf('babel'));
      run(`yarn -s ${babelPart}`, dir);
    } else if (buildScript) {
      run('yarn -s run build', dir);
    }

    if (!hasBuildDir()) {
      // Fall back to a plain Babel compile for tsc-only packages that failed.
      run('yarn -s babel src --out-dir build --extensions ".ts,.tsx,.js" --source-maps', dir);
    }

    if (hasBuildDir()) {
      built++;
    } else {
      failed++;
      console.warn(`[build-workspace-packages] no build output for ${pkg.name}`);
    }
  } catch (error) {
    failed++;
    console.warn(
      `[build-workspace-packages] failed to build ${pkg.name}: ${
        (error && error.message) || error
      }`
    );
  }
}

console.log(`[build-workspace-packages] built=${built} skipped=${skipped} failed=${failed}`);
