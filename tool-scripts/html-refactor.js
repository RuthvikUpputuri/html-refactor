#!/usr/bin/env node

/**
 * @file html-refactor.js
 * @module html-refactor
 * @author Ruthvik Upputuri
 * @license MIT
 * @version 1.0.0
 *
 * @description
 * This script automates the refactoring of HTML files within a project.
 * It performs the following actions:
 * 1. Discovers HTML files based on user configuration.
 * 2. Extracts inline CSS from <style> tags and 'style' attributes into separate .css files.
 * 3. Extracts inline JavaScript from <script> tags (those without a 'src' attribute) into separate .js files.
 * 4. Updates HTML <head> sections to include <link rel="stylesheet"> tags for the newly created CSS files.
 * 5. Modifies inline <script> tags to use the `src` attribute, linking to the extracted JavaScript files.
 *
 * This tool is designed to be run as a CLI command (html-refactor, href, htref).
 * It supports interactive configuration setup, persistent configuration via href.config.json,
 * dry runs, file backups, detailed logging, and customizable output paths.
 */

// Node.js built-in modules
const crypto = require('crypto');
const path = require('path');

// Third-party dependencies
const fs = require('fs-extra'); // For robust file system operations
const { glob } = require('glob'); // For powerful file pattern matching
const cheerio = require('cheerio'); // For HTML parsing and manipulation (jQuery-like API)
const yargs = require('yargs/yargs'); // For command-line argument parsing
const { hideBin } = require('yargs/helpers'); // Helper for yargs
const inquirer = require('inquirer'); // For interactive command-line user interfaces
const chalk = require('chalk'); // For colored console output (ensure chalk@4 for CommonJS)

// --- Constants ---

/** @constant {string} SCRIPT_PRIMARY_COMMAND - The primary command name for the CLI. */
const SCRIPT_PRIMARY_COMMAND = 'html-refactor';

/** @constant {string} CONFIG_FILE_NAME - The name of the configuration file. */
const CONFIG_FILE_NAME = 'href.config.json';

/** @constant {string} DEFAULT_LOG_DIR_NAME - The default directory name for log files, relative to project root. */
const DEFAULT_LOG_DIR_NAME = '.href-logs';

/** @constant {string} DEFAULT_STYLES_OUTPUT_DIR - Default subdirectory for extracted CSS files. */
const DEFAULT_STYLES_OUTPUT_DIR = 'styles/extracted';

/** @constant {string} DEFAULT_COMPILED_CSS_LINK_DIR - Default directory for linked compiled CSS in HTML. */
const DEFAULT_COMPILED_CSS_LINK_DIR = 'assets/css';

/**
 * @constant {{DEBUG: number, INFO: number, WARN: number, ERROR: number, SILENT: number}} LOG_LEVELS
 * Defines numeric values for different log levels.
 */
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SILENT: 4 };

/**
 * @constant {RegExp} FILENAME_SANITIZATION_REGEX
 * Regular expression for characters to remove or replace in filenames.
 * Allows alphanumeric characters, underscores, dots, and hyphens.
 */
const FILENAME_SANITIZATION_REGEX = /[^a-zA-Z0-9_.-]/g;

/** @constant {string} FILENAME_SANITIZATION_REPLACEMENT - Character used to replace sanitized characters. */
const FILENAME_SANITIZATION_REPLACEMENT = '_';

// --- Global Variables ---

/**
 * @global
 * @type {object | null} loggerInstance - Holds the initialized logger object.
 */
let loggerInstance = null;

/**
 * @global
 * @type {number} uniqueClassCounter - Counter for generating unique CSS class names.
 */
let uniqueClassCounter = 0;


// --- Logger Utility ---

/**
 * Generates a standard ISO timestamp string.
 * @returns {string} ISO formatted timestamp.
 */
function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Initializes or re-initializes the logger instance.
 * @param {string} [logLevelName='INFO'] - The desired log level (e.g., 'DEBUG', 'INFO').
 * @param {string} [logFilePath] - Absolute path to the log file. If provided, logs will be written to this file.
 * @returns {object} The logger instance with methods like debug, info, warn, error, success, raw, getLogLevel, setLogLevel, close.
 */
function initializeLogger(logLevelName = 'INFO', logFilePath) {
  const level = LOG_LEVELS[logLevelName.toUpperCase()] || LOG_LEVELS.INFO;
  const PREFIX = '@'
  const SUFFIX = 'GMT';
  let logStream = null;

  if (logFilePath) {
    try {
      fs.ensureDirSync(path.dirname(logFilePath)); // Ensure log directory exists
      logStream = fs.createWriteStream(logFilePath, { flags: 'a' }); // Append to log file
      logStream.write(`\n--- Log session started at ${getTimestamp()} ${SUFFIX} ---\n`);
    } catch (e) {
      // Fallback to console if log file creation fails
      console.error(chalk.red(`[${SCRIPT_PRIMARY_COMMAND}] Critical Error: Could not create log file at ${logFilePath}: ${e.message}`));
      logStream = null;
    }
  }

  /**
   * Internal log processing function.
   * @param {number} messageLevel - The numeric level of the message.
   * @param {function} consoleColor - Chalk function for console color.
   * @param {...any} args - Messages to log.
   */
  const log = (messageLevel, consoleColor, ...args) => {
    if (messageLevel < level && messageLevel !== LOG_LEVELS.SILENT) return; // Respect log level

    const formattedMessage = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    const logLevelKey = Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === messageLevel) || 'UNKNOWN';
    const consolePrefix = `[${SCRIPT_PRIMARY_COMMAND}][${logLevelKey}]`;
    const filePrefix = `[${PREFIX} ${getTimestamp()} ${SUFFIX}] ${consolePrefix}`;

    if (messageLevel !== LOG_LEVELS.SILENT) {
      console.log(consoleColor(`${consolePrefix} ${formattedMessage}`));
    }

    if (logStream) {
      try {
        logStream.write(`${filePrefix} ${formattedMessage}\n`);
      } catch (e) {
        // Handle potential write errors to a closed stream gracefully
        console.error(chalk.red(`[${SCRIPT_PRIMARY_COMMAND}] Error writing to log stream: ${e.message}`));
      }
    }
  };

  loggerInstance = {
    debug: (...args) => log(LOG_LEVELS.DEBUG, chalk.gray, ...args),
    info: (...args) => log(LOG_LEVELS.INFO, chalk.blue, ...args),
    warn: (...args) => log(LOG_LEVELS.WARN, chalk.yellow, ...args),
    error: (...args) => log(LOG_LEVELS.ERROR, chalk.red, ...args),
    success: (...args) => log(LOG_LEVELS.INFO, chalk.green, ...args), // Success messages are typically INFO level
    raw: (...args) => console.log(...args), // For direct console output, bypassing formatting
    getLogLevel: () => level,
    /**
     * Intended for dynamically changing log level.
     * Note: For file logging, re-initialization might be needed if path changes.
     */
    setLogLevel: (newLevelName) => {
        const newLevel = LOG_LEVELS[newLevelName.toUpperCase()];
        if (typeof newLevel === 'number') {
            if (loggerInstance) loggerInstance.info(`Log level intention changed to ${newLevelName}. New messages will respect this level.`);
            // Actual level change happens on next log call within the 'log' function or by re-initializing.
            // For immediate effect on the 'level' variable, one might re-initialize or set 'level' directly.
        } else {
            if (loggerInstance) loggerInstance.warn(`Invalid log level provided: ${newLevelName}`);
        }
    },
    /** Closes the log file stream if it's open. */
    close: () => {
      if (logStream) {
        logStream.write(`--- Log session ended ${PREFIX} ${getTimestamp()} ${SUFFIX} ---\n`);
        logStream.end(); // Gracefully close the stream
        logStream = null;
      }
    }
  };
  return loggerInstance;
}

// --- Project Root Detection ---

/**
 * Finds the project root by searching for key indicator files/folders.
 * Prioritizes tailwind.config.js, then .git, package.json, .gitignore.
 * Falls back to script's parent or CWD.
 * @param {string} startPath - The path to start searching from (usually `__dirname` or `process.cwd()`).
 * @returns {{projectRoot: string, method: string}} An object containing the project root path and the method used for detection.
 */
