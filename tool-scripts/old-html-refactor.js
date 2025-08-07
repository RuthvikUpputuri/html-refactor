/**
 * @file old-html-refactor.js
 * @version 0.0.1 (Heavily refactored for src/dist, callable logic, and build pipeline)
 * @author @RuthvikUpputuri (Original)
 * @license MIT
 * @requires fs-extra
 * @requires glob
 * @requires cheerio
 * @requires crypto
 * @description
 * This script automates the refactoring of HTML files from 'src/html/' to 'dist/'.
 * Key Actions:
 * 1. Reads HTML files from 'src/html/'.
 * 2. Extracts inline CSS:
 *    - Saves to 'src/assets/styles/' (with Tailwind directives prepended).
 * 3. Extracts inline JavaScript:
 *    - Prepares JS content and intended paths in 'dist/'.
 * 4. Modifies HTML structure (in memory via Cheerio):
 *    - Removes inline styles/scripts.
 *    - Adds <link> to final compiled CSS path (expected in 'dist/assets/css/').
 *    - Adds <script src="..."> for extracted JS (expected in 'dist/' alongside HTML).
 * 5. When run directly (main()): Saves processed HTML and extracted JS to 'dist/'.
 * 6. Exports `performHtmlRefactoringLogic` for programmatic use (e.g., by build-prod.js),
 *    which returns processed data without writing HTML/JS to disk itself.
 */

const fs = require('fs-extra');
const path = require('path');
const { globSync } = require('glob');
const cheerio = require('cheerio');
const crypto = require('crypto');

// --- Configuration ---
/**
 * @const {object} CONFIG - Configuration object for the HTML refactoring script.
 * @property {string} SRC_HTML_FILES_PATTERN - Glob pattern used to find HTML files within the scan roots.
 *    Example: `'** /*.html'` will find all HTML files recursively.
 * @property {string[]} HTML_SCAN_ROOTS - An array of paths, relative to `PROJECT_ROOT`, where the script will look for source HTML files.
 *    Typically, this will be `['src/html/']`. `globSync` will use the first entry as its `cwd` in batch mode.
 * @property {string} CSS_SRC_DIR_PATH_FROM_ROOT - Path, relative to `PROJECT_ROOT`, where extracted CSS (intermediate source for Tailwind) will be saved.
 *    Example: `'src/assets/styles/'`
 * @property {string} HTML_OUTPUT_DIR_FROM_ROOT - Path, relative to `PROJECT_ROOT`, for the root directory where final processed HTML and extracted JS files will be written.
 *    Example: `'dist/'`
 * @property {string} CSS_COMPILED_OUTPUT_DIR_FROM_ROOT - Path, relative to `PROJECT_ROOT`, where final compiled CSS (after Tailwind processing by `build-css.js`) is expected to reside.
 *    This is used by `addCssLinkToHtmlHead` to generate correct relative `<link>` hrefs in the processed HTML.
 *    Example: `'dist/assets/css/'`
 * @property {number} MAX_BASE_FILENAME_LENGTH - Maximum length for generated CSS and JS base filenames (before extension and any hash).
 *    Filenames exceeding this length will be truncated and appended with a short hash of the original full name.
 * @property {string} LOG_LEVEL - Desired logging level. Accepted values: 'DEBUG', 'INFO', 'WARN', 'ERROR'.
 *    Controls the verbosity of console output.
 * @property {string[]} IGNORE_PATTERNS - An array of glob patterns used to ignore specific files or directories during the HTML scan in batch mode.
 *    These patterns are applied by `globSync` and are relative to its `cwd` option (which is `SRC_HTML_FULL_PATH` in `main()`).
 *    For single-file processing mode (via command-line argument), these patterns are checked against the file path relative to `PROJECT_ROOT`.
 *    Examples:
 *      - `'node_modules/**'` (if it could exist within scan roots)
 *      - `'** /test-fixtures/ **'` (to ignore a subfolder named 'test-fixtures' anywhere within scan roots)
 *      - `'*.ignore.html'` (to ignore HTML files ending with '.ignore.html')
 *      - `'dist/**'` (important project-level ignore, though less effective if glob `cwd` is deep like `src/html`)
 * @property {string[]} ROOT_FILES_TO_PROCESS - An array of filenames (case-insensitive) that should be processed if found directly under `HTML_SCAN_ROOTS[0]`.
 *    Used in batch mode to selectively process files at the top level of the primary scan directory.
 *    Example: `['index.html', 'home.html', '404.html']`
 * @property {boolean} PROCESS_ALL_SUBDIR_HTML - If true, all HTML files found in subdirectories of `HTML_SCAN_ROOTS[0]` (that are not ignored) will be processed in batch mode.
 * @property {string[]} HTML_SOURCE_ROOT_PREFIX_TO_OMIT_FROM_CSS_NAME - An array of string prefixes to remove from the source HTML file's path (relative to `PROJECT_ROOT`)
 *    when generating the base name for its corresponding CSS file. This helps create cleaner, shorter CSS filenames.
 *    The script tries prefixes in order and uses the first one that matches.
 *    Example: If `sourceHtmlFilePath` is `PROJECT_ROOT/src/html/pages/about.html`, and this array contains `['src/html/', 'src/']`,
 *             `'src/html/'` will be stripped, leaving `'pages/about.html'` for CSS name generation (resulting in `pages_about.css`).
 * @property {RegExp} FILENAME_SANITIZATION_REGEX - Regular expression to find characters that are generally unsafe or problematic in filenames.
 *    Matches characters that are NOT alphanumeric, underscore, dot, or hyphen.
 * @property {string} FILENAME_SANITIZATION_REPLACEMENT - Character used to replace any "unsafe" characters matched by `FILENAME_SANITIZATION_REGEX`.
 */
const CONFIG = {
  SRC_HTML_FILES_PATTERN: '**/*.html',
  HTML_SCAN_ROOTS: ['src/html/'],
  CSS_SRC_DIR_PATH_FROM_ROOT: 'src/assets/styles/',
  HTML_OUTPUT_DIR_FROM_ROOT: 'dist/',
  CSS_COMPILED_OUTPUT_DIR_FROM_ROOT: 'dist/assets/css/',
  MAX_BASE_FILENAME_LENGTH: 100, 
  LOG_LEVEL: 'INFO', 
  IGNORE_PATTERNS: [
    'node_modules/**',
    '**/node_modules/**',
    '**/test-fixtures/**', 
    '*.test.html',        
    '**/.*',              
    '**/.*/**',           
    'dist/**',
    'tool-scripts/**',
  ],
  ROOT_FILES_TO_PROCESS: ['home.html', 'index.html', '404.html'],
  PROCESS_ALL_SUBDIR_HTML: true,
  HTML_SOURCE_ROOT_PREFIX_TO_OMIT_FROM_CSS_NAME: ['src/html/', 'src/'], 
  FILENAME_SANITIZATION_REGEX: /[^a-zA-Z0-9_.-]/g,
  FILENAME_SANITIZATION_REPLACEMENT: '_',
};

// --- Logger ---
// Simple console logger with levels and a script-specific prefix.
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLogLevel = LOG_LEVELS[CONFIG.LOG_LEVEL.toUpperCase()] || LOG_LEVELS.INFO; // Default to INFO if invalid LOG_LEVEL
/** @type {object} logger - A simple logger object with debug, info, warn, and error methods. */
const logger = {
  debug: (...args) => currentLogLevel <= LOG_LEVELS.DEBUG && console.debug('[DEBUG][html-refactor]', ...args),
  info: (...args) => currentLogLevel <= LOG_LEVELS.INFO && console.info('[INFO][html-refactor]', ...args),
  warn: (...args) => currentLogLevel <= LOG_LEVELS.WARN && console.warn('[WARN][html-refactor]', ...args),
  error: (...args) => currentLogLevel <= LOG_LEVELS.ERROR && console.error('[ERROR][html-refactor]', ...args),
};

// --- Project Root Detection ---
/**
 * Attempts to find the project root directory.
 * It starts from `startPath` (typically the script's directory) and traverses upwards,
 * looking for a `package.json` file. If found, that directory is considered the project root.
 * As a fallback, if `package.json` is not found and `startPath` is a common tools/scripts directory,
 * its parent is assumed to be the root. Otherwise, `startPath` itself is returned.
 * @param {string} startPath - The initial path to start searching from (usually `__dirname`).
 * @returns {string} The determined absolute path to the project root.
 * @example
 * // Assuming this script is in /path/to/project/tool-scripts/ and package.json is in /path/to/project/
 * const projectRoot = findProjectRoot(__dirname); // projectRoot will be /path/to/project
 */
function findProjectRoot(startPath) {
  let currentPath = path.resolve(startPath); // Ensure startPath is absolute
  // Traverse up until the file system root
  while (currentPath !== path.parse(currentPath).root) {
    if (fs.existsSync(path.join(currentPath, 'package.json'))) {
      return currentPath; // Found package.json, this is the project root.
    }
    currentPath = path.dirname(currentPath); // Move one directory up.
  }
  // Fallback if package.json is not found (e.g., script run in a project without one, or very shallowly nested)
  const scriptDir = path.resolve(startPath);
  if (path.basename(scriptDir).match(/^(scripts|tool-scripts|utils)$/i)) {
    // If script is in a common tools directory, assume its parent is the project root.
    logger.warn(`package.json not found by traversing up from ${startPath}. Assuming parent of script directory is project root.`);
    return path.dirname(scriptDir); 
  }
  // Default to the script's own directory if no other indicators are found.
  logger.warn(`package.json not found by traversing up from ${startPath}. Using script directory as project root.`);
  return scriptDir;
}

/** @const {string} SCRIPT_DIR - Absolute path to the directory where this script resides. */
const SCRIPT_DIR = __dirname; 
/** @const {string} PROJECT_ROOT - Determined absolute path to the project's root directory. */
const PROJECT_ROOT = findProjectRoot(SCRIPT_DIR); 

logger.info(`Script running from (SCRIPT_DIR): ${SCRIPT_DIR}`);
logger.info(`Detected Project Root (PROJECT_ROOT): ${PROJECT_ROOT}`);

// --- Global Path Constants (Derived from CONFIG and PROJECT_ROOT) ---

/** 
 * @const {string} CSS_SRC_FULL_PATH - Absolute path to the directory where extracted CSS source files 
 * (intermediate files containing Tailwind directives and extracted styles) will be saved.
 * Typically `PROJECT_ROOT/src/assets/styles/`.
 */
const CSS_SRC_FULL_PATH = path.join(PROJECT_ROOT, CONFIG.CSS_SRC_DIR_PATH_FROM_ROOT);
logger.info(`Extracted CSS source files will be written to (CSS_SRC_FULL_PATH): ${CSS_SRC_FULL_PATH}`);

/** 
 * @const {string} HTML_OUTPUT_FULL_PATH - Absolute path to the root directory where final processed HTML 
 * and extracted JavaScript files will be written.
 * Typically `PROJECT_ROOT/dist/`.
 */
const HTML_OUTPUT_FULL_PATH = path.join(PROJECT_ROOT, CONFIG.HTML_OUTPUT_DIR_FROM_ROOT);
logger.info(`Processed HTML & JS files will be written to (HTML_OUTPUT_FULL_PATH): ${HTML_OUTPUT_FULL_PATH}`);

/** 
 * @const {string} SRC_HTML_FULL_PATH - Absolute path to the primary directory that will be scanned for source HTML files.
 * Derived from the first entry in `CONFIG.HTML_SCAN_ROOTS`.
 * Typically `PROJECT_ROOT/src/html/`.
 */
const SRC_HTML_FULL_PATH = path.join(PROJECT_ROOT, CONFIG.HTML_SCAN_ROOTS[0]); 
logger.info(`Scanning for source HTML files in (SRC_HTML_FULL_PATH): ${SRC_HTML_FULL_PATH}`);


// --- Utility Functions ---

/** Counter for generating unique CSS class names for extracted inline styles. */
let uniqueClassCounter = 0;
/**
 * Generates a unique CSS class name.
 * Used for converting inline `style` attributes to CSS classes.
 * @returns {string} A unique class name, e.g., "extracted-inline-style-1".
 */
function generateUniqueCssClassName() { 
  uniqueClassCounter++; 
  return `extracted-inline-style-${uniqueClassCounter}`; 
}

/**
 * Sanitizes a string to be safe for use as part of a filename.
 * Replaces characters matched by `CONFIG.FILENAME_SANITIZATION_REGEX` with `CONFIG.FILENAME_SANITIZATION_REPLACEMENT`.
 * Also replaces multiple consecutive underscores with a single underscore.
 * @param {string} str - The input string to sanitize.
 * @returns {string} The sanitized string. Returns an empty string if input is falsy.
 * @example
 * sanitizeStringForFilename("path/to/My File!.html"); // Might return "path_to_My_File_.html" (depending on regex)
 * sanitizeStringForFilename("a___b--c"); // Returns "a_b--c"
 */
function sanitizeStringForFilename(str) {
  if (!str) return '';
  // Replace unsafe characters (as defined by regex) with an underscore.
  const sanitized = str.replace(CONFIG.FILENAME_SANITIZATION_REGEX, CONFIG.FILENAME_SANITIZATION_REPLACEMENT);
  // Replace multiple consecutive underscores (which might result from previous step) with a single one.
  return sanitized.replace(/_+/g, '_');
}

/**
 * Creates a safe base name for a file, ensuring it doesn't exceed `CONFIG.MAX_BASE_FILENAME_LENGTH`.
 * If the provided `originalName` (after initial sanitization) is too long, it's truncated,
 * and a short hash of the original (pre-truncation) `originalName` is appended to maintain uniqueness
 * while keeping the filename relatively readable.
 * @param {string} originalName - The desired original base name (should already be somewhat sanitized, e.g., by `sanitizeStringForFilename`).
 * @param {string} context - A context string (e.g., "CSS" or "JS") used for logging warnings if truncation occurs.
 * @returns {string} A safe filename base, potentially truncated and hashed.
 * @example
 * // Assuming MAX_BASE_FILENAME_LENGTH is 20
 * generateSafeBaseName("this_is_a_very_long_original_name", "CSS"); 
 * // Might return "this_is_a_very_lon_abcdef12" (truncated + hash)
 */
function generateSafeBaseName(originalName, context) {
  // Sanitize again, in case the input 'originalName' wasn't fully sanitized by the caller,
  // though typically it should be before calling this.
  const sanitizedOriginalName = sanitizeStringForFilename(originalName);
  const maxLength = CONFIG.MAX_BASE_FILENAME_LENGTH;

  if (sanitizedOriginalName.length > maxLength) {
    // Generate a short hash from the *original unsanitized input name* for consistency if this function is called multiple times
    // for the same conceptual entity but with slightly different sanitized versions due to upstream processing.
    // However, for simplicity here, we hash the `originalName` parameter passed to this function.
    const hash = crypto.createHash('sha256').update(originalName).digest('hex').substring(0, 8);
    const underscoreAndHashLength = 1 + hash.length; // for "_hash"
    
    // Calculate how much of the name we can keep. Ensure at least a small part of the original name is visible.
    const truncateLength = Math.max(10, maxLength - underscoreAndHashLength); 
    const truncatedName = sanitizedOriginalName.substring(0, truncateLength);
    
    const newName = `${truncatedName}_${hash}`;
    logger.warn(`[Util][${context}] Original filename base "${sanitizedOriginalName}" (${sanitizedOriginalName.length} chars) was too long (max ${maxLength}). Shortened to "${newName}" (${newName.length} chars).`);
    return newName;
  }
  return sanitizedOriginalName; // Return the sanitized name if it's within length limits.
}

/**
 * Generates a base name for a CSS file based on the path of its corresponding source HTML file.
 * It makes the HTML file path relative to the project root, strips configured prefixes (e.g., "src/html/"),
 * replaces directory separators with underscores, and then sanitizes and applies length constraints.
 * @param {string} sourceHtmlFilePath - Absolute path to the source HTML file (e.g., `/path/to/project/src/html/about/team.html`).
 * @returns {string} The generated CSS file base name (e.g., `about_team` or `about_team_hashed`).
 * @example
 * // Assuming PROJECT_ROOT is /path/to/project and CONFIG.HTML_SOURCE_ROOT_PREFIX_TO_OMIT_FROM_CSS_NAME is ['src/html/']
 * generateCssFileBaseName("/path/to/project/src/html/pages/contact.html");
 * // 1. Relative path: "src/html/pages/contact.html"
 * // 2. Prefix stripped: "pages/contact.html"
 * // 3. Base name parts: dir="pages", base="contact"
 * // 4. Combined: "pages_contact"
 * // 5. Sanitized & length checked: "pages_contact" (or "pages_conta_hash1234" if too long)
 */
function generateCssFileBaseName(sourceHtmlFilePath) {
  // Get path relative to project root, e.g., "src/html/some/folder/file.html"
  let relativeHtmlPathFromProjectRoot = path.relative(PROJECT_ROOT, sourceHtmlFilePath);
  relativeHtmlPathFromProjectRoot = relativeHtmlPathFromProjectRoot.replace(/\\/g, '/'); // Normalize to forward slashes for consistent processing.

  let effectivePathForNaming = relativeHtmlPathFromProjectRoot;
  // Strip configured prefixes (e.g., "src/html/") to get a path like "Ruthvik/ruthvik.html" or "index.html"
  for (const prefixToOmit of CONFIG.HTML_SOURCE_ROOT_PREFIX_TO_OMIT_FROM_CSS_NAME) {
    if (effectivePathForNaming.startsWith(prefixToOmit)) {
      effectivePathForNaming = effectivePathForNaming.substring(prefixToOmit.length);
      logger.debug(`   Stripped prefix "${prefixToOmit}" for CSS name generation. Effective path for naming: "${effectivePathForNaming}"`);
      break; 
    }
  }

  const htmlFileBase = path.basename(effectivePathForNaming, '.html'); // e.g., "ruthvik" or "index"
  const htmlFileDir = path.dirname(effectivePathForNaming); // e.g., "Ruthvik" or "."

  let cssFileBase;
  if (htmlFileDir && htmlFileDir !== '.') {
    const prefix = htmlFileDir.replace(/[/\\]/g, '_'); // Convert "Ruthvik" to "Ruthvik"
    cssFileBase = `${prefix}_${htmlFileBase}`; // e.g., "Ruthvik_ruthvik"
  } else {
    cssFileBase = htmlFileBase; // e.g., "index"
  }
  
  const sanitizedCssFileBase = sanitizeStringForFilename(cssFileBase);
  return generateSafeBaseName(sanitizedCssFileBase, 'CSS');
}

// --- Core Logic Functions ---

/**
 * Extracts CSS from inline `<style>` tags and `style` attributes in a Cheerio-loaded HTML document.
 * Modifies the Cheerio object ($) by removing processed `<style>` tags and `style` attributes.
 * @async
 * @param {cheerio.CheerioAPI} $ - The Cheerio API instance loaded with the HTML content.
 * @param {string} sourceHtmlFilePath - Absolute path to the source HTML file (used for logging context).
 * @param {string} htmlFileRawBaseName - The base name of the HTML file (e.g., "index" from "index.html"), used in comments within extracted CSS.
 * @returns {Promise<{cssContent: string, cssModified: boolean}>} An object containing:
 *    - `cssContent` (string): All extracted CSS, trimmed. Includes comments indicating origin.
 *    - `cssModified` (boolean): True if the Cheerio DOM was modified (styles were extracted).
 */
async function extractCssFromHtml($, sourceHtmlFilePath, htmlFileRawBaseName) {
  logger.debug(`Starting CSS extraction for: ${path.relative(PROJECT_ROOT, sourceHtmlFilePath)} (raw name: ${htmlFileRawBaseName})`);
  let allExtractedCss = ''; 
  let cssModified = false; 

  // 1. Extract from <style> tags
  // Using '_' for index as it's not used in the loop.
  $('style').each((_, el) => {
    const $styleTag = $(el); 
    const styleContent = $styleTag.html();
    if (styleContent && styleContent.trim() !== '') {
      allExtractedCss += `\n/* Extracted from <style> tag in ${htmlFileRawBaseName}.html */\n${styleContent.trim()}\n`;
      $styleTag.remove(); 
      cssModified = true;
      logger.debug(`   Extracted and removed <style> tag content from ${htmlFileRawBaseName}.html.`);
    }
  });

  // 2. Extract from style attributes
  // Using '_' for index as it's not used in the loop.
  $('[style]').each((_, el) => {
    const $element = $(el); 
    const inlineStyle = $element.attr('style');
    if (inlineStyle && inlineStyle.trim() !== '') {
      const className = generateUniqueCssClassName(); 
      $element.addClass(className); 
      $element.removeAttr('style');
      allExtractedCss += `\n.${className} {\n  ${inlineStyle.trim().replace(/;\s*$/, '')};\n}\n`; // Ensure trailing semicolon
      cssModified = true;
      logger.debug(`   Extracted inline style from an element in ${htmlFileRawBaseName}.html to class .${className}.`);
    }
  });
  return { cssContent: allExtractedCss.trim(), cssModified };
}

/**
 * Saves extracted CSS content to a file in the `CSS_SRC_FULL_PATH` directory (e.g., `src/assets/styles/`).
 * It prepends Tailwind directives (`@tailwind base; @tailwind components; @tailwind utilities;`) 
 * if they are not already present in an existing file or if the file is new.
 * If the target CSS file already exists and has directives, new, distinct styles are appended.
 * The function also includes a check for older naming conventions of CSS files and logs a warning if found.
 * @async
 * @param {string} cssContent - The CSS content to save. This content is expected to be already trimmed from `extractCssFromHtml`.
 * @param {string} cssFileBaseName - The base name for the CSS file (e.g., "Ruthvik_ruthvik_hashed" or "index").
 * @param {string} sourceHtmlFilePath - Absolute path to the source HTML file from which CSS was extracted. Used for logging and context.
 * @returns {Promise<string|null>} The absolute path to the saved or updated CSS file if successful, otherwise null.
 */
