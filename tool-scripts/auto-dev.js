#!/usr/bin/env node
// auto-dev.js

/**
 * @file auto-dev.js
 * @module auto-dev
 * @author @RuthvikUpputuri
 * @license MIT
 * @version 2.0.0 (Config-driven and modular)
 * @description Provides a configuration-driven automated development workflow.
 */

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const chokidar = require('chokidar');

const projectRootDir = path.resolve(__dirname, '..');
const configFilePath = path.join(projectRootDir, 'href.config.json');
const BUILD_DEBOUNCE_MS = 400;

function loadConfig() {
  if (!fs.existsSync(configFilePath)) {
    throw new Error(`Configuration file not found at: ${configFilePath}\nPlease run 'html-refactor --init' to create it.`);
  }
  try {
    const config = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    const configProjectRoot = path.resolve(projectRootDir, config.projectRoot || '.');

    config.resolvedHtmlSourcePatterns = (config.htmlSourcePatterns || []).map(p => path.resolve(configProjectRoot, p));
    config.resolvedStylesOutputDir = path.resolve(configProjectRoot, config.stylesOutputDir);
    config.tailwindConfigPath = path.resolve(configProjectRoot, 'tailwind.config.js');
    config.resolvedIgnorePatterns = (config.ignorePatterns || []).map(p => path.join(config.projectRoot, p, '**'));

    return config;
  } catch (e) {
    throw new Error(`Failed to load or parse href.config.json: ${e.message}`);
  }
}

let buildDebounceTimeout;
const LOG_PREFIX = '@';
const LOG_SUFFIX = 'GMT';

function getTimestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function log(message) {
  console.log(`${LOG_PREFIX} [${getTimestamp()} ${LOG_SUFFIX}] ${message}`);
}

function logError(message, error) {
  console.error(`${LOG_PREFIX} [${getTimestamp()} ${LOG_SUFFIX}] ❌ ERROR: ${message}`);
  if (error && error.message) {
    console.error(`   ${error.message}`);
  } else if (error) {
    console.error(`   ${error}`);
  }
}

function scheduleBuild(reason) {
  clearTimeout(buildDebounceTimeout);
  log(`⏳ Build scheduled (Reason: ${reason}). Waiting ${BUILD_DEBOUNCE_MS}ms for further changes...`);
  buildDebounceTimeout = setTimeout(() => {
    runBuild(reason);
  }, BUILD_DEBOUNCE_MS);
}

function runBuild(finalReason) {
  log(`\n🔄 Kicking off full build (Reason: ${finalReason})...`);
  try {
    execSync('node tool-scripts/html-refactor.js build', { stdio: 'inherit', cwd: projectRootDir });
    log('✅ Build successful.');
  } catch (error) {
    logError('Build command failed. Check output above for details.', error.message || '');
  }
}

function startDevWatcher() {
  try {
    const config = loadConfig();
    log('🚀 Starting Config-Driven Auto-Dev Watcher...');
    log(`   Project root: ${config.projectRoot}`);

    const pathsToWatch = [
      ...config.resolvedHtmlSourcePatterns,
      config.resolvedStylesOutputDir,
      config.tailwindConfigPath,
    ];

    log('   Watching paths:');
    pathsToWatch.forEach(p => log(`     - ${path.relative(projectRootDir, p)}`));

    runBuild('Initial startup');

    const watcher = chokidar.watch(pathsToWatch, {
      ignored: config.resolvedIgnorePatterns,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    watcher
      .on('add', filePath => scheduleBuild(`File added: ${path.relative(projectRootDir, filePath)}`))
      .on('change', filePath => scheduleBuild(`File changed: ${path.relative(projectRootDir, filePath)}`))
      .on('unlink', filePath => scheduleBuild(`File deleted: ${path.relative(projectRootDir, filePath)}`))
      .on('error', error => logError('Watcher error:', error));

    log(`\n👀 File watcher is active. Press Ctrl+C to stop.`);

  } catch (error) {
    logError('Failed to start the auto-dev watcher.', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startDevWatcher();
}

module.exports = { startDevWatcher };
