#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('yaml');
const { ERROR_TYPES, resolveFailureMessage } = require('./error-types');

function classifyHttpYacResult(result) {
  if (result.error) {
    return {
      success: false,
      exitCode: typeof result.status === 'number' ? result.status : null,
      failureType: ERROR_TYPES.PROCESS_ERROR,
      failureMessage: resolveFailureMessage(ERROR_TYPES.PROCESS_ERROR, {
        processErrorMessage: result.error.message
      })
    };
  }

  const exitCode = typeof result.status === 'number' ? result.status : null;

  switch (exitCode) {
    case 0:
      return {
        success: true,
        exitCode,
        failureType: null,
        failureMessage: null
      };
    case 10:
      return {
        success: false,
        exitCode,
        failureType: ERROR_TYPES.EXECUTION_ERROR,
        failureMessage: resolveFailureMessage(ERROR_TYPES.EXECUTION_ERROR)
      };
    case 20:
      return {
        success: false,
        exitCode,
        failureType: ERROR_TYPES.TEST_FAILED,
        failureMessage: resolveFailureMessage(ERROR_TYPES.TEST_FAILED)
      };
    default:
      return {
        success: false,
        exitCode,
        failureType: ERROR_TYPES.UNKNOWN_ERROR,
        failureMessage: resolveFailureMessage(ERROR_TYPES.UNKNOWN_ERROR, { exitCode })
      };
  }
}

async function findJourneysYaml(baseDir) {
  const journeys = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const hasJourneyYaml = entries.some((entry) => entry.isFile() && entry.name === 'journey.yaml');

    if (hasJourneyYaml) {
      journeys.push({
        name: path.basename(currentDir),
        path: currentDir,
        yamlPath: path.join(currentDir, 'journey.yaml')
      });
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(currentDir, entry.name));
      }
    }
  }

  try {
    await walk(baseDir);
  } catch (err) {
    console.error(`Error reading scenarios directory: ${err.message}`);
    throw err;
  }

  return [journeys, []];
}

async function findSmokeHttpFiles(smokeDir) {
  const smokeTests = [];

  try {
    const entries = await fs.readdir(smokeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.http')) {
        const fileContent = await fs.readFile(path.join(smokeDir, entry.name), 'utf8');
        const nameMatch = fileContent.match(/^#\s*@name\s+(.+)$/m);
        const titleMatch = fileContent.match(/^#\s*@title\s+(.+)$/m);
        const testName = nameMatch
          ? nameMatch[1].trim()
          : titleMatch ? titleMatch[1].trim() : path.basename(entry.name, '.http');

        smokeTests.push({
          name: path.basename(entry.name, '.http'),
          path: smokeDir,
          config: {
            name: 'Smoke',
            description: 'Minimal smoke checks',
            cases: [{
              name: testName,
              description: 'Smoke check',
              path: entry.name,
              test: testName
            }]
          }
        });
      }
    }
  } catch (err) {
    throw new Error(`Failed to read smoke path ${smokeDir}: ${err.message}`);
  }

  return smokeTests;
}

async function parseJourneyYaml(filepath) {
  try {
    const content = await fs.readFile(filepath, 'utf8');
    const config = yaml.parse(content);
    
    if (!config.cases || !Array.isArray(config.cases)) {
      throw new Error(`Invalid journey.yaml: missing 'cases' array`);
    }
    
    return {
      name: config.name || 'Unnamed Journey',
      description: config.description || '',
      cases: config.cases
    };
  } catch (err) {
    console.error(`Error parsing ${filepath}: ${err.message}`);
    throw err;
  }
}

async function runHttpYacTest(journeyPath, config, testCase, outputPath, env, httpyacVersion) {  
  console.log(`\nTesting: ${config.name} - ${testCase.name}`);
  console.log(`   Description: ${testCase.description || ''}`);
  console.log(`   Path: ${testCase.path}`);
  console.log(`   Test: ${testCase.test}`);
  
  const absoluteOutputPath = path.isAbsolute(outputPath) ? outputPath : path.resolve(outputPath);

  try {    
    const args = ['--yes', `httpyac@${httpyacVersion}`, 'send', testCase.path];
    for (const [key, value] of Object.entries(env || {})) {
      args.push('--var', `${key}=${value}`);
    }
    if (testCase.test) {
      args.push('--name', testCase.test);
    }
    args.push('--json', '--output', 'exchange', '--output-failed', 'exchange');


    const outputFd = await fs.open(absoluteOutputPath, 'w');
    
    let result;
    try {
      result = spawnSync('npx', args, {
        cwd: journeyPath,
        stdio: ['ignore', outputFd.fd, 'pipe'], 
        encoding: 'utf8'
      });
    } finally {
      await outputFd.close();
    }

    const classification = classifyHttpYacResult(result);
    const success = classification.success;
    let failureMessage = null;

    if (!success) {
      if (classification.failureType !== ERROR_TYPES.TEST_FAILED) {
        console.warn(`   ${classification.failureType}: ${classification.failureMessage}`);
      }
      failureMessage = classification.failureMessage;
    }

    return {
      success: success,
      journeyTitle: config.name || '',
      caseName: testCase.name,
      description: testCase.description || '',
      testPath: testCase.path,
      rawOutputFile: absoluteOutputPath,
      exitCode: classification.exitCode,
      failureType: classification.failureType,
      error: failureMessage,
      timestamp: new Date().toISOString()
    };

  } catch (err) {
    console.error(`   Failed: ${err.message}`);
    
    return {
      success: false,
      journeyTitle: config.name || '',
      caseName: testCase.name,
      exitCode: null,
      failureType: ERROR_TYPES.ACTION_ERROR,
      error: resolveFailureMessage(ERROR_TYPES.ACTION_ERROR, {
        actionErrorMessage: err.message
      }),
      rawOutputFile: absoluteOutputPath,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  findJourneysYaml,
  findSmokeHttpFiles,
  parseJourneyYaml,
  runHttpYacTest
};