async function saveCssFile(cssContent, cssFileBaseName, sourceHtmlFilePath) {
  // cssContent is assumed to be ALREADY TRIMMED from extractCssFromHtml.
  // cssFileBaseName is the generated base name for the CSS file (e.g., "Ruthvik_ruthvik").
  // sourceHtmlFilePath is the absolute path to the original HTML file in src/, used for logging context.

  if (!cssContent) { // Check if cssContent is empty (it's already trimmed from extractCssFromHtml)
    logger.debug(`No CSS content from ${path.relative(PROJECT_ROOT, sourceHtmlFilePath)} to save.`);
    return null;
  }

  const newCssFileName = `${cssFileBaseName}.css`;
  const newCssFileFullPath = path.join(CSS_SRC_FULL_PATH, newCssFileName); // Target: src/assets/styles/
  logger.debug(`Preparing to save CSS for ${path.basename(sourceHtmlFilePath)} to: ${path.relative(PROJECT_ROOT, newCssFileFullPath)}`);

  try {
    await fs.ensureDir(path.dirname(newCssFileFullPath)); // Ensure 'src/assets/styles/' exists.
    
    let existingCssContent = '';
    const fileExisted = await fs.pathExists(newCssFileFullPath);
    if (fileExisted) {
      existingCssContent = (await fs.readFile(newCssFileFullPath, 'utf-8')).trim(); // Read and trim existing
    }

    const tailwindDirectives = "@tailwind base;\n@tailwind components;\n@tailwind utilities;";
    let contentToWrite = cssContent; // cssContent is already trimmed.

    // Prepend directives if not present in existing content or if file is new
    if (!existingCssContent.includes("@tailwind base;")) {
      contentToWrite = tailwindDirectives + "\n\n" + cssContent; // Add extra newline for separation
      logger.info(`   Prepending Tailwind directives for CSS from ${path.basename(sourceHtmlFilePath)}.`);
    } else if (fileExisted) { // File existed and already had directives
      // Check if the new cssContent (without directives) is already part of existingCssContent
      if (existingCssContent.includes(cssContent)) {
        logger.info(`   New styles from ${path.basename(sourceHtmlFilePath)} already present in ${path.relative(PROJECT_ROOT, newCssFileFullPath)}. No CSS changes needed.`);
        return newCssFileFullPath; // No effective change
      }
      // Append new styles to the existing content (which already has directives)
      contentToWrite = existingCssContent + `\n\n/* --- Appended styles from ${path.basename(sourceHtmlFilePath)} on ${new Date().toISOString()} --- */\n` + cssContent;
      logger.info(`   Appending new styles from ${path.basename(sourceHtmlFilePath)} to: ${path.relative(PROJECT_ROOT, newCssFileFullPath)}`);
    }
    // else: New file, directives were prepended to cssContent, contentToWrite is set.

    // Write only if it's a new file or the content has actually changed.
    // Ensure consistent trailing newline for non-empty files.
    const finalOutput = contentToWrite.trim() ? contentToWrite.trim() + '\n' : '';

    if (!fileExisted || finalOutput.trim() !== existingCssContent) { // Compare trimmed versions to ignore just newline diffs if only that changed
      await fs.writeFile(newCssFileFullPath, finalOutput);
      logger.info(`   ${fileExisted ? 'Updated' : 'Saved new'} CSS file: ${path.relative(PROJECT_ROOT, newCssFileFullPath)}`);
    } else {
      logger.info(`   No effective changes to CSS content for ${path.relative(PROJECT_ROOT, newCssFileFullPath)}. CSS file not rewritten.`);
    }
    return newCssFileFullPath;
  } catch (error) {
    logger.error(`❌ Failed to save/update CSS file ${newCssFileFullPath} for ${path.basename(sourceHtmlFilePath)}: ${error.message}`);
    return null;
  }
}

/**
 * Adds a `<link>` tag for the compiled CSS file to the `<head>` of the Cheerio-loaded HTML document.
 * Calculates the relative path from the HTML file's location in `dist/` to the CSS file in `dist/assets/css/`.
 * Does not add the link if one with the exact same `href` already exists.
 * @param {cheerio.CheerioAPI} $ - The Cheerio API instance loaded with the HTML content. This will be modified.
 * @param {string} destinationHtmlPathInDist - The absolute path where the processed HTML file will eventually be saved in the 'dist' directory.
 *                                            This is used to correctly calculate the relative path for the CSS link.
 * @param {string} cssFileBaseName - The base name of the CSS file (e.g., "Ruthvik_ruthvik" or "index_hashed"),
 *                                   which is used to construct the final CSS filename (e.g., "Ruthvik_ruthvik-output.css").
 * @returns {boolean} True if a new link tag was added, false otherwise (e.g., if it already existed).
 */
function addCssLinkToHtmlHead($, destinationHtmlPathInDist, cssFileBaseName) {
  // $ is the Cheerio object, modified in place.
  // destinationHtmlPathInDist is the *final* absolute path of the HTML file in the 'dist' directory.
  // cssFileBaseName is the base name of the *source* CSS file (e.g., "pages_about" from pages_about.css).

  const compiledCssFileName = `${cssFileBaseName}-output.css`; // Assumes build-css.js appends "-output.css"
  const htmlFileDirInDist = path.dirname(destinationHtmlPathInDist); // Directory of the HTML file in 'dist/'
  
  // Absolute path to where the final compiled CSS file will reside (e.g., /project_root/dist/assets/css/Ruthvik_ruthvik-output.css).
  const targetCssFileInFinalOutputAbsolute = path.join(PROJECT_ROOT, CONFIG.CSS_COMPILED_OUTPUT_DIR_FROM_ROOT, compiledCssFileName);
  
  // Calculate the relative path for the href attribute from the HTML's location in 'dist/' to the CSS's location in 'dist/assets/css/'.
  // e.g., from /project_root/dist/Ruthvik/ruthvik.html to /project_root/dist/assets/css/Ruthvik_ruthvik-output.css
  // results in ../assets/css/Ruthvik_ruthvik-output.css
  let relativeLinkPathFromHtml = path.relative(htmlFileDirInDist, targetCssFileInFinalOutputAbsolute).replace(/\\/g, '/');
  logger.debug(`   Linking to compiled CSS: HTML dist dir: ${htmlFileDirInDist}, CSS target: ${targetCssFileInFinalOutputAbsolute}, Relative href: ${relativeLinkPathFromHtml}`);

  let linkExists = false;
  $('head link[rel="stylesheet"]').each((i, elLink) => { if ($(elLink).attr('href') === relativeLinkPathFromHtml) linkExists = true; });

  if (!linkExists) {
    if ($('head').length === 0) { $.root().prepend('<head></head>'); logger.debug(`   Created <head> in ${path.basename(destinationHtmlPathInDist)}.`); }
    $('head').append(`\n    <link rel="stylesheet" href="${relativeLinkPathFromHtml}">\n  `);
    logger.info(`   Added <link rel="stylesheet" href="${relativeLinkPathFromHtml}"> to HTML for ${path.basename(destinationHtmlPathInDist)}.`);
    return true; // Link was added
  }
  logger.debug(`   Link to "${relativeLinkPathFromHtml}" already exists in HTML for ${path.basename(destinationHtmlPathInDist)}. Skipped.`);
  return false; // Link already existed
}

/**
 * Extracts inline JavaScript from `<script>` tags (those without a `src` attribute) in a Cheerio-loaded HTML document.
 * This function MODIFIES the Cheerio object ($) by:
 *   1. Emptying the content of processed inline `<script>` tags.
 *   2. Adding a `src` attribute to these tags, pointing to the to-be-created external JS file,
 *      which will be located in the same directory as the source HTML file.
 * It does NOT write any JS files to disk itself. Instead, it returns an array of objects,
 * each containing the `fileName`, `content`, and `pathInSourceDir` (absolute path for the new JS file in `src/html/...`).
 * @async
 * @param {cheerio.CheerioAPI} $ - The Cheerio API instance, which will be modified.
 * @param {string} sourceHtmlFilePath - Absolute path to the source HTML file (e.g., `/project_root/src/html/some/page.html`).
 *                                     This is used to determine the directory for the new JS file.
 * @param {string} sourceHtmlFileRawBaseName - The raw base name of the source HTML file (e.g., "page" from "page.html"),
 *                                             used for generating JS filenames.
 * @returns {Promise<{jsModified: boolean, extractedJsData: Array<{fileName: string, content: string, pathInSourceDir: string}>}>}
 *          An object containing:
 *            - `jsModified` (boolean): True if any `<script>` tags were modified in the Cheerio object.
 *            - `extractedJsData` (Array): An array of objects. Each object represents an extracted script and has:
 *                - `fileName` (string): The generated filename for the JS file (e.g., "page-1.js").
 *                - `content` (string): The trimmed JavaScript content.
 *                - `pathInSourceDir` (string): The absolute path where this JS file should be saved within the source HTML's directory
 *                                              (e.g., "/project_root/src/html/some/page-1.js").
 * @example
 * // Given HTML: <script>console.log("hi");</script><script>alert("ho");</script>
 * // And sourceHtmlFilePath: "/path/to/project/src/html/sub/myPage.html"
 * // And sourceHtmlFileRawBaseName: "myPage"
 * // Returns:
 * // {
 * //   jsModified: true,
 * //   extractedJsData: [
 * //     { fileName: "myPage-1.js", content: "console.log(\"hi\");", pathInSourceDir: "/path/to/project/src/html/sub/myPage-1.js" },
 * //     { fileName: "myPage-2.js", content: "alert(\"ho\");", pathInSourceDir: "/path/to/project/src/html/sub/myPage-2.js" }
 * //   ]
 * // }
 * // And the Cheerio object ($) will have its <script> tags updated to <script src="myPage-1.js"></script> etc.
 * // (src is relative to the HTML file).
 */
async function extractJsFromHtmlLogic($, sourceHtmlFilePath, htmlFileRawBaseName) { // Parameter renamed for consistency
  // $ is the Cheerio object, modified in place.
  // sourceHtmlFilePath is the absolute path to the original HTML file in src/ (e.g., /project_root/src/html/folder/file.html).
  // htmlFileRawBaseName is the original base name of the HTML file, used for JS filename generation. (Comment updated)

  let jsModified = false; // True if Cheerio DOM is changed (script tags modified)
  const scriptTagsToProcess = [];
  // extractedJsData stores { fileName, content, pathInSourceDir (absolute path for new JS file) }
  const extractedJsData = []; 

  $('script').each((i, el) => {
    const $scriptTag = $(el);
    if (!$scriptTag.attr('src') && $scriptTag.html() && $scriptTag.html().trim() !== '') {
      scriptTagsToProcess.push($scriptTag);
    }
  });

  if (scriptTagsToProcess.length === 0) {
    logger.debug(`   No inline JS found in ${path.basename(sourceHtmlFilePath)}.`);
    return { jsModified: false, extractedJsData: [] };
  }

  const sanitizedHtmlBaseForJs = sanitizeStringForFilename(htmlFileRawBaseName); // Changed to use renamed parameter
  const safeJsFileBase = generateSafeBaseName(sanitizedHtmlBaseForJs, 'JS');
  const sourceHtmlDir = path.dirname(sourceHtmlFilePath); // Directory of the source HTML file (e.g., /project_root/src/html/folder)

  for (let i = 0; i < scriptTagsToProcess.length; i++) {
    const $scriptTag = scriptTagsToProcess[i];
    const scriptContent = $scriptTag.html().trim();
    const suffix = scriptTagsToProcess.length > 1 ? `-${i + 1}` : '';
    const jsFileName = `${safeJsFileBase}${suffix}.js`; // e.g., file-1.js
    
    // Absolute path for the new JS file, in the same directory as the source HTML.
    const jsFileAbsolutePathInSource = path.join(sourceHtmlDir, jsFileName); 

    extractedJsData.push({
      fileName: jsFileName, // Just the filename, e.g., "file-1.js"
      content: scriptContent,
      pathInSourceDir: jsFileAbsolutePathInSource, // Absolute path for saving in src/html/...
    });
      
    $scriptTag.html(''); 
    // The src attribute should be relative to the HTML file, which is just the filename
    // as they will be in the same directory in src/html/...
    $scriptTag.attr('src', jsFileName); 
    jsModified = true;
    logger.info(`   Prepared JS extraction for ${jsFileName} from ${path.basename(sourceHtmlFilePath)}. Target JS in source: ${path.relative(PROJECT_ROOT, jsFileAbsolutePathInSource)}.`);
  }
  return { jsModified, extractedJsData };
}

// --- Callable Core Refactoring Logic ---
/**
 * Performs the core HTML refactoring logic for a single source HTML file.
 * This function reads the source HTML, processes it using Cheerio to extract CSS and JavaScript,
 * updates link/script tags in the Cheerio DOM, and prepares the data for output.
 * - Extracted CSS (with Tailwind directives) is written to `src/assets/styles/`.
 * - Processed HTML content (with updated script/link tags) and data for extracted JS files
 *   (including their content and intended paths in the source directory `src/html/...`) are returned.
 * - This function does NOT write the modified HTML back to `src/html/` nor does it write the extracted JS files to `src/html/`.
 *   That responsibility lies with the caller (e.g., `processAndWriteHtmlFile` or `build-prod.js`).
 * 
 * @async
 * @param {string} sourceHtmlFilePath - Absolute path to the source HTML file (e.g., `/path/to/project/src/html/index.html`).
 * @returns {Promise<object>} A promise that resolves to an object containing the refactoring results.
 *    The object has the following structure:
 *    ```
 *    {
 *      sourceHtmlPath: string,        // Absolute path to the original source HTML file.
 *      destinationHtmlPathForDist: string, // Calculated absolute path for where the HTML should go in 'dist/' (for copying).
 *      initialHtmlContent: string,    // Original content of the source HTML file.
 *      processedHtmlContent: string,  // HTML content after all Cheerio modifications (CSS/JS extraction, link/script updates).
 *                                     // This is the content that should be written back to sourceHtmlPath AND copied to destinationHtmlPathForDist.
 *      extractedJsFiles: Array<{      // Array of objects for each extracted JavaScript block.
 *        fileName: string,            // Filename for the JS file (e.g., "index-1.js").
 *        content: string,             // The actual JavaScript code.
 *        pathInSourceDir: string      // Absolute path where this JS file should be saved in the source HTML's directory (e.g., "/project_root/src/html/index-1.js").
 *      }>,
 *      extractedCssFile: string|null, // Path to the saved CSS file in 'src/assets/styles/', relative to PROJECT_ROOT, or null if no CSS was extracted/saved.
 *      wasModifiedInCheerio: boolean  // True if the Cheerio DOM was changed (CSS extracted, JS extracted, or CSS link added).
 *    }
 *    ```
 * @throws {Error} If reading the source HTML file fails or other critical errors occur during processing.
 */