function findProjectRoot(startPath) {
  let currentSearchPath = path.resolve(startPath);
  const scriptFileName = path.basename(__filename);

  // Indicators to search for, in order of preference for breaking early
  let tailwindConfigPath = null;
  // Indicators to find at the *highest* level (closest to filesystem root)
  let highestGitRepoPath = null;
  let highestPackageJsonPath = null;
  let highestGitIgnorePath = null;

  // First pass: Traverse upwards to find tailwind.config.js (highest priority)
  // and identify potential candidates for other markers.
  let searchPathForFirstPass = path.resolve(startPath);
  while (true) {
    if (fs.existsSync(path.join(searchPathForFirstPass, 'tailwind.config.js'))) {
      tailwindConfigPath = searchPathForFirstPass;
      break; // Found tailwind.config.js, this is our root.
    }
    const parent = path.dirname(searchPathForFirstPass);
    if (parent === searchPathForFirstPass) break; // Reached filesystem root
    searchPathForFirstPass = parent;
  }

  if (tailwindConfigPath) {
    return { projectRoot: tailwindConfigPath, method: "'tailwind.config.js' presence" };
  }

  // Second pass (if tailwind.config.js not found): Traverse upwards again to find the *highest*
  // occurrences of .git, package.json, .gitignore.
  currentSearchPath = path.resolve(startPath);
  while (true) {
    if (fs.existsSync(path.join(currentSearchPath, '.git'))) highestGitRepoPath = currentSearchPath;
    if (fs.existsSync(path.join(currentSearchPath, 'package.json'))) highestPackageJsonPath = currentSearchPath;
    if (fs.existsSync(path.join(currentSearchPath, '.gitignore'))) highestGitIgnorePath = currentSearchPath;
    const parent = path.dirname(currentSearchPath);
    if (parent === currentSearchPath) break; // Reached filesystem root
    currentSearchPath = parent;
  }

  if (highestGitRepoPath) {
    return { projectRoot: highestGitRepoPath, method: "highest '.git/' folder found" };
  }
  if (highestPackageJsonPath) {
    return { projectRoot: highestPackageJsonPath, method: "highest 'package.json' found" };
  }
  if (highestGitIgnorePath) {
    return { projectRoot: highestGitIgnorePath, method: "highest '.gitignore' file found" };
  }

  // Fallback logic
  const baseNameOfStartDir = path.basename(path.resolve(startPath)).toLowerCase();
  let finalRoot = path.resolve(startPath === __dirname ? path.dirname(__dirname) : startPath); // Prefer parent of script dir or startPath
  let fallbackMethod = `fallback (script's parent directory or start path)`;

  if (['tool-scripts', 'scripts', 'tools', 'utils'].includes(baseNameOfStartDir) && startPath === __dirname) {
     finalRoot = path.resolve(startPath, '..'); // If script is in a common tools subdir, assume parent is root
     fallbackMethod = `fallback (parent of script's directory '${baseNameOfStartDir}')`;
  } else {
     finalRoot = process.cwd(); // Final fallback to current working directory
     fallbackMethod = `fallback (current working directory)`;
  }

  const msg = `[findProjectRoot in ${scriptFileName}] No primary root indicators found. Using ${fallbackMethod}: ${finalRoot}`;
  // Log this debug message even if loggerInstance isn't fully set up yet, if DEBUG is enabled.
  if (loggerInstance) {
    loggerInstance.debug(msg);
  } else if (process.env.DEBUG || (yargs(hideBin(process.argv)).argv.logLevel === 'DEBUG')) {
    console.log(chalk.gray(`[${SCRIPT_PRIMARY_COMMAND}][DEBUG] ${msg}`));
  }

  return { projectRoot: finalRoot, method: fallbackMethod };
}


// --- Configuration Management ---

/**
 * Gets the default configuration object.
 * @param {string} [projectR] - The project root path. If not provided, defaults to `process.cwd()`.
 * @returns {object} The default configuration object.
 */
function getDefaultConfig(projectR) {
  const projectRoot = path.resolve(projectR || process.cwd()); // Ensure projectRoot is absolute
  const defaultLogFileName = `refactor-run-${Date.now()}.log`; // Unique log file name

  return {
    projectRoot: projectRoot,
    htmlSourcePatterns: ['**/*.html'], // Default to scan all HTML files
    stylesOutputDir: DEFAULT_STYLES_OUTPUT_DIR, // Used if cssOutputDirStrategy is 'centralized'
    cssOutputDirStrategy: 'centralized', // 'centralized' or 'relativeToHtml'
    jsOutputDirStrategy: 'relativeToHtml', // 'relativeToHtml' or 'centralized'
    jsCentralOutputDir: 'js/extracted', // Used if jsOutputDirStrategy is 'centralized'
    compiledCssLinkDir: DEFAULT_COMPILED_CSS_LINK_DIR,
    copyToDist: false, // Feature disabled by default
    distDir: 'dist/', // Default distribution directory
    distSourceRoot: 'src/', // The source folder to mirror in dist
    ignorePatterns: [ // Common patterns to ignore by default
        'node_modules/**',
        '**/node_modules/**', // For nested node_modules
        '.git/**',
        'dist/**',
        'build/**',
        '**/output/**', // Generic output folder
        `${DEFAULT_LOG_DIR_NAME}/**`, // Log directory
        CONFIG_FILE_NAME, // The config file itself
        'package.json',
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
    ],
    logLevel: 'INFO', // Default log level
    logFilePath: path.join(projectRoot, DEFAULT_LOG_DIR_NAME, defaultLogFileName),
    createBackups: true, // Create .bak files by default
    maxFilenameLength: 100, // Max length for base part of generated filenames
    htmlPrefixesToOmitFromCssName: ['src/public/', 'public/', 'src/pages/', 'src/'], // For CSS naming
  };
}

/**
 * Loads configuration from a JSON file.
 * @param {string} configPath - Absolute path to the configuration file.
 * @param {string} [cliProjectRoot] - Project root passed via CLI, takes precedence for `projectRoot` field.
 * @returns {Promise<object|null>} The loaded configuration object, or null if loading fails or file doesn't exist.
 */
async function loadConfiguration(configPath, cliProjectRoot) {
  let config = null;
  const tempLogger = loggerInstance || initializeLogger('INFO'); // Use existing or temporary logger

  if (await fs.pathExists(configPath)) {
    try {
      const rawConfig = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(rawConfig);
      tempLogger.info(`Successfully loaded configuration from: ${configPath}`);

      // Prioritize projectRoot: CLI > Config File > Auto-detection
      if (cliProjectRoot) {
        config.projectRoot = path.resolve(cliProjectRoot); // Ensure absolute
      } else if (config.projectRoot) {
        // Resolve path from config relative to the config file's directory if not absolute
        config.projectRoot = path.resolve(path.dirname(configPath), config.projectRoot);
      } else {
        const detectedRoot = findProjectRoot(path.dirname(configPath)); // Detect relative to config file's dir
        config.projectRoot = detectedRoot.projectRoot;
        tempLogger.warn(`Configuration file missing 'projectRoot'. Using detected root: ${config.projectRoot}`);
      }
    } catch (e) {
      tempLogger.error(`Error loading or parsing configuration from ${configPath}: ${e.message}`);
      tempLogger.warn('Proceeding as if no configuration file was found. Interactive setup may be triggered.');
      return null; // Indicate failure to load
    }
  } else {
    tempLogger.debug(`Configuration file not found at: ${configPath}`);
  }
  return config;
}

/**
 * Saves the configuration object to a JSON file.
 * @param {string} configPath - Absolute path to save the configuration file.
 * @param {object} config - The configuration object to save.
 * @returns {Promise<void>}
 */
async function saveConfiguration(configPath, config) {
  try {
    await fs.ensureDir(path.dirname(configPath)); // Ensure directory exists
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8'); // Pretty print JSON
    loggerInstance.success(`Configuration successfully saved to: ${configPath}`);
  } catch (e) {
    loggerInstance.error(`Fatal Error: Could not save configuration to ${configPath}: ${e.message}`);
    // This is a critical error, as subsequent runs might depend on this config.
  }
}

