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
    
    if (!config.entry || !config.testcase) {
      throw new Error(`Invalid journey.yaml: missing 'entry' or 'testcase' field`);
    }
    
    return {
      name: config.name || 'Unnamed Journey',
      description: config.description || '',
      entry: config.entry,
      testcase: config.testcase
    };
  } catch (err) {
    console.error(`Error parsing ${filepath}: ${err.message}`);
    throw err;
  }
}

async function runHttpYacTest(journeyPath, config, outputPath, env, httpyacVersion = 'latest') {  
  console.log(`\nTesting: ${config.name}`);
  console.log(`   Description: ${config.description}`);
  console.log(`   Entry: ${config.entry}`);
  console.log(`   Testcase: ${config.testcase}`);
  
  try {    
    const absoluteOutputPath = path.isAbsolute(outputPath) ? outputPath : path.resolve(outputPath);

    const args = ['--yes', `httpyac@${httpyacVersion}`, 'send', config.entry];
    for (const [key, value] of Object.entries(env || {})) {
      args.push('--var', `${key}=${value}`);
    }
    args.push('--name', config.testcase, '--json --output none --output-failed exchange');

    const result = spawnSync('npx', args, {
      cwd: journeyPath,
      encoding: 'utf8'
    });

    const combinedOutput = `${result.stdout || ''}${result.stderr || ''}`;
    await fs.writeFile(absoluteOutputPath, combinedOutput, 'utf8');

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