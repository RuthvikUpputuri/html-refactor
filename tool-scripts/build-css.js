#!/usr/bin/env node
// build-css.js

/**
 * @file build-css.js
 * @module build-css
 * @author @RuthvikUpputuri
 * @license MIT
 * @version 2.0.0 (Config-driven and modular)
 * @description Automates building Tailwind CSS.
 */

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const { globSync } = require('glob');

const projectRootDir = path.resolve(__dirname, '..');
const configFilePath = path.join(projectRootDir, 'href.config.json');

function loadConfig() {
  if (!fs.existsSync(configFilePath)) {
    throw new Error(`Configuration file not found at: ${configFilePath}\nPlease run 'html-refactor --init' to create it.`);
  }
  try {
    const config = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    const configProjectRoot = path.resolve(projectRootDir, config.projectRoot || '.');
    config.stylesOutputDir = path.resolve(configProjectRoot, config.stylesOutputDir);
    config.compiledCssLinkDir = path.resolve(configProjectRoot, config.compiledCssLinkDir);
    config.distSourceRoot = path.resolve(configProjectRoot, config.distSourceRoot);
    return config;
  } catch (e) {
    throw new Error(`Failed to load or parse href.config.json: ${e.message}`);
  }
}

function buildCss() {
  console.log('🚀 [build-css] Starting Tailwind CSS build process...');
  try {
    const config = loadConfig();
    const outputDir = config.compiledCssLinkDir;

    let sourceCssFiles = [];
    if (config.cssOutputDirStrategy === 'relativeToHtml') {
        // Scan the entire source root for CSS files
        const sourceRoot = config.distSourceRoot;
        console.log(`   [build-css] Scanning for CSS files in source directory: ${path.relative(projectRootDir, sourceRoot)}`);
        sourceCssFiles = globSync('**/*.css', { cwd: sourceRoot, absolute: true, nodir: true });
    } else {
        // Centralized: scan only the specified styles directory
        const stylesDir = config.stylesOutputDir;
        console.log(`   [build-css] Scanning for CSS files in centralized directory: ${path.relative(projectRootDir, stylesDir)}`);
        if (fs.existsSync(stylesDir)) {
            sourceCssFiles = globSync('**/*.css', { cwd: stylesDir, absolute: true, nodir: true });
        } else {
            console.warn(`   [build-css] ⚠️ Source CSS directory not found: ${stylesDir}. Nothing to build.`);
        }
    }

    if (sourceCssFiles.length === 0) {
      console.warn('   [build-css] ⚠️ No .css files found to process.');
      return;
    }

    console.log(`   [build-css] Found ${sourceCssFiles.length} CSS file(s) to process.`);
    fs.ensureDirSync(outputDir);
    console.log(`   [build-css] Ensured output directory exists: ${outputDir}`);

    sourceCssFiles.forEach(inputFile => {
      const baseName = path.basename(inputFile, '.css').replace(/[^a-zA-Z0-9_.-]/g, '_');
      const outputFile = path.join(outputDir, `${baseName}-output.css`);
      const minifyFlag = process.env.NODE_ENV === 'production' ? '--minify' : '';
      const postCssConfigPath = path.join(projectRootDir, 'postcss.config.js');
      const command = `npx tailwindcss --postcss "${postCssConfigPath}" -i "${inputFile}" -o "${outputFile}" ${minifyFlag}`;

      console.log(`   [build-css] Building: ${path.relative(projectRootDir, inputFile)}...`);
      console.log(`     > ${command}`);

      try {
        execSync(command, { stdio: 'inherit', cwd: projectRootDir });
        console.log(`   [build-css] ✅ Successfully built: ${path.relative(projectRootDir, outputFile)}\n`);
      } catch (error) {
        console.error(`   [build-css] ❌ ERROR building ${path.basename(inputFile)}: ${error.message}`);
      }
    });

    console.log('✅ [build-css] CSS build process finished.');

  } catch (error) {
    console.error(`❌ [build-css] A critical error occurred during the build process:`);
    if (error.message) console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  buildCss();
}

module.exports = { buildCss };