/**
 * Runs an interactive setup to gather configuration from the user.
 * @param {string} currentProjectRoot - The current detected or specified project root.
 * @param {object} [existingConfig=null] - An existing configuration object to pre-fill defaults.
 * @param {boolean} [nonInteractive=false] - If true, skips prompts and uses defaults/existing config.
 * @returns {Promise<object>} The resolved configuration object.
 */
async function interactiveConfigSetup(currentProjectRoot, existingConfig = null, nonInteractive = false) {
  loggerInstance.info(chalk.bold('Starting interactive configuration setup...'));

  const defaults = getDefaultConfig(currentProjectRoot); // Get defaults based on current project root
  // Merge defaults with existing config, ensuring existing values take precedence
  const initialValues = { ...defaults, ...existingConfig };
  initialValues.projectRoot = currentProjectRoot; // Ensure projectRoot is always the passed one for prompts

  // Prepare logFilePath for prompt (relative or just filename if in default dir)
  if (initialValues.logFilePath === path.join(defaults.projectRoot, DEFAULT_LOG_DIR_NAME, path.basename(defaults.logFilePath)) ||
      !path.isAbsolute(initialValues.logFilePath)) {
    initialValues.logFilePathPrompt = path.join(DEFAULT_LOG_DIR_NAME, path.basename(initialValues.logFilePath || `refactor-run-${Date.now()}.log`));
  } else {
    initialValues.logFilePathPrompt = path.relative(initialValues.projectRoot, initialValues.logFilePath);
     if (initialValues.logFilePathPrompt.startsWith('..')) { // If outside project root, keep absolute
        initialValues.logFilePathPrompt = initialValues.logFilePath;
     }
  }


  if (nonInteractive) {
    loggerInstance.info('Non-interactive mode (--yes): Using current defaults or existing/provided config values.');
    const finalConfig = { ...initialValues };
    // Resolve logFilePath based on projectRoot if it's not absolute
    if (!path.isAbsolute(finalConfig.logFilePathPrompt)) {
        finalConfig.logFilePath = path.resolve(finalConfig.projectRoot, finalConfig.logFilePathPrompt);
    } else {
        finalConfig.logFilePath = finalConfig.logFilePathPrompt;
    }
    delete finalConfig.logFilePathPrompt; // Clean up prompt-specific field
    return finalConfig;
  }

  const questions = [
    {
      type: 'input',
      name: 'projectRoot',
      message: 'Confirm project root directory:',
      default: initialValues.projectRoot,
      validate: async (input) => fs.pathExists(input) ? true : 'Path does not exist. Please provide a valid path.',
      filter: async (input) => path.resolve(input), // Ensure it's an absolute path
    },
    {
      type: 'input',
      name: 'htmlSourcePatterns',
      message: 'Enter glob patterns for HTML source files (comma-separated, e.g., src/**/*.html,!src/ignore/**):',
      default: initialValues.htmlSourcePatterns.join(','),
      filter: (input) => input.split(',').map(s => s.trim()).filter(s => s.length > 0),
    },
    {
      type: 'list',
      name: 'cssOutputDirStrategy',
      message: 'How to save extracted CSS source files?',
      choices: [
        { name: 'In a central directory (e.g., styles/extracted)', value: 'centralized' },
        { name: 'Relative to each HTML file (alongside the HTML)', value: 'relativeToHtml' },
      ],
      default: initialValues.cssOutputDirStrategy,
    },
    {
      type: 'input',
      name: 'stylesOutputDir',
      message: 'Central directory for extracted CSS (if chosen, relative to project root):',
      default: initialValues.stylesOutputDir,
      when: (answers) => answers.cssOutputDirStrategy === 'centralized',
    },
    {
      type: 'list',
      name: 'jsOutputDirStrategy',
      message: 'How to save extracted JavaScript files?',
      choices: [
        { name: 'Relative to each HTML file (e.g., alongside the HTML)', value: 'relativeToHtml' },
        { name: 'In a central directory (e.g., assets/js/extracted)', value: 'centralized' },
      ],
      default: initialValues.jsOutputDirStrategy,
    },
    {
      type: 'input',
      name: 'jsCentralOutputDir',
      message: 'Central directory for extracted JS (if chosen, relative to project root):',
      default: initialValues.jsCentralOutputDir,
      when: (answers) => answers.jsOutputDirStrategy === 'centralized',
    },
    {
      type: 'input',
      name: 'compiledCssLinkDir',
      message: 'Directory of *final compiled* CSS for HTML <link> hrefs (relative to project root, e.g., dist/assets/css):',
      default: initialValues.compiledCssLinkDir,
    },
    {
      type: 'input',
      name: 'ignorePatterns',
      message: 'Additional ignore glob patterns (comma-separated, relative to project root):',
      default: initialValues.ignorePatterns.join(','),
      filter: (input) => input.split(',').map(s => s.trim()).filter(s => s.length > 0),
    },
    {
      type: 'list',
      name: 'logLevel',
      message: 'Select log level for console and file output:',
      choices: Object.keys(LOG_LEVELS).filter(l => l !== 'SILENT'), // Exclude SILENT from choice
      default: initialValues.logLevel,
    },
    {
      type: 'input',
      name: 'logFilePathPrompt',
      message: `Path for the log file (default: relative to project root in '${DEFAULT_LOG_DIR_NAME}'; or provide absolute path):`,
      default: initialValues.logFilePathPrompt,
    },
    {
      type: 'confirm',
      name: 'createBackups',
      message: 'Create .bak backups of HTML files before modification?',
      default: initialValues.createBackups,
    },
    {
        type: 'input',
        name: 'htmlPrefixesToOmitFromCssName',
        message: 'HTML path prefixes to omit from generated CSS filenames (comma-separated, order matters):',
        default: initialValues.htmlPrefixesToOmitFromCssName.join(','),
        filter: (input) => input.split(',').map(s => s.trim()).filter(s => s.length > 0),
    },
    {
        type: 'number',
        name: 'maxFilenameLength',
        message: 'Maximum length for generated CSS/JS filename bases (excluding extension/hashes):',
        default: initialValues.maxFilenameLength,
        validate: (input) => (Number.isInteger(input) && input > 10 && input < 200) ? true : 'Must be an integer between 11 and 199.',
    },
    {
        type: 'confirm',
        name: 'copyToDist',
        message: 'Enable copying of refactored HTML and its JS files to a distribution directory (like a build step)?',
        default: initialValues.copyToDist,
    },
    {
        type: 'input',
        name: 'distDir',
        message: 'Distribution directory to copy files to (relative to project root):',
        default: initialValues.distDir,
        when: (answers) => answers.copyToDist,
    },
    {
        type: 'input',
        name: 'distSourceRoot',
        message: 'Base source directory to mirror in the distribution directory (e.g., "src" or "public"):',
        default: initialValues.distSourceRoot,
        when: (answers) => answers.copyToDist,
        validate: (input) => input.trim().length > 0 ? true : 'This value cannot be empty.',
    }
  ];

  const answers = await inquirer.prompt(questions);

  // Resolve projectRoot from answers first, as other paths might be relative to it.
  answers.projectRoot = path.resolve(answers.projectRoot || initialValues.projectRoot);

  // Resolve logFilePath based on the (potentially updated) projectRoot
  if (path.isAbsolute(answers.logFilePathPrompt)) {
    answers.logFilePath = answers.logFilePathPrompt;
  } else {
    // Treat as relative to the final projectRoot
    answers.logFilePath = path.resolve(answers.projectRoot, answers.logFilePathPrompt);
  }
  delete answers.logFilePathPrompt; // Clean up temporary field

  // Merge answers into a new object, ensuring defaults are a fallback.
  const finalConfig = { ...defaults, ...existingConfig, ...answers };
  // Ensure paths that should be relative to projectRoot are stored that way if they were entered as such
  // or convert them if they were absolute but within projectRoot.
  // For simplicity, this example assumes paths like stylesOutputDir are stored as entered (intended relative).
  // More complex logic could normalize them here.

  return finalConfig;
}

// --- Utility Functions ---

/**
 * Generates a unique CSS class name for extracted inline styles.
 * @returns {string} A unique CSS class name (e.g., 'extracted-inline-style-1').
 */
/**
 * Normalizes a CSS style string to ensure consistent ordering of properties for deduplication.
 * @param {string} style - The raw CSS style string (e.g., 'color: blue; font-weight: bold;').
 * @returns {string} A normalized style string (e.g., 'color:blue;font-weight:bold').
 */