async function performHtmlRefactoringLogic(sourceHtmlFilePath) {
  const sourceHtmlFileRelative = path.relative(PROJECT_ROOT, sourceHtmlFilePath); // Used for logging
  const htmlFileRawBaseName = path.basename(sourceHtmlFilePath, '.html'); // e.g., "index"
  logger.debug(`[performHtmlRefactoringLogic] Starting for source file: ${sourceHtmlFileRelative}`);

  // Determine the destination path for the processed HTML file copy within the 'dist/' directory.
  // It mirrors the subdirectory structure from `src/html/`.
  const scanRoot = path.join(PROJECT_ROOT, CONFIG.HTML_SCAN_ROOTS[0]); // Absolute path to e.g. /project_root/src/html/
  const relativePathFromScanRoot = path.relative(scanRoot, sourceHtmlFilePath); // e.g., "Ruthvik/ruthvik.html" or "index.html"
  const destinationHtmlPathForDist = path.join(HTML_OUTPUT_FULL_PATH, relativePathFromScanRoot); // Absolute path, e.g., /project_root/dist/Ruthvik/ruthvik.html
  logger.debug(`   [performHtmlRefactoringLogic] Calculated destination for HTML copy in 'dist/': ${path.relative(PROJECT_ROOT, destinationHtmlPathForDist)}`);
  
  let initialHtmlContent;
  try {
    initialHtmlContent = await fs.readFile(sourceHtmlFilePath, 'utf-8');
  } catch (error) {
    logger.error(`❌ Failed to read source HTML file: ${sourceHtmlFileRelative}`, error);
    throw error; // Re-throw to be caught by caller (e.g., build-prod.js or processAndWriteHtmlFile)
  }
  
  const $ = cheerio.load(initialHtmlContent, { decodeEntities: false, xmlMode: false });

  // 1. Process CSS: Extract from Cheerio DOM, save to 'src/assets/styles/', update Cheerio DOM with <link> to dist CSS.
  const { cssContent, cssModified } = await extractCssFromHtml($, sourceHtmlFilePath, htmlFileRawBaseName);
  let cssLinkAdded = false; 
  let savedSourceCssPath = null; 
  if (cssContent && cssContent.trim()) { // Ensure cssContent has actual content
    const cssFileBase = generateCssFileBaseName(sourceHtmlFilePath);
    savedSourceCssPath = await saveCssFile(cssContent, cssFileBase, sourceHtmlFilePath); // Writes to src/assets/styles
    if (savedSourceCssPath) {
      // The <link> in the HTML (both src and dist versions) should point to the final compiled CSS in dist.
      cssLinkAdded = addCssLinkToHtmlHead($, destinationHtmlPathForDist, cssFileBase); // Modifies $
    }
  }
  
  // 2. Process JS: Extracts from Cheerio DOM, returns JS data (for saving into src/html/), modifies $ with <script src="local.js">
  // Note: destinationHtmlPathInDist is NOT used by extractJsFromHtmlLogic anymore for path calculations. It was previously used to calculate jsFileDistRelativePath.
  // Now, extractJsFromHtmlLogic only needs sourceHtmlFilePath and sourceHtmlFileRawBaseName to determine JS paths relative to source.
  const { jsModified, extractedJsData } = await extractJsFromHtmlLogic($, sourceHtmlFilePath, htmlFileRawBaseName);

  const finalHtmlContent = $.html(); // Get the fully modified HTML string.
  logger.debug(`   [performHtmlRefactoringLogic] Finished for: ${sourceHtmlFileRelative}. CSS modified in DOM: ${cssModified}, JS modified in DOM: ${jsModified}, CSS link added to DOM: ${cssLinkAdded}`);

  return {
    sourceHtmlPath: sourceHtmlFilePath, // Absolute path to source
    destinationHtmlPathForDist: destinationHtmlPathForDist, // Absolute path for HTML copy in dist
    initialHtmlContent: initialHtmlContent,
    processedHtmlContent: finalHtmlContent, // This is the HTML that will be written to source AND copied to dist
    // The 'extractedJsFiles' array now contains objects with 'pathInSourceDir' (absolute path)
    // instead of 'pathInDist' (relative to dist root).
    extractedJsFiles: extractedJsData, 
    extractedCssFile: savedSourceCssPath ? path.relative(PROJECT_ROOT, savedSourceCssPath) : null, // Path to CSS in src/assets/styles, relative to project root
    wasModifiedInCheerio: cssModified || jsModified || cssLinkAdded, // If Cheerio DOM was changed
  };
}

// --- File Writing Wrapper (used by main() for direct execution like by auto-dev.js) ---
/**
 * Higher-level function that orchestrates the refactoring of a single source HTML file
 * and writes the output (processed HTML, extracted JS) to the `dist/` directory.
 * It calls `performHtmlRefactoringLogic` to get the processed content and then handles file I/O.
 * Extracted CSS is saved to `src/assets/styles/` directly by `saveCssFile` (called within `performHtmlRefactoringLogic`).
 * This function is typically used when `html-refactor.js` is run directly (e.g., by `auto-dev.js` or manually).
 * 
 * @async
 * @param {string} sourceHtmlFilePath - Absolute path to the source HTML file 
 *                                      (e.g., `/path/to/project/src/html/index.html`).
 * @returns {Promise<boolean>} A promise that resolves to `true` if any files (HTML or JS) were actually written or updated
 *                             in the `dist/` directory as a result of this processing, or if CSS was extracted.
 *                             Resolves to `false` if no changes necessitated file writes or if an error occurred.
 * @throws {Error} This function catches errors from `performHtmlRefactoringLogic` and its own file operations,
 *                 logs them, and returns `false`. It does not typically re-throw, allowing batch operations
 *                 in `main()` to continue. However, critical errors from `performHtmlRefactoringLogic` (like read failures)
 *                 might still propagate if not caught there.
 */
