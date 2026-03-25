#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('yaml');

async function findJourneysYaml(baseDir) {
  const journeys = [];
  const skippedJourneys = [];
  
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const journeyPath = path.join(baseDir, entry.name);
        const yamlPath = path.join(journeyPath, 'journey.yaml');
        
        try {
          await fs.access(yamlPath);
          journeys.push({
            name: entry.name,
            path: journeyPath,
            yamlPath: yamlPath
          });
        } catch (err) {
          // journey.yaml doesn't exist in this directory, skip it
          skippedJourneys.push(entry.name);
        }
      }
    }
  } catch (err) {
    console.error(`Error reading scenarios directory: ${err.message}`);
    throw err;
  }
  
  return [journeys, skippedJourneys];
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

async function runHttpYacTest(journeyPath, config, testCase, outputPath, env, httpyacVersion = 'latest') {  
  console.log(`\nTesting: ${config.name} - ${testCase.name}`);
  console.log(`   Description: ${testCase.description || ''}`);
  console.log(`   Path: ${testCase.path}`);
  console.log(`   Test: ${testCase.test}`);
  
  try {    
    const absoluteOutputPath = path.isAbsolute(outputPath) ? outputPath : path.resolve(outputPath);

    const args = ['--yes', `httpyac@${httpyacVersion}`, 'send', testCase.path];
    for (const [key, value] of Object.entries(env || {})) {
      args.push('--var', `${key}=${value}`);
    }
    args.push('--name', testCase.test, '--json', '--output', 'none', '--output-failed', 'exchange');

    const result = spawnSync('npx', args, {
      cwd: journeyPath,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024
    });

    let testData = null;
    try {
      if (result.stdout) {
        testData = JSON.parse(result.stdout);
      }
    } catch (parseErr) {
      console.warn(`   Warning: Could not parse httpyac output as JSON.`);
      testData = { rawOutput: result.stdout };
    }

    const finalReport = {
      journeyTitle: config.name || '',
      journey: {
        name: `${testCase.name}`,
        description: testCase.description || ''
      },
      testResult: testData,
      stderr: result.stderr,
      timestamp: new Date().toISOString()
    };

    await fs.writeFile(absoluteOutputPath, JSON.stringify(finalReport, null, 2), 'utf8');

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(`httpyac exited with code ${result.status}`);
    }
    
    return {
      success: true,
      output: outputPath
    };
  } catch (err) {
    console.error(`   Failed: ${err.message}`);
    
    return {
      success: false,
      error: err.message,
      output: outputPath
    };
  }
}

module.exports = {
  findJourneysYaml,
  parseJourneyYaml,
  runHttpYacTest
};