function normalizeStyleString(style) {
  if (!style) return '';
  return style
    .split(';')
    .map(s => s.trim())
    .filter(s => s)
    .sort()
    .join(';');
}

/**
 * Generates a unique and deterministic CSS class name from a style string.
 * Uses a hash of the normalized style to ensure the same style always gets the same class.
 * @param {string} normalizedStyle - The normalized style string from normalizeStyleString.
 * @returns {string} A short, unique class name like 'css-a1b2c3d4'.
 */
function generateClassFromStyle(normalizedStyle) {
    const hash = crypto.createHash('sha256').update(normalizedStyle).digest('hex');
    return `css-${hash.substring(0, 8)}`;
}

/**
 * Sanitizes a string to be safe for use as part of a filename.
 * Replaces unsafe characters and collapses multiple underscores.
 * @param {string} str - The string to sanitize.
 * @returns {string} The sanitized string, or an empty string if input is falsy.
 */
function sanitizeStringForFilename(str) {
    if (!str) return '';
    const sanitized = String(str).replace(FILENAME_SANITIZATION_REGEX, FILENAME_SANITIZATION_REPLACEMENT);
    return sanitized.replace(/_+/g, '_'); // Replace multiple underscores with a single one
}

/**
 * Creates a safe base name for a file, truncating and adding a hash if too long.
 * Ensures the name is sanitized.
 * @param {string} originalName - The desired original name (without extension).
 *   This name is expected to be already somewhat processed (e.g. path parts joined).
 * @param {string} context - A context string (e.g., "CSS" or "JS") for logging.
 * @param {object} config - The application configuration object (needed for maxFilenameLength).
 * @returns {string} A safe filename base.
 */
function generateSafeBaseName(originalName, context, config) {
  const sanitizedOriginalName = sanitizeStringForFilename(originalName); // Sanitize first
  const maxLength = config.maxFilenameLength || 100; // Fallback max length

  if (sanitizedOriginalName.length > maxLength) {
    // Use a hash of the *original* unsanitized name for more stable hash generation
    const hash = crypto.createHash('sha256').update(originalName).digest('hex').substring(0, 8);
    const truncateLength = maxLength - hash.length - 1; // -1 for underscore
    // Ensure truncateLength is positive and leaves some original name part
    const actualTruncateLength = Math.max(10, truncateLength > 0 ? truncateLength : 10);
    const truncatedName = sanitizedOriginalName.substring(0, actualTruncateLength);

    const newName = `${truncatedName}_${hash}`;
    loggerInstance.warn(`[Util][${context}] Original filename base "${sanitizedOriginalName}" (${sanitizedOriginalName.length} chars) was too long (max: ${maxLength}). Shortened to "${newName}" (${newName.length} chars).`);
    return newName;
  }
  return sanitizedOriginalName;
}

/**
 * Generates a CSS file base name (e.g., 'Home' or 'subdir_Page') from an HTML file path.
 * Uses path parts for subdirectories and applies configured prefix omissions.
 * @param {string} htmlFilePath - Absolute path to the HTML file.
 * @param {object} config - The application configuration object.
 * @returns {string} The generated and sanitized CSS file base name.
 */
function generateCssFileBaseName(htmlFilePath, config) {
  // Get path relative to project root
  let relativeHtmlPath = path.relative(config.projectRoot, htmlFilePath);
  relativeHtmlPath = relativeHtmlPath.replace(/\\/g, '/'); // Normalize to forward slashes

  let effectivePathForNaming = relativeHtmlPath;
  // Normalize prefixes from config for comparison
  const prefixesToOmit = (config.htmlPrefixesToOmitFromCssName || []).map(p => String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));


  for (const prefixToOmit of prefixesToOmit) {
    if (effectivePathForNaming.startsWith(prefixToOmit + '/')) { // Ensure it's a directory prefix
      effectivePathForNaming = effectivePathForNaming.substring((prefixToOmit + '/').length);
      loggerInstance.debug(`Stripped prefix "${prefixToOmit}/" for CSS name generation. Effective path: "${effectivePathForNaming}"`);
      break; // Typically, only strip the first matching most-specific prefix
    }
  }

  const htmlFileBasePart = path.basename(effectivePathForNaming, '.html');
  const htmlFileDirPart = path.dirname(effectivePathForNaming);

  let cssFileBaseCandidate;
  if (htmlFileDirPart && htmlFileDirPart !== '.') {
    const dirPrefix = htmlFileDirPart.replace(/[/\\]/g, '_'); // Replace slashes with underscores
    cssFileBaseCandidate = `${dirPrefix}_${htmlFileBasePart}`;
  } else {
    cssFileBaseCandidate = htmlFileBasePart;
  }

  // Sanitization and length check/hashing is handled by generateSafeBaseName
  return generateSafeBaseName(cssFileBaseCandidate, 'CSS', config);
}

// --- Core HTML Processing Logic ---

/**
 * Extracts CSS from <style> tags and inline 'style' attributes in the HTML content.
 * Modifies the Cheerio object ($) by removing processed tags/attributes.
 * @param {object} $ - The Cheerio object representing the loaded HTML.
 * @param {string} htmlFilePath - Path to the HTML file (for logging context).
 * @param {string} htmlFileBaseName - Base name of the HTML file (for logging context).
 * @returns {Promise<{cssContent: string, cssModified: boolean}>}
 *          An object containing the extracted CSS content and a flag indicating if HTML was modified.
 */
async function extractCssFromHtml($, htmlFilePath, htmlFileBaseName) {
  let allExtractedCss = '';
  let cssModifiedInHtml = false;
  const styleMap = new Map(); // To track unique styles and their generated classes

  // 1. Extract from <style> tags (these are not deduplicated, as they are presumed to be unique blocks)
  $('style').each((index, element) => {
    const $styleTag = $(element);
    const styleContent = $styleTag.html();
    if (styleContent && styleContent.trim() !== '') {
      allExtractedCss += `\n/* Extracted from <style> tag in ${htmlFileBaseName}.html (index ${index}) */\n${styleContent.trim()}\n`;
      $styleTag.remove();
      cssModifiedInHtml = true;
      loggerInstance.debug(`Extracted and removed <style> tag content from ${htmlFileBaseName}.html.`);
    }
  });

  // 2. Extract and deduplicate from style attributes
  $('[style]').each((index, element) => {
    const $element = $(element);
    const rawStyle = $element.attr('style');
    if (!rawStyle || !rawStyle.trim()) return;

    const normalizedStyle = normalizeStyleString(rawStyle);
    let className;

    if (styleMap.has(normalizedStyle)) {
      // This exact style has been seen before, reuse the class.
      className = styleMap.get(normalizedStyle);
      loggerInstance.debug(`Reusing class '${className}' for identical style.`);
    } else {
      // This is a new, unique style.
      className = generateClassFromStyle(normalizedStyle);
      styleMap.set(normalizedStyle, className);

      // Add the new rule to our collected CSS
      const styleRule = normalizedStyle.replace(/;/g, ';\n  '); // Pretty print
      allExtractedCss += `\n/* Style for .${className} from ${htmlFileBaseName}.html */\n.${className} {\n  ${styleRule}\n}\n`;
    }

    $element.addClass(className);
    $element.removeAttr('style');
    cssModifiedInHtml = true;
  });

  return { cssContent: allExtractedCss.trim(), cssModified: cssModifiedInHtml };
}

/**
 * Saves extracted CSS content to a file. Appends if file exists and content is new.
 * @param {string} cssContent - The CSS content to save.
 * @param {string} cssFileBaseName - The base name for the CSS file (e.g., 'Page_Home').
 * @param {string} htmlFilePath - Path to the original HTML file (for context).
 * @param {object} config - The application configuration object.
 * @param {boolean} isDryRun - If true, simulates saving without actual file modification.
 * @returns {Promise<string|null>} Full path to the saved/target CSS file, or null on failure or if no content.
 */
async function saveCssFile(cssContent, cssFileBaseName, htmlFilePath, config, isDryRun) {
  if (!cssContent || cssContent.trim() === '') {
    loggerInstance.debug('No CSS content provided to saveCssFile.');
    return null;
  }

  const newCssFileName = `${cssFileBaseName}.css`;
  let newCssFileFullPath;

  if (config.cssOutputDirStrategy === 'relativeToHtml') {
    newCssFileFullPath = path.join(path.dirname(htmlFilePath), newCssFileName);
  } else { // 'centralized'
    const stylesDirFullPath = path.resolve(config.projectRoot, config.stylesOutputDir);
    newCssFileFullPath = path.join(stylesDirFullPath, newCssFileName);
  }

  const relativeNewCssPath = path.relative(config.projectRoot, newCssFileFullPath).replace(/\\/g, '/');
  loggerInstance.debug(`Target CSS file path for extracted styles: ${relativeNewCssPath}`);

  if (isDryRun) {
    loggerInstance.info(`[DRY RUN] Would attempt to save/append CSS for ${path.basename(htmlFilePath)} to: ${relativeNewCssPath}`);
    if (await fs.pathExists(newCssFileFullPath)) {
        const existingContent = await fs.readFile(newCssFileFullPath, 'utf-8');
        if (existingContent.includes(cssContent)) {
             loggerInstance.info(`[DRY RUN] Content appears to already exist in ${relativeNewCssPath}. Would skip append.`);
        } else if (existingContent.trim() !== '') {
             loggerInstance.info(`[DRY RUN] Would append new styles to existing file: ${relativeNewCssPath}`);
        }
    } else {
        loggerInstance.info(`[DRY RUN] Would create new CSS file: ${relativeNewCssPath}`);
    }
    return newCssFileFullPath; // Return path for subsequent dry run steps (e.g., linking)
  }

  try {
    await fs.ensureDir(path.dirname(newCssFileFullPath)); // Ensure directory exists
    let existingCssContent = '';
    let writeNeeded = true;

    if (await fs.pathExists(newCssFileFullPath)) {
      existingCssContent = await fs.readFile(newCssFileFullPath, 'utf-8');
      if (existingCssContent.includes(cssContent)) { // Basic check for duplication
         loggerInstance.info(`Content already exists in ${relativeNewCssPath}. Skipping append.`);
         writeNeeded = false; // No need to write
      } else if (existingCssContent.trim() !== '') {
        loggerInstance.info(`Appending new styles from ${path.basename(htmlFilePath)} to existing CSS file: ${relativeNewCssPath}`);
        existingCssContent += '\n\n/* --- Appended styles from HTML Refactor --- */\n'; // Add separator
      }
    }

    if (writeNeeded) {
        // Concatenate existing (potentially with separator) and new content
        const finalContentToWrite = (existingCssContent.endsWith('\n\n/* --- Appended styles from HTML Refactor --- */\n') ? existingCssContent : existingCssContent + (existingCssContent ? '\n' : '')) + cssContent;
        await fs.writeFile(newCssFileFullPath, finalContentToWrite);
        loggerInstance.success(`Successfully saved/appended extracted CSS to: ${relativeNewCssPath}`);
    }
    return newCssFileFullPath;
  } catch (error) {
    loggerInstance.error(`Failed to save CSS file ${relativeNewCssPath}: ${error.message}`);
    loggerInstance.debug(error.stack);
    return null;
  }
}

/**
 * Adds a <link> tag for the specified CSS file to the HTML document's <head>.
 * Does not add if a link to the same href already exists.
 * @param {object} $ - The Cheerio object representing the loaded HTML.
 * @param {string} htmlFilePath - Absolute path to the HTML file.
 * @param {string} cssFileBaseName - The base name of the CSS file to link (e.g., 'Page_Home').
 * @param {object} config - The application configuration object.
 * @returns {boolean} True if a new link was added, false otherwise.
 */
function addCssLinkToHtmlHead($, htmlFilePath, cssFileBaseName, config) {
  // The CSS file to link is the one in the *compiled* CSS directory, not the extracted source.
  // The name remains the same (cssFileBaseName.css).
  const targetCssFileName = `${cssFileBaseName}.css`;
  const htmlFileDir = path.dirname(htmlFilePath); // Absolute directory of the HTML file

  // Absolute path to where the *final, compiled* CSS file is expected to be
  const compiledCssDirAbsolute = path.resolve(config.projectRoot, config.compiledCssLinkDir);
  const targetCssFileInFinalOutputAbsolute = path.join(compiledCssDirAbsolute, targetCssFileName);

  // Calculate the relative path from the HTML file's location to this final CSS file
  let relativeLinkPathFromHtml = path.relative(htmlFileDir, targetCssFileInFinalOutputAbsolute);
  relativeLinkPathFromHtml = relativeLinkPathFromHtml.replace(/\\/g, '/'); // Normalize to web-friendly slashes

  let linkAlreadyExists = false;
  $('head link[rel="stylesheet"]').each((i, elLink) => {
    const existingHref = $(elLink).attr('href');
    if (existingHref && existingHref.replace(/\\/g, '/') === relativeLinkPathFromHtml) {
      linkAlreadyExists = true;
      return false; // Break Cheerio's .each loop
    }
  });

  if (!linkAlreadyExists) {
    if ($('head').length === 0) {
      // Prepend a <head> if it doesn't exist (though highly unlikely for valid HTML)
      $.root().prepend('<head></head>');
      loggerInstance.debug(`Created <head> in ${path.basename(htmlFilePath)} as it was missing.`);
    }
    // Append the new link tag. Consider prepending if this CSS should have lower precedence.
    $('head').append(`\n    <link rel="stylesheet" href="${relativeLinkPathFromHtml}">\n  `);
    return true; // Link was added
  }
  loggerInstance.debug(`Link to "${relativeLinkPathFromHtml}" already exists in ${path.basename(htmlFilePath)}. Skipped adding duplicate.`);
  return false; // Link was not added (already existed)
}

/**
 * Extracts inline JavaScript from <script> tags into separate .js files.
 * Modifies the Cheerio object ($) by setting the 'src' attribute on processed script tags.
 * @param {object} $ - The Cheerio object representing the loaded HTML.
 * @param {string} htmlFilePath - Absolute path to the HTML file.
 * @param {string} htmlFileBaseName - Sanitized base name of the HTML file (for naming JS files).
 * @param {object} config - The application configuration object.
 * @param {boolean} isDryRun - If true, simulates extraction without actual file modification.
 * @returns {Promise<{jsModifiedInHtml: boolean, extractedJsFiles: Array<{sourcePath: string, content: string}>}>}
 *          An object containing a flag if the HTML was modified and an array of objects for each extracted JS file.
 */
async function extractJsFromHtml($, htmlFilePath, htmlFileBaseName, config, isDryRun) {
  let jsModifiedInHtml = false;
  const extractedJsFiles = []; // To hold data about extracted files for the caller
  const scriptTagsToProcess = [];

  // Collect script tags with inline content
  $('script').each((index, element) => {
    const $scriptTag = $(element);
    // Process only if no 'src' attribute and has non-empty inline content
    if (!$scriptTag.attr('src') && $scriptTag.html() && $scriptTag.html().trim() !== '') {
      scriptTagsToProcess.push({ tag: $scriptTag, originalIndex: index }); // Store original index for stable naming
    }
  });

  if (scriptTagsToProcess.length === 0) {
    return { jsModifiedInHtml: false, extractedJsFiles: [] }; // No inline scripts to extract
  }

  // Use the pre-sanitized htmlFileBaseName for JS file generation
  const safeJsFileBase = generateSafeBaseName(htmlFileBaseName, 'JS', config);

  for (let i = 0; i < scriptTagsToProcess.length; i++) {
    const item = scriptTagsToProcess[i];
    const $scriptTag = item.tag;
    const scriptContent = $scriptTag.html().trim();
    // Suffix for multiple scripts from the same HTML file, using original index for stability
    const suffix = scriptTagsToProcess.length > 1 ? `_s${item.originalIndex + 1}` : '';
    let jsFileNameBase = `${safeJsFileBase}${suffix}`;
    let jsFileNameForSrcAttr = `${jsFileNameBase}.js`;

    let jsFileFullPath;
    let relativeJsFilePathForLogging; // Path relative to project root, for logging

    // Determine output path based on strategy
    if (config.jsOutputDirStrategy === 'centralized') {
      const centralJsDir = path.resolve(config.projectRoot, config.jsCentralOutputDir);
      jsFileFullPath = path.join(centralJsDir, jsFileNameForSrcAttr);
      relativeJsFilePathForLogging = path.join(config.jsCentralOutputDir, jsFileNameForSrcAttr);
    } else { // 'relativeToHtml'
      jsFileFullPath = path.join(path.dirname(htmlFilePath), jsFileNameForSrcAttr);
      relativeJsFilePathForLogging = path.relative(config.projectRoot, jsFileFullPath);
    }
    relativeJsFilePathForLogging = relativeJsFilePathForLogging.replace(/\\/g, '/');

    // Add file info for the caller, regardless of dry run or not.
    // This helps in dry run logging and actual copy operations later.
    const jsFileData = { sourcePath: jsFileFullPath, content: scriptContent };
    extractedJsFiles.push(jsFileData);


    if (isDryRun) {
      let srcDryRunPath = jsFileNameForSrcAttr; // Default for relativeToHtml
      if (config.jsOutputDirStrategy === 'centralized') {
        // Calculate src path relative from HTML file to the central JS file
        srcDryRunPath = path.relative(path.dirname(htmlFilePath), jsFileFullPath).replace(/\\/g, '/');
      }
      loggerInstance.info(`[DRY RUN] Would extract inline script to: ${relativeJsFilePathForLogging}`);
      loggerInstance.info(`[DRY RUN] Would update <script> tag in ${path.basename(htmlFilePath)} to src="${srcDryRunPath}"`);
      jsModifiedInHtml = true;
      continue; // Move to next script tag in dry run
    }

    try {
      // Handle potential filename conflicts
      if (await fs.pathExists(jsFileFullPath)) {
        const timestamp = Date.now();
        const conflictFileNameBase = `${jsFileNameBase}-conflict-${timestamp}`;
        jsFileNameForSrcAttr = `${conflictFileNameBase}.js`; // Update filename for src attribute

        if (config.jsOutputDirStrategy === 'centralized') {
             jsFileFullPath = path.join(path.resolve(config.projectRoot, config.jsCentralOutputDir), jsFileNameForSrcAttr);
             relativeJsFilePathForLogging = path.join(config.jsCentralOutputDir, jsFileNameForSrcAttr);
        } else {
            jsFileFullPath = path.join(path.dirname(htmlFilePath), jsFileNameForSrcAttr);
            relativeJsFilePathForLogging = path.relative(config.projectRoot, jsFileFullPath);
        }
        relativeJsFilePathForLogging = relativeJsFilePathForLogging.replace(/\\/g, '/');
        loggerInstance.warn(`JS file for script in ${path.basename(htmlFilePath)} already existed. Saving new script to unique file: ${relativeJsFilePathForLogging}`);
        // Update the path in the object we're tracking
        jsFileData.sourcePath = jsFileFullPath;
      }

      await fs.ensureDir(path.dirname(jsFileFullPath)); // Ensure directory exists
      await fs.writeFile(jsFileFullPath, scriptContent);
      loggerInstance.success(`Successfully extracted inline script to: ${relativeJsFilePathForLogging}`);

      $scriptTag.html(''); // Remove inline content

      // Determine the correct 'src' attribute value relative to the HTML file
      let srcAttrPath = jsFileNameForSrcAttr; // Default for 'relativeToHtml'
      if (config.jsOutputDirStrategy === 'centralized') {
        srcAttrPath = path.relative(path.dirname(htmlFilePath), jsFileFullPath);
      }
      srcAttrPath = srcAttrPath.replace(/\\/g, '/'); // Ensure web-friendly slashes

      $scriptTag.attr('src', srcAttrPath);
      jsModifiedInHtml = true;

    } catch (error) {
      loggerInstance.error(`Failed to save or update JS file ${relativeJsFilePathForLogging}: ${error.message}`);
      loggerInstance.debug(error.stack);
      // Remove the failed file from our list of extracted files
      const failedIndex = extractedJsFiles.findIndex(f => f.sourcePath === jsFileFullPath);
      if (failedIndex > -1) extractedJsFiles.splice(failedIndex, 1);
      // Continue to the next script if one fails
    }
  }
  return { jsModifiedInHtml, extractedJsFiles };
}

/**
 * Processes a single HTML file: extracts CSS and JS, updates links, and saves changes.
 * @param {string} htmlFilePath - Absolute path to the HTML file to process.
 * @param {object} config - The application configuration object.
 * @param {boolean} isDryRun - If true, simulates processing without actual file modifications.
 * @returns {Promise<boolean>} True if the HTML file was (or would be) modified, false otherwise.
 */
async function processHtmlFile(htmlFilePath, config, isDryRun) {
  const htmlFileRawBaseName = path.basename(htmlFilePath, '.html'); // Original base for context
  const relativeHtmlPath = path.relative(config.projectRoot, htmlFilePath).replace(/\\/g, '/');
  loggerInstance.info(`Processing HTML file: ${relativeHtmlPath}`);

  let initialHtmlContent = '';
  try {
    initialHtmlContent = await fs.readFile(htmlFilePath, 'utf-8');
    const $ = cheerio.load(initialHtmlContent, {
      decodeEntities: false, // Keep entities like &nbsp; as is
      xmlMode: false,        // Use HTML parsing mode
    });

    // Extract CSS from <style> tags and style attributes
    const { cssContent, cssModified: styleTagsAndAttrsRemoved } = await extractCssFromHtml($, htmlFilePath, htmlFileRawBaseName);
    let newCssLinkAdded = false;

    if (styleTagsAndAttrsRemoved || cssContent) { // If HTML was changed by CSS extraction OR if there's CSS content to save
      const cssFileBase = generateCssFileBaseName(htmlFilePath, config); // e.g., Home or subdir_Page_Home
      const savedCssPath = await saveCssFile(cssContent, cssFileBase, htmlFilePath, config, isDryRun);

      if (savedCssPath) { // If CSS was actually saved or would be saved (dry run)
        // Attempt to add/verify the CSS link in the HTML head
        const linkStatus = addCssLinkToHtmlHead($, htmlFilePath, cssFileBase, config);
        if (linkStatus) { // True if a *new* link was added
            newCssLinkAdded = true;
            const msg = `Link for ${cssFileBase}.css ${isDryRun ? 'would be added to' : 'added to'} ${relativeHtmlPath}.`;
            isDryRun ? loggerInstance.info(`[DRY RUN] ${msg}`) : loggerInstance.info(msg);
        } else {
            loggerInstance.debug(`Link for ${cssFileBase}.css already exists or was not added in ${relativeHtmlPath}.`);
        }
      }
    }

    // Extract JS from inline <script> tags
    const sanitizedHtmlBaseForJs = sanitizeStringForFilename(htmlFileRawBaseName); // Sanitize once for JS naming
    const { jsModifiedInHtml, extractedJsFiles } = await extractJsFromHtml($, htmlFilePath, sanitizedHtmlBaseForJs, config, isDryRun);

    // Determine if any effective change occurred that requires saving the HTML
    const effectiveChangeMade = styleTagsAndAttrsRemoved || jsModifiedInHtml || newCssLinkAdded;
    let fileWasModified = false;

    if (effectiveChangeMade) {
      const finalHtmlContent = $.html(); // Get the modified HTML content

      if (isDryRun) {
        loggerInstance.info(`[DRY RUN] HTML file ${relativeHtmlPath} would be modified due to extracted content or new links.`);
        fileWasModified = true; // Indicates a change would occur
      } else {
        // Only write if the content has actually changed to avoid unnecessary file writes
        if (finalHtmlContent !== initialHtmlContent) {
          if (config.createBackups) {
            const backupPath = `${htmlFilePath}.bak`;
            const relativeBackupPath = path.relative(config.projectRoot, backupPath).replace(/\\/g, '/');
            loggerInstance.debug(`Creating backup: ${relativeBackupPath}`);
            await fs.copyFile(htmlFilePath, backupPath); // Create backup
          }
          await fs.writeFile(htmlFilePath, finalHtmlContent, 'utf-8');
          loggerInstance.success(`Successfully updated and saved changes to: ${relativeHtmlPath}`);
          fileWasModified = true; // File was modified
        } else {
          loggerInstance.info(`No effective content changes to write for ${relativeHtmlPath} (content identical after processing).`);
        }
      }

      // --- New "Copy to Dist" Logic ---
      if (config.copyToDist) {
        const distSourceRootAbsolute = path.resolve(config.projectRoot, config.distSourceRoot);
        const distDirAbsolute = path.resolve(config.projectRoot, config.distDir);

        // 1. Handle the HTML file
        const htmlDestPath = path.join(distDirAbsolute, path.relative(distSourceRootAbsolute, htmlFilePath));
        const htmlDestPathRelative = path.relative(config.projectRoot, htmlDestPath).replace(/\\/g, '/');

        if (isDryRun) {
            loggerInstance.info(`[DRY RUN] Would copy modified HTML to: ${htmlDestPathRelative}`);
        } else {
            try {
                await fs.ensureDir(path.dirname(htmlDestPath));
                await fs.writeFile(htmlDestPath, finalHtmlContent, 'utf-8');
                loggerInstance.info(`Copied modified HTML to: ${htmlDestPathRelative}`);
            } catch (e) {
                loggerInstance.error(`Failed to copy HTML to dist directory ${htmlDestPathRelative}: ${e.message}`);
            }
        }

        // 2. Handle the extracted JS files
        for (const jsFile of extractedJsFiles) {
            const jsDestPath = path.join(distDirAbsolute, path.relative(distSourceRootAbsolute, jsFile.sourcePath));
            const jsDestPathRelative = path.relative(config.projectRoot, jsDestPath).replace(/\\/g, '/');
             if (isDryRun) {
                loggerInstance.info(`[DRY RUN] Would copy extracted JS to: ${jsDestPathRelative}`);
            } else {
                try {
                    await fs.copy(jsFile.sourcePath, jsDestPath);
                    loggerInstance.info(`Copied extracted JS to: ${jsDestPathRelative}`);
                } catch(e) {
                    loggerInstance.error(`Failed to copy JS file to dist ${jsDestPathRelative}: ${e.message}`);
                }
            }
        }
      }
      return fileWasModified;
    }

    loggerInstance.info(`No inline CSS/JS extracted, or no HTML modifications needed for: ${relativeHtmlPath}.`);
    return false; // No modifications

  } catch (error) {
    loggerInstance.error(`Error processing file ${relativeHtmlPath}: ${error.message}`);
    loggerInstance.debug(error.stack); // Log full stack trace for debugging
    return false; // Indicate failure for this file
  }
}

// --- Main Process Runner ---

/**
 * Runs the entire refactoring process based on the provided configuration.
 * @param {object} config - The application configuration object.
 * @param {boolean} isDryRun - If true, simulates the process without actual file modifications.
 * @returns {Promise<void>}
 */
async function runRefactorProcess(config, isDryRun) {
  loggerInstance.info(chalk.bold('🚀 Starting HTML Refactoring Process...'));
  if (isDryRun) {
    loggerInstance.warn(chalk.bold.yellow('🚧 DRY RUN MODE ENABLED: No files will be modified. 🚧'));
  }

  // Ensure output directories exist (or log if dry run)
  if (config.cssOutputDirStrategy === 'centralized' && !isDryRun) {
    const stylesDirFullPath = path.resolve(config.projectRoot, config.stylesOutputDir);
    try {
        await fs.ensureDir(stylesDirFullPath);
        loggerInstance.info(`Centralized styles output directory ensured at: ${path.relative(config.projectRoot, stylesDirFullPath)}`);
    } catch(e) {
        loggerInstance.error(`Failed to create centralized styles output directory: ${e.message}`);
    }
  }

  // Ensure dist directory exists if feature is enabled
  if (config.copyToDist && !isDryRun) {
    const distDirFullPath = path.resolve(config.projectRoot, config.distDir);
    try {
        await fs.ensureDir(distDirFullPath);
        loggerInstance.info(`Distribution directory ensured at: ${path.relative(config.projectRoot, distDirFullPath)}`);
    } catch (e) {
        loggerInstance.error(`Failed to create distribution directory: ${e.message}`);
    }
  }

  if (config.jsOutputDirStrategy === 'centralized' && !isDryRun) {
    const centralJsDir = path.resolve(config.projectRoot, config.jsCentralOutputDir);
     try {
        await fs.ensureDir(centralJsDir);
        loggerInstance.info(`Centralized JS output directory ensured at: ${path.relative(config.projectRoot, centralJsDir)}`);
    } catch (e) {
        loggerInstance.error(`Failed to create centralized JS output directory: ${e.message}.`);
    }
  }

  // Configure glob options
  const globOptions = {
    cwd: config.projectRoot, // Run glob from project root
    nodir: true,             // Exclude directories from results
    dot: false,              // Ignore dotfiles by default (can be overridden by pattern)
    ignore: config.ignorePatterns ? config.ignorePatterns.map(p => String(p).replace(/\\/g, '/')) : [],
    absolute: true,          // Return absolute file paths
  };

  loggerInstance.info(`Scanning for HTML files in project root: ${config.projectRoot}`);
  loggerInstance.debug(`Using HTML source patterns: ${config.htmlSourcePatterns.join(', ')}`);
  loggerInstance.debug(`Using global ignore patterns: ${globOptions.ignore.join(', ')}`);

  let filesToProcess = [];
  try {
    for (const pattern of config.htmlSourcePatterns) {
        const normalizedPattern = String(pattern).replace(/\\/g, '/'); // Normalize pattern
        const foundFiles = await glob(normalizedPattern, globOptions);
        filesToProcess.push(...foundFiles);
    }
    filesToProcess = [...new Set(filesToProcess)]; // Remove duplicates if patterns overlap
  } catch (globError) {
      loggerInstance.error(`Critical error during HTML file discovery (globbing): ${globError.message}`);
      loggerInstance.debug(globError.stack);
      return; // Stop process if file discovery fails
  }

  loggerInstance.info(`Found ${filesToProcess.length} HTML file(s) matching source patterns.`);
  if (loggerInstance.getLogLevel() <= LOG_LEVELS.DEBUG && filesToProcess.length > 0) {
      loggerInstance.debug('Files to be processed (relative paths):', filesToProcess.map(f => path.relative(config.projectRoot,f).replace(/\\/g, '/')).join('; '));
  }

  if (filesToProcess.length === 0) {
    loggerInstance.info("No HTML files found matching the configured source patterns and ignore rules. Nothing to process.");
  }

  let processedFileCount = 0;
  let changedFileCount = 0;

  for (const htmlFilePath of filesToProcess) {
    processedFileCount++;
    if (await processHtmlFile(htmlFilePath, config, isDryRun)) {
      changedFileCount++;
    }
  }

  loggerInstance.info(chalk.bold('🏁 HTML Refactoring Process Complete.'));
  loggerInstance.info(`   - ${processedFileCount} HTML file(s) were scanned.`);
  if (changedFileCount > 0) {
    loggerInstance.success(`   - ${changedFileCount} HTML file(s) were ${isDryRun ? 'identified for modification' : 'modified'}.`);
    if (!isDryRun) {
        loggerInstance.warn(chalk.yellow(`   💡 IMPORTANT: If you use a CSS build process (e.g., Tailwind, PostCSS, Sass),`));
        loggerInstance.warn(chalk.yellow(`     remember to run it now. It should be configured to process files from`));
        loggerInstance.warn(chalk.yellow(`     '${config.stylesOutputDir}' and output to your compiled CSS directory.`));
    }
  } else if (processedFileCount > 0) {
    loggerInstance.info(`   - No HTML files required ${isDryRun ? 'identification for modification' : 'modification'}.`);
  }

  if (!isDryRun) {
      loggerInstance.info('   Next Steps:');
      loggerInstance.info('     1. Review all file changes (e.g., using `git diff`).');
      loggerInstance.info('     2. Test your website/application thoroughly to ensure everything works as expected.');
  } else {
      loggerInstance.info(chalk.yellow.bold('   🚧 DRY RUN COMPLETED: No actual changes were made to your files. 🚧'));
  }
}

// --- Main CLI Function ---

/**
 * Main function to handle CLI arguments, configuration, and orchestrate the refactoring process.
 * This is the entry point when the script is run from the command line.
 * @returns {Promise<void>}
 */