async function processAndWriteHtmlFile(sourceHtmlFilePath) {
  const sourceHtmlFileRelative = path.relative(PROJECT_ROOT, sourceHtmlFilePath); // For user-friendly logging
  logger.info(`Processing & Writing for source HTML: ${sourceHtmlFileRelative}`);
  
  try {
    // Step 1: Get the processed data from the core logic function.
    // This involves reading the source HTML, extracting CSS (and saving it to src/assets/styles),
    // extracting JS data, and preparing the modified HTML content in memory.
    const result = await performHtmlRefactoringLogic(sourceHtmlFilePath);
    
    let filesWrittenOrChangedThisRun = 0; // Tracks files written by *this* function call.
                                      // result.wasModifiedInCheerio indicates if DOM changed.
                                      // result.extractedCssFile indicates if CSS was saved by saveCssFile.

    // Step 2: Write the processed HTML to the 'dist/' directory.
    // Step 2: Write extracted JS files to the SOURCE directory (e.g., src/html/...).
    // The `result.extractedJsFiles` contains objects with `pathInSourceDir` (absolute path) and `content`.
    for (const jsFile of result.extractedJsFiles) {
      // jsFile.pathInSourceDir is the absolute path like /project_root/src/html/sub/myPage-1.js
      let jsWrittenToSource = false;
      if (await fs.pathExists(jsFile.pathInSourceDir)) {
        const existingJsContent = await fs.readFile(jsFile.pathInSourceDir, 'utf-8');
        if (existingJsContent !== jsFile.content) {
          await fs.writeFile(jsFile.pathInSourceDir, jsFile.content);
          logger.info(`   ✅ Updated JS in source: ${path.relative(PROJECT_ROOT, jsFile.pathInSourceDir)}`);
          jsWrittenToSource = true;
          filesWrittenOrChangedThisRun++;
        } else {
          logger.info(`   ℹ️ Extracted JS content for ${path.relative(PROJECT_ROOT, jsFile.pathInSourceDir)} is identical. Source JS not rewritten.`);
        }
      } else {
        await fs.ensureDir(path.dirname(jsFile.pathInSourceDir));
        await fs.writeFile(jsFile.pathInSourceDir, jsFile.content);
        logger.info(`   ✅ Saved new JS to source: ${path.relative(PROJECT_ROOT, jsFile.pathInSourceDir)}`);
        jsWrittenToSource = true;
        filesWrittenOrChangedThisRun++;
      }

      // Step 2b: Copy this new/updated source JS file to the 'dist/' directory.
      // Construct the destination path in 'dist/' mirroring the structure from 'src/html/'.
      // jsFile.fileName is just "myPage-1.js"
      // result.destinationHtmlPathForDist is like /project_root/dist/sub/myPage.html
      const jsDestDirInDist = path.dirname(result.destinationHtmlPathForDist); // e.g. /project_root/dist/sub
      const jsDestPathInDist = path.join(jsDestDirInDist, jsFile.fileName); // e.g. /project_root/dist/sub/myPage-1.js

      // Copy if the source JS was newly written/updated, or if the dist version doesn't exist/differs.
      let copyJsToDist = jsWrittenToSource; // If we just wrote it to source, assume we want to copy it.
      if (!copyJsToDist && await fs.pathExists(jsDestPathInDist)) {
          const distJsContent = await fs.readFile(jsDestPathInDist, 'utf-8');
          if (distJsContent !== jsFile.content) {
              copyJsToDist = true; // Content differs, so copy.
          }
      } else if (!await fs.pathExists(jsDestPathInDist)) {
          copyJsToDist = true; // Dist file doesn't exist, so copy.
      }

      if (copyJsToDist) {
        await fs.ensureDir(path.dirname(jsDestPathInDist));
        await fs.copyFile(jsFile.pathInSourceDir, jsDestPathInDist); // Copy from new source JS path
        logger.info(`   ✅ Copied JS from source to dist: ${path.relative(PROJECT_ROOT, jsDestPathInDist)}`);
        // filesWrittenOrChangedThisRun is already incremented if jsWrittenToSource was true.
        // If only copying due to dist diff/absence but source was identical, this still counts as a "change" for this run's output.
        // However, the definition of filesWrittenOrChangedThisRun is more about "did this function cause a git diff".
        // Let's be explicit: if the copy happened, it's a change relevant to `dist`.
        // This counter is a bit tricky. Let's assume if source JS was touched, or dist JS was touched, it's a change.
        // The existing logic for incrementing filesWrittenOrChangedThisRun for source JS handles one part.
        // If jsWrittenToSource is false, but copyJsToDist is true, it means dist was updated.
        if (!jsWrittenToSource) filesWrittenOrChangedThisRun++; 
      } else {
        logger.info(`   ℹ️ JS in dist ${path.relative(PROJECT_ROOT, jsDestPathInDist)} is already up-to-date with source. Not copied.`);
      }
    }

    // Step 3: Write the processed HTML (which now has <script src="local.js">) back to the SOURCE HTML file.
    // This overwrites the original source HTML file.
    // Only write if the content actually changed.
    if (result.processedHtmlContent !== result.initialHtmlContent) {
      await fs.writeFile(result.sourceHtmlPath, result.processedHtmlContent, 'utf-8');
      logger.info(`   ✅ Overwrote source HTML with refactored content: ${sourceHtmlFileRelative}`);
      filesWrittenOrChangedThisRun++;
    } else {
      logger.info(`   ℹ️ No changes to HTML content for source file ${sourceHtmlFileRelative}. Source HTML not rewritten.`);
    }

    // Step 4: Copy the (potentially modified) source HTML (now result.processedHtmlContent) to the 'dist/' directory.
    // This ensures dist has the version with correct local script tags, matching the JS files copied to dist.
    const destHtmlInDistExists = await fs.pathExists(result.destinationHtmlPathForDist);
    let htmlCopiedToDist = false;
    if (!destHtmlInDistExists || result.processedHtmlContent !== (destHtmlInDistExists ? await fs.readFile(result.destinationHtmlPathForDist, 'utf-8') : "")) {
        await fs.ensureDir(path.dirname(result.destinationHtmlPathForDist));
        await fs.writeFile(result.destinationHtmlPathForDist, result.processedHtmlContent, 'utf-8');
        logger.info(`   ✅ ${!destHtmlInDistExists ? 'Created' : 'Updated'} HTML copy in dist: ${path.relative(PROJECT_ROOT, result.destinationHtmlPathForDist)}`);
        htmlCopiedToDist = true;
        // If source HTML wasn't changed but dist HTML was, count it.
        if (result.processedHtmlContent === result.initialHtmlContent) filesWrittenOrChangedThisRun++;
    } else {
        logger.info(`   ℹ️ HTML copy in dist ${path.relative(PROJECT_ROOT, result.destinationHtmlPathForDist)} is already up-to-date. Not rewritten.`);
    }
    
    // Final check for plain copy if no refactoring occurred but dist HTML was missing
    // This case handles if an HTML file is added to src/html that has no inline styles/scripts.
    // It should still be copied to dist.
    if (!result.wasModifiedInCheerio && !destHtmlInDistExists && !htmlCopiedToDist) {
        logger.info(`   Source HTML ${sourceHtmlFileRelative} had no refactorable content, but copying to dist as it's missing: ${path.relative(PROJECT_ROOT, result.destinationHtmlPathForDist)}`);
        await fs.ensureDir(path.dirname(result.destinationHtmlPathForDist));
        // Copy the original content if no cheerio modifications happened.
        await fs.writeFile(result.destinationHtmlPathForDist, result.initialHtmlContent, 'utf-8'); 
        filesWrittenOrChangedThisRun++;
    }

    return filesWrittenOrChangedThisRun > 0;
  } catch (error) {
    logger.error(`❌ Error in processAndWriteHtmlFile for ${sourceHtmlFileRelative}: ${error.message}`);
    logger.debug(error.stack);
    return false;
  }
}

// --- Main Execution Function (for command-line use by auto-dev.js or manual runs) ---
/**
 * Main function for the script. Executed when the script is run directly from the command line.
 * It handles two modes of operation:
 * 1. Single File Mode: If a file path is provided as a command-line argument, it processes only that file.
 *    - Validates that the file exists, is an HTML file, and is within the configured `SRC_HTML_FULL_PATH`.
 * 2. Batch Mode: If no file path argument is provided, it scans `SRC_HTML_FULL_PATH` (e.g., `src/html/`)
 *    for HTML files based on `CONFIG.SRC_HTML_FILES_PATTERN`, `CONFIG.IGNORE_PATTERNS`,
 *    `CONFIG.ROOT_FILES_TO_PROCESS`, and `CONFIG.PROCESS_ALL_SUBDIR_HTML`.
 * 
 * For each identified HTML file, it calls `processAndWriteHtmlFile` to perform refactoring and
 * write outputs (HTML/JS to `dist/`, CSS to `src/assets/styles/`).
 * Logs summary information about the process. Exits with code 1 on critical errors.
 * @async
 */
