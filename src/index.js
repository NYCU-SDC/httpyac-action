#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { program } = require('commander');
const { findJourneysYaml, parseJourneyYaml, runHttpYacTest } = require('./executor');
const { loadReports, buildMarkdownSummary, writeSummary } = require('./reporter');

async function setActionOutput(key, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  await fs.appendFile(outputPath, `${key}=${value}\n`, 'utf8');
}

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

async function main(options) {
  const { scenariosPath, outputDir } = options;
  
  const rawEnv = process.env.HTTPYAC_ENV;
  const env = parseEnvInput(rawEnv);
  
  console.log('httpYac Reporter - Phase 1: Test Execution');
  console.log(`   Scenarios Path: ${scenariosPath}`);
  console.log(`   Output Directory: ${outputDir}`);
  
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
    await setActionOutput('results-dir', outputDir);
    await setActionOutput('journey-count', 0);
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
      
      const result = await runHttpYacTest(journey.path, config, outputPath, customEnv);
      
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

  await setActionOutput('results-dir', outputDir);
  await setActionOutput('journey-count', journeys.length);

  console.log('\nhttpYac Reporter - Phase 2: Markdown Summary');
  const reports = await loadReports(outputDir);

  if (reports.length === 0) {
    console.log('   No JSON reports found to summarize');
    return;
  }

  const markdown = buildMarkdownSummary(reports);
  const summaryPath = await writeSummary(markdown, outputDir);

  console.log(`   Summary generated: ${summaryPath}`);
}

program
  .option('--scenarios-path <path>', 'Path to scenarios directory', './scenarios/user-journey')
  .option('--output-dir <path>', 'Output directory for JSON files', './httpyac-results')
  .parse(process.argv);

const options = program.opts();

main(options).catch(err => {
  console.error(`\nFatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