async function cli() {
  // Preliminary argument parsing for early log level/project root setup, before full yargs config.
  // This allows --log-level to affect early messages like project root detection.
  const preliminaryArgv = yargs(hideBin(process.argv))
    .option('log-level', { string: true, hidden: true }) // Not shown in help, for pre-init
    .option('project-root', { string: true, hidden: true })
    .help(false).version(false) // Disable help/version for this preliminary parse
    .parseSync(); // Synchronous parse for immediate use

  // Initialize logger early, using CLI arg if present, otherwise default 'INFO' and no file path yet.
  initializeLogger(preliminaryArgv.logLevel || 'INFO', null);

  const argv = await yargs(hideBin(process.argv))
    .scriptName(SCRIPT_PRIMARY_COMMAND)
    .usage(`Usage: $0 [options] (CLI aliases: href, htref)`)
    .command('$0', 'Refactor HTML files: extract inline styles & scripts, update links.', (yargs) => {
        yargs.option('dry-run', {
            alias: 'd',
            type: 'boolean',
            description: 'Simulate the refactoring process without modifying any files.',
            default: false,
        });
    }, async (args) => {
        let projectRoot = args.projectRoot ? path.resolve(args.projectRoot) : null;
        let rootDetectionMethod = 'CLI argument';

        if (!projectRoot) {
            const detected = findProjectRoot(__dirname); // Detect from script's dir
            projectRoot = detected.projectRoot;
            rootDetectionMethod = detected.method;
        }
        loggerInstance.info(`Project root determined by ${rootDetectionMethod}: ${projectRoot}`);

        const configFilePath = path.resolve(projectRoot, CONFIG_FILE_NAME);
        let config = await loadConfiguration(configFilePath, projectRoot); // Load config, giving CLI projectRoot precedence

        if (args.init || !config) { // Force setup if --init or no valid config
            if (!config && fs.existsSync(configFilePath)) {
                 loggerInstance.warn(`Configuration file at ${configFilePath} was found but could not be loaded or parsed correctly.`);
            } else if (!config) {
                 loggerInstance.info(`No configuration file found at ${configFilePath}. Starting setup...`);
            }
            if (args.init) {
                loggerInstance.info(`'--init' specified. Starting interactive configuration setup (will overwrite if exists).`);
            }
            config = await interactiveConfigSetup(projectRoot, config, args.yes); // Run interactive setup
            await saveConfiguration(configFilePath, config); // Save the (newly) created/updated config
        } else {
            // Config loaded successfully, ensure projectRoot in config is absolute and used
            projectRoot = path.resolve(config.projectRoot); // Might have been updated by loadConfiguration
            loggerInstance.info(`Using configuration loaded from: ${configFilePath}`);
        }

        // Re-initialize logger with final log level and path from config (or CLI overrides)
        // This ensures file logging starts correctly if path was determined during setup.
        if (loggerInstance && typeof loggerInstance.close === 'function') loggerInstance.close();
        const finalLogLevel = args.logLevel || config.logLevel || 'INFO';
        const finalLogPath = config.logFilePath; // Already resolved in config setup/loading
        initializeLogger(finalLogLevel, finalLogPath);

        loggerInstance.info(`Effective project root: ${projectRoot}`);
        loggerInstance.info(`Effective log level: ${finalLogLevel}. Logging to: ${finalLogPath || 'Console only'}`);


        // Apply CLI overrides to the loaded/created config
        if (args.htmlSources) config.htmlSourcePatterns = String(args.htmlSources).split(',').map(s => s.trim()).filter(s => s);
        if (args.stylesOutput) config.stylesOutputDir = args.stylesOutput;
        if (args.jsStrategy) config.jsOutputDirStrategy = args.jsStrategy;
        if (args.jsCentralOutput && config.jsOutputDirStrategy === 'centralized') config.jsCentralOutputDir = args.jsCentralOutput;
        if (args.compiledCssDir) config.compiledCssLinkDir = args.compiledCssDir;
        if (args.createBackups !== undefined) config.createBackups = args.createBackups; // Handle boolean override

        // Final validation of critical config paths (stylesOutputDir, compiledCssLinkDir)
        // Future: Could add more validation here for other config options.

        await runRefactorProcess(config, args.dryRun);
    })
    .command('build', 'Run the full production build process.', () => {}, (argv) => {
        const { buildProduction } = require('./build-prod.js');
        buildProduction();
    })
    .command('dev', 'Start the development watcher.', () => {}, (argv) => {
        const { startDevWatcher } = require('./auto-dev.js');
        startDevWatcher();
    })
    .command('css', 'Run only the CSS build process.', () => {}, (argv) => {
        const { buildCss } = require('./build-css.js');
        buildCss();
    })
    .option('init', {
      alias: 'i',
      type: 'boolean',
      description: `Force interactive configuration setup. Creates/overwrites ${CONFIG_FILE_NAME}.`,
      default: false,
    })
    .option('project-root', {
      alias: 'r',
      type: 'string',
      description: 'Specify the project root directory. Overrides auto-detection and config file value.',
      coerce: p => path.resolve(p), // Ensure it's made absolute if provided
    })
    .option('log-level', {
      alias: 'l',
      type: 'string',
      description: 'Set log level for console and file output (DEBUG, INFO, WARN, ERROR, SILENT). Overrides config.',
      choices: Object.keys(LOG_LEVELS),
    })
    .option('html-sources', {
        type: 'string',
        description: 'Comma-separated glob patterns for HTML source files (e.g., "src/**/*.html"). Overrides config.',
    })
    .option('styles-output', {
        type: 'string',
        description: `Directory for extracted CSS files (relative to project root, e.g., "${DEFAULT_STYLES_OUTPUT_DIR}"). Overrides config.`
    })
    .option('js-strategy', {
        type: 'string',
        description: 'JavaScript output strategy ("relativeToHtml" or "centralized"). Overrides config.',
        choices: ['relativeToHtml', 'centralized']
    })
    .option('js-central-output', {
        type: 'string',
        description: 'Central directory for extracted JS if strategy is "centralized" (relative to project root). Overrides config.'
    })
    .option('compiled-css-dir', {
        type: 'string',
        description: `Directory of final compiled CSS for HTML links (relative to project root, e.g., "${DEFAULT_COMPILED_CSS_LINK_DIR}"). Overrides config.`
    })
    .option('create-backups', {
        type: 'boolean',
        description: 'Create .bak backups of HTML files before modification. Overrides config setting.'
        // No default here; allows undefined to mean "use config value"
    })
    .option('yes', {
      alias: 'y',
      type: 'boolean',
      description: 'Skip interactive prompts during setup; use defaults or existing config values. Useful for automation.',
      default: false,
    })
    .help('h')
    .alias('h', 'help')
    .version() // Reads version from package.json if available, or yargs generates one.
    .alias('v', 'version')
    .epilogue(
        chalk.dim(
        `Author: Ruthvik Upputuri\n` +
        `License: MIT\n` +
        `Repository: https://github.com/RuthvikUpputuri/html-refactor\n\n` +
        `For more information, detailed configuration options, and examples, please refer to the README.md or the project repository.`
        )
    )
    .demandCommand(0, 0) // Allows running without a specific command (useful for $0 default command)
    .strict() // Report errors for unknown options or commands
    .wrap(yargs().terminalWidth()) // Wrap help text to terminal width
    .parse(); // Asynchronously parse arguments and execute command handler

  // Ensure the logger stream is closed on exit, especially if an error occurs before explicit close.
  if (loggerInstance && typeof loggerInstance.close === 'function') {
    loggerInstance.close();
  }
}

// Script execution entry point
if (require.main === module) {
  cli().catch(error => {
    // Fallback error logging if loggerInstance isn't fully set up or fails.
    const errorLogger = loggerInstance || initializeLogger('ERROR'); // Ensure logger is available
    errorLogger.error('An unexpected critical error occurred in the CLI execution:');
    errorLogger.error(error.message); // Log the error message
    // Log stack trace if in DEBUG mode or if logger supports getting current level
    if (process.env.DEBUG || (errorLogger.getLogLevel && errorLogger.getLogLevel() <= LOG_LEVELS.DEBUG)) {
         errorLogger.debug(error.stack || 'No stack trace available.');
    }
    if (errorLogger.close) errorLogger.close(); // Attempt to close log file
    process.exit(1); // Exit with error code
  });
}