async function main() {
  console.log('====================================================================');
  logger.info('     🚀 Starting HTML Refactoring Script (Direct Run Mode)...');
  console.log('====================================================================');
  let processedFileCount = 0; 
  let changedFileCount = 0; // Counts files where processAndWriteHtmlFile returned true (meaning some output was written)

  try {
    // Ensure base output directories exist before any processing.
    // CSS_SRC_FULL_PATH is for intermediate CSS files (e.g., project_root/src/assets/styles/)
    await fs.ensureDir(CSS_SRC_FULL_PATH);
    logger.info(`Source CSS directory (for extracted CSS) ensured at: ${path.relative(PROJECT_ROOT, CSS_SRC_FULL_PATH)}`);
    // HTML_OUTPUT_FULL_PATH is the root for final HTML/JS (e.g., project_root/dist/)
    await fs.ensureDir(HTML_OUTPUT_FULL_PATH); 
    logger.info(`Output HTML/JS directory (dist) ensured at: ${path.relative(PROJECT_ROOT, HTML_OUTPUT_FULL_PATH)}`);

    const specificFileArg = process.argv[2]; // Get the first command-line argument after script name.

    if (specificFileArg) {
      // --- Single File Processing Mode ---
      // Typically called by auto-dev.js when a new HTML file is added in src/html/.
      // The argument is expected to be a path relative to PROJECT_ROOT.
      const specificSourceFilePath = path.resolve(PROJECT_ROOT, specificFileArg); 
      logger.info(`Single file mode: Attempting to process source file argument: "${specificFileArg}" (Resolved: ${specificSourceFilePath})`);

      // Basic validations for the provided file path.
      if (! (await fs.pathExists(specificSourceFilePath))) {
          logger.error(`❌ Source HTML file not found: "${specificSourceFilePath}". Aborting.`);
          process.exit(1);
      }
      if (path.extname(specificSourceFilePath).toLowerCase() !== '.html'){
          logger.error(`❌ Specified file is not an HTML file: "${specificFileArg}". Aborting.`);
          process.exit(1);
      }
      // Critical check: Ensure the file to process is within the designated source HTML directory.
      // This prevents accidental processing of files outside src/html/ (e.g. in dist/ or elsewhere).
      if (!specificSourceFilePath.startsWith(SRC_HTML_FULL_PATH)) {
           logger.error(`❌ Specified file "${specificFileArg}" (resolved to ${specificSourceFilePath}) is not within the configured source HTML directory (${SRC_HTML_FULL_PATH}). Aborting.`);
           process.exit(1);
      }
      
      // Note: CONFIG.IGNORE_PATTERNS are not explicitly checked here for single-file mode,
      // as the primary validation is that it's within SRC_HTML_FULL_PATH.
      // If finer-grained ignores are needed for single files, that logic could be added.
      logger.info(`   Processing single source file: ${path.relative(PROJECT_ROOT, specificSourceFilePath)}`);
      processedFileCount++;
      if (await processAndWriteHtmlFile(specificSourceFilePath)) {
        changedFileCount++;
      }
    } else {
      // --- Batch Processing Mode ---
      // Executed when the script is run manually without arguments (e.g., `node html-refactor.js`).
      logger.info(`Batch mode: Scanning for HTML files in ${SRC_HTML_FULL_PATH} using pattern "${CONFIG.SRC_HTML_FILES_PATTERN}"`);
      
      // Glob for HTML files within the primary HTML source directory (e.g., project_root/src/html/).
      // `CONFIG.IGNORE_PATTERNS` are applied relative to this `cwd`.
      const htmlFilesInScanRoot = globSync(CONFIG.SRC_HTML_FILES_PATTERN, { 
        cwd: SRC_HTML_FULL_PATH, 
        absolute: true, // Return absolute paths for consistency with processAndWriteHtmlFile.
        nodir: true,    // Exclude directories.
        ignore: CONFIG.IGNORE_PATTERNS // Apply configured ignore patterns.
      });
      logger.info(`Found ${htmlFilesInScanRoot.length} HTML file(s) for potential batch processing in ${CONFIG.HTML_SCAN_ROOTS[0]}.`);
      
      // Further filter the found files based on ROOT_FILES_TO_PROCESS and PROCESS_ALL_SUBDIR_HTML.
      const filesToProcess = htmlFilesInScanRoot.filter(absHtmlPath => {
          // `absHtmlPath` is an absolute path from the glob result.
          // `SRC_HTML_FULL_PATH` is the absolute path to the scan root (e.g. /path/to/project/src/html).
          const relativeToScanRoot = path.relative(SRC_HTML_FULL_PATH, absHtmlPath).replace(/\\/g, '/');
          const isInScanRootBase = !relativeToScanRoot.includes('/'); // True if file is directly in SRC_HTML_FULL_PATH, not a subdir.
          
          if (isInScanRootBase) {
              const baseNameLower = path.basename(relativeToScanRoot).toLowerCase();
              const shouldProcess = CONFIG.ROOT_FILES_TO_PROCESS.map(f => f.toLowerCase()).includes(baseNameLower);
              if(!shouldProcess) logger.debug(`Skipping root-level file in scan dir (not in ROOT_FILES_TO_PROCESS): ${relativeToScanRoot}`);
              return shouldProcess;
          }
          // If in a subdirectory of SRC_HTML_FULL_PATH and PROCESS_ALL_SUBDIR_HTML is true.
          if (!isInScanRootBase && CONFIG.PROCESS_ALL_SUBDIR_HTML) {
              return true; 
          }
          logger.debug(`Skipping file (not matching root/subdir processing criteria within scan dir): ${relativeToScanRoot}`);
          return false;
      });

      logger.info(`After filtering, ${filesToProcess.length} HTML file(s) will be processed in batch mode.`);
      for (const filePath of filesToProcess) {
        processedFileCount++;
        if (await processAndWriteHtmlFile(filePath)) { // processAndWriteHtmlFile expects absolute path
          changedFileCount++;
        }
      }
    } 

    // --- Summary Logging ---
    console.log('============================================================');
    logger.info('   🏁 HTML Refactoring Script Complete (Direct Run Mode).');
    console.log('============================================================');
    if (processedFileCount > 0) {
        logger.info(`   - ${processedFileCount} HTML source file(s) were analyzed.`);
        if (changedFileCount > 0) {
            // changedFileCount now represents source HTML files that led to *any* output file being written or updated.
            logger.info(`   - ${changedFileCount} source HTML file(s) resulted in changes:`);
            logger.info(`     - Potentially modified/created JS files and HTML files in 'src/html/'.`);
            logger.info(`     - Output files written/updated (HTML/JS copies to 'dist/', CSS to '${CONFIG.CSS_SRC_DIR_PATH_FROM_ROOT}').`);
            logger.warn(`   💡 IMPORTANT: If this run was part of a development flow, ensure your CSS build process`);
            logger.warn(`     (e.g., 'npm run build:css') is triggered to compile the CSS from '${CONFIG.CSS_SRC_DIR_PATH_FROM_ROOT}'.`);
        } else {
            logger.info(`   - No source HTML files required modifications, or files in 'src/html/' and 'dist/' were already up-to-date or content identical.`);
        }
    } else if (specificFileArg) {
        logger.info(`   - The specified HTML file ("${specificFileArg}") was not processed (e.g., due to path/ignore issues or no changes needed).`);
    } else {
        logger.info(`   - No HTML files were found to process based on scan criteria in batch mode.`);
    }
    logger.info('   Remember to:');
    logger.info('     1. Review all file changes made by this script (use Git diff), particularly in:');
    logger.info('        - Source HTML and any new/modified JS files within `src/html/`.');
    logger.info('        - Extracted CSS files in `src/assets/styles/`.');
    logger.info('        - All copied/generated files in `dist/`.');
    logger.info('     2. Heed any [CSS Migration] WARNINGS from `saveCssFile` and manually merge/delete old CSS files if applicable.');
    logger.info('     3. Verify links and script sources in the `src/html/` files and the generated `dist/` HTML files.');
    logger.info('     4. Test your website thoroughly by serving the `dist/` directory.');

  } catch (error) { 
    logger.error("❌ An unexpected critical error occurred during the HTML refactoring process:");
    // Log message and stack (if available) separately for better readability.
    if (error.message) {
        logger.error(error.message);
    }
    if (error.stack) {
        logger.debug(error.stack); // Stack trace at debug level
    }
    process.exit(1); 
  }
}

// Export the core logic function for build-prod.js or other programmatic uses.
// Run main() only if the script is executed directly (e.g., `node html-refactor.js` or by auto-dev.js).
if (require.main === module) {
  main();
}
module.exports = { performHtmlRefactoringLogic };
