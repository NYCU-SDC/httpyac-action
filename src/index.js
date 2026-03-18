#!/usr/bin/env node

const core = require('@actions/core');
const fs = require('fs').promises;
const path = require('path');
const { findJourneysYaml, parseJourneyYaml, runHttpYacTest } = require('./executor');
const { loadReports, buildMarkdownSummary, writeSummary } = require('./reporter');

function parseEnvInput(envInput) {
  const parsedEnv = {};

  if (!envInput) {
    return parsedEnv;
  }

  const lines = envInput.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      console.warn(`   Skipping invalid env line: ${rawLine}`);
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = rawLine.slice(rawLine.indexOf('=') + 1);

    if (!key) {
      console.warn(`   Skipping env line with empty key: ${rawLine}`);
      continue;
    }

    parsedEnv[key] = value;
  }

  return parsedEnv;
}

function getInputOrDefault(name, fallback) {
  const value = core.getInput(name, { required: false });
  return value ? value : fallback;
}

async function main() {
  const scenariosPath = getInputOrDefault('scenarios-path', './scenarios/user-journey');
  const outputDir = getInputOrDefault('output-dir', './httpyac-results');
  const rawEnv = getInputOrDefault('env', '');
  const httpyacVersion = getInputOrDefault('httpyac-version', 'latest');

  const customEnv = parseEnvInput(rawEnv);
  
  console.log('httpYac Action - Phase 1: Test Execution');
  console.log(`   Scenarios Path: ${scenariosPath}`);
  console.log(`   Output Directory: ${outputDir}`);
  console.log(`   httpYac Version: ${httpyacVersion}`);
  
  // Create output directory if it doesn't exist
  await fs.mkdir(outputDir, { recursive: true });
  
  // Find all journey.yaml files
  console.log('\nFinding user journeys...');
  const [journeys, skippedJourneys] = await findJourneysYaml(scenariosPath);
  
  if (skippedJourneys.length > 0) {
    console.log(`   Cannot find journey.yaml in ${skippedJourneys.length} directories: ${skippedJourneys.join(', ')}`);
  }

  if (journeys.length === 0) {
    console.log('   No user journeys found');
    core.setOutput('results-dir', outputDir);
    core.setOutput('journey-count', 0);
    return;
  } 
  console.log(`   Found ${journeys.length} user journey(s)`);
  
  // Process each journey
  const results = [];
  
  for (const journey of journeys) {
    try {
      const config = await parseJourneyYaml(journey.yamlPath);
      
      const outputFileName = `${journey.name}.json`;
      const outputPath = path.join(outputDir, outputFileName);
      
      const result = await runHttpYacTest(journey.path, config, outputPath, customEnv, httpyacVersion);
      
      results.push({
        journey: journey.name,
        config: config,
        ...result
      });
    } catch (err) {
      console.error(`\nError processing journey '${journey.name}': ${err.message}`);
      results.push({
        journey: journey.name,
        success: false,
        error: err.message
      });
    }
  }
  
  console.log('\nSummary');
  console.log(`   Total Journeys: ${results.length}`);
  console.log(`   Successful: ${results.filter(r => r.success).length}`);
  console.log(`   Failed: ${results.filter(r => !r.success).length}`);

  core.setOutput('results-dir', outputDir);
  core.setOutput('journey-count', journeys.length);

  console.log('\nhttpYac Action - Phase 2: Markdown Summary');
  const reports = await loadReports(outputDir);

  if (reports.length === 0) {
    console.log('   No JSON reports found to summarize');
    return;
  }

  const markdown = buildMarkdownSummary(reports);
  const summaryPath = await writeSummary(markdown, outputDir);

  console.log(`   Summary generated: ${summaryPath}`);
}
main().catch(err => {
  core.setFailed(err.message);
  console.error(err.stack);
});
