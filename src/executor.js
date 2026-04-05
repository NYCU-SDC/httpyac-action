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
    args.push('--name', testCase.test, '--json', '--output', 'none', '--output-failed', 'exchange');

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

    const success = result.status === 0 && !result.error;

    if (result.error) {
      throw result.error;
    }
    if (!success) {
      console.warn(`   httpyac exited with code ${result.status}`);
    }

    return {
      success: success,
      journeyTitle: config.name || '',
      caseName: testCase.name,
      description: testCase.description || '',
      testPath: testCase.path,
      rawOutputFile: absoluteOutputPath,
      stderr: result.stderr || null,
      timestamp: new Date().toISOString()
    };

  } catch (err) {
    console.error(`   Failed: ${err.message}`);
    
    return {
      success: false,
      journeyTitle: config.name || '',
      caseName: testCase.name,
      error: err.message,
      rawOutputFile: absoluteOutputPath,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  findJourneysYaml,
  parseJourneyYaml,
  runHttpYacTest
};