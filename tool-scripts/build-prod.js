#!/usr/bin/env node
// build-prod.js

/**
 * @file build-prod.js
 * @version 2.0.0 (Config-driven and modular)
 * @description Orchestrates the full production build process.
 * @author @RuthvikUpputuri
 */

const fs = require('fs-extra');
const path = require('path');
const { globSync } = require('glob');
const Terser = require('terser');
const { execSync } = require('child_process');

const projectRootDir = path.resolve(__dirname, '..');
const configFilePath = path.join(projectRootDir, 'href.config.json');

function loadConfig() {
  if (!fs.existsSync(configFilePath)) {
    throw new Error(`Configuration file not found at: ${configFilePath}\nPlease run 'html-refactor --init' to create it.`);
  }
  try {
    const config = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    const configProjectRoot = path.resolve(projectRootDir, config.projectRoot || '.');
    config.distDir = path.resolve(configProjectRoot, config.distDir);
    config.distSourceRoot = path.resolve(configProjectRoot, config.distSourceRoot);
    return config;
  } catch (e) {
    throw new Error(`Failed to load or parse href.config.json: ${e.message}`);
  }
}

function log(message) { console.log(`[build-prod] ${message}`); }
function logError(message, error) {
  console.error(`[build-prod] ❌ ERROR: ${message}`);
  if (error && error.message) console.error(error.message);
  else if (error) console.error(error);
}
function logStep(step) { console.log(`\n[build-prod] STEP: ${step}...\n`); }

const TERSER_OPTIONS_FOR_JS_FILES = {};

async function cleanDistDirectory(config) {
  const distDir = config.distDir;
  logStep(`1. Cleaning output directory (${path.relative(projectRootDir, distDir)})`);
  try {
    await fs.emptyDir(distDir);
    log(`   ✅ ${path.relative(projectRootDir, distDir)} directory cleaned.`);
  } catch (error) {
    logError(`Failed to clean directory: ${path.relative(projectRootDir, distDir)}`, error);
    throw error;
  }
}

async function runHtmlRefactor() {
  logStep('2. Running HTML Refactor script');
  try {
    const command = `node tool-scripts/html-refactor.js --yes`;
    log(`   Executing: ${command}`);
    execSync(command, { stdio: 'inherit', cwd: projectRootDir });
    log('   ✅ HTML Refactor script completed successfully.');
  } catch (error) {
    logError('The html-refactor script failed to execute.', error);
    throw error;
  }
}

async function minifyDistJs(config) {
  const distDir = config.distDir;
  logStep('3. Minifying JavaScript files in dist/');

  const jsFilesToMinify = globSync('**/*.js', { cwd: distDir, absolute: true, nodir: true });

  if (jsFilesToMinify.length === 0) {
    log('   ℹ️ No .js files found in the dist directory to minify.');
    return;
  }
  log(`   Found ${jsFilesToMinify.length} .js file(s) to minify.`);

  const minifyPromises = jsFilesToMinify.map(async (jsFilePath) => {
    const relativeJsPathForLog = path.relative(projectRootDir, jsFilePath);
    try {
      const jsContent = await fs.readFile(jsFilePath, 'utf-8');
      const minifiedResult = await Terser.minify(jsContent, TERSER_OPTIONS_FOR_JS_FILES);

      if (minifiedResult.error) {
        throw minifiedResult.error;
      }

      if (minifiedResult.code) {
        await fs.writeFile(jsFilePath, minifiedResult.code, 'utf-8');
        log(`     ✅ Minified: ${relativeJsPathForLog}`);
      } else {
        logError(`Terser produced no code for ${relativeJsPathForLog}, but no error was thrown.`);
      }
    } catch (error) {
      logError(`Failed to minify JS file: ${relativeJsPathForLog}`, error);
    }
  });

  await Promise.all(minifyPromises);
  log('   ✅ JavaScript minification process complete.');
}

async function compileAndMinifyCss() {
  logStep('4. Compiling and Minifying CSS');
  try {
    const command = `node tool-scripts/build-css.js`;
    log(`   Executing: ${command}`);
    execSync(command, { stdio: 'inherit', cwd: projectRootDir });
    log('   ✅ CSS compilation and minification complete.');
  } catch (error) {
    logError('CSS processing failed.', error);
    throw error;
  }
}

async function optimizeAndCopyImages(config) {
  logStep('5. Optimizing and Copying Images');
  const srcAssetsImagesDir = path.join(config.distSourceRoot, 'assets', 'images');
  const distAssetsImagesDir = path.join(config.distDir, 'assets', 'images');

  try {
    if (!fs.existsSync(srcAssetsImagesDir)) {
        log(`   ⚠️ No image source directory found at ${path.relative(projectRootDir, srcAssetsImagesDir)}, skipping.`);
        return;
    }
    const sourceImageFiles = globSync('**/*.{jpg,jpeg,png,gif,svg,webp,json}', { cwd: srcAssetsImagesDir, absolute: true, nodir: true });

    if (sourceImageFiles.length === 0) {
      log(`   ⚠️ No image files found in ${path.relative(projectRootDir, srcAssetsImagesDir)} to process.`);
      return;
    }
    log(`   Found ${sourceImageFiles.length} image file(s) to process.`);

    const imagemin = (await import('imagemin')).default;
    const imageminSvgo = (await import('imagemin-svgo')).default;
    const plugins = [imageminSvgo()];

    await imagemin([`${srcAssetsImagesDir}/**/*.{jpg,jpeg,png,gif,svg,webp,json}`.replace(/\\/g, '/')], {
      destination: distAssetsImagesDir.replace(/\\/g, '/'),
      plugins,
    });

    log(`   ✅ Successfully processed and copied images to ${path.relative(projectRootDir, distAssetsImagesDir)}.`);
  } catch (error) {
    logError('Image optimization and copying failed. Copying files directly as a fallback.', error);
    try {
      await fs.copy(srcAssetsImagesDir, distAssetsImagesDir, { overwrite: true });
      log(`   ↪️ Fallback: Copied images directly to ${path.relative(projectRootDir, distAssetsImagesDir)}.`);
    } catch (copyError) {
      logError(`Fallback copy also failed for images.`, copyError);
    }
  }
}

async function copyStaticRootFiles(config) {
  logStep('6. Copying Static Root Files');
  const filesToCopy = ['robots.txt', 'sitemap.xml'];

  for (const fileName of filesToCopy) {
    const srcFile = path.join(config.distSourceRoot, fileName);
    const destFile = path.join(config.distDir, fileName);
    try {
      if (await fs.pathExists(srcFile)) {
        await fs.copy(srcFile, destFile, { overwrite: true });
        log(`   ✅ Copied ${fileName} to ${path.relative(projectRootDir, config.distDir)}.`);
      } else {
        log(`   ⚠️ Source ${fileName} not found, skipping.`);
      }
    } catch (error) {
      logError(`Failed to copy ${fileName}.`, error);
      throw error;
    }
  }
}

async function buildProduction() {
  log('🚀🚀🚀 Starting Production Build Process 🚀🚀🚀');
  const overallStartTime = Date.now();

  try {
    const config = loadConfig();

    await cleanDistDirectory(config);
    await runHtmlRefactor();
    await minifyDistJs(config);
    await compileAndMinifyCss();
    await optimizeAndCopyImages(config);
    await copyStaticRootFiles(config);

    const duration = (Date.now() - overallStartTime) / 1000;
    console.log('=====================================================================================================');
    log(`    🏁 🏁 🏁 Production Build Successfully Completed in ${duration.toFixed(2)}s 🏁 🏁 🏁`);
    console.log(`   Output directory: ${path.relative(projectRootDir, config.distDir)}`);
    console.log('=====================================================================================================');
  } catch (error) {
    console.log('===============================================================================================================');
    logError('☠️  ☠️  ☠️   PRODUCTION BUILD FAILED!   ☠️  ☠️  ☠️', error.message ? error.message : error);
    if (error.stack && error.message) console.error(error.stack.substring(error.message.length));
    process.exit(1);
  }
}

if (require.main === module) {
  buildProduction();
}

module.exports = { buildProduction };
