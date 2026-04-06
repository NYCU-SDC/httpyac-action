#!/usr/bin/env node

const core = require('@actions/core');
const fs = require('fs').promises;
const path = require('path');
const { findJourneysYaml, parseJourneyYaml, runHttpYacTest } = require('./executor');
const { loadReports, buildMarkdownSummary, writeSummary } = require('./reporter');
const { isTestFailed, isErrorResult } = require('./error-types');
const { error } = require('console');

const HTTPYAC_VERSION = '6.16.7';

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

async function main() {
  const scenariosPath = core.getInput('scenarios-path', { required: true });
  const outputDir = core.getInput('output-dir', { required: false }) || './httpyac-results';
  const rawEnv = core.getInput('env', { required: true });

  const customEnv = parseEnvInput(rawEnv);
  
  console.log('httpYac Action - Phase 1: Test Execution');
  await fs.mkdir(outputDir, { recursive: true });
  
  // Find all journey.yaml files
  console.log('\nFinding user journeys...');
  const [journeys, skippedJourneys] = await findJourneysYaml(scenariosPath);
  
  if (skippedJourneys.length > 0) {
    console.log(`   Cannot find journey.yaml in ${skippedJourneys.length} directories: ${skippedJourneys.join(', ')}`);
  }

  if (journeys.length === 0) {
    console.log('   No user journeys found');
    return;
  } 
  console.log(`   Found ${journeys.length} user journey(s)`);
  
  const results = [];
  
  for (const journey of journeys) {
    try {
      const config = await parseJourneyYaml(journey.yamlPath);
      
      let caseIndex = 0;
      for (const testCase of config.cases) {
        caseIndex++;
        
        const outputFileName = `${journey.name}-${caseIndex}.json`;
        const outputPath = path.join(outputDir, outputFileName);
        
        const metadataResult = await runHttpYacTest(journey.path, config, testCase, outputPath, customEnv, HTTPYAC_VERSION);
        
        results.push(metadataResult);
      }
    } catch (err) {
      console.error(`\nError processing journey '${journey.name}': ${err.message}`);
      results.push({
        success: false,
        journeyTitle: journey.name,
        error: err.message,
        timestamp: new Date().toISOString()
      });
    }
  }
  
  // Create metadata.json
  const metadataPath = path.join(outputDir, 'metadata.json');
  const failedCount = results.filter(isTestFailed).length;
  const errorCount = results.filter(isErrorResult).length;
  const metadataData = {
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      successful: results.filter(r => r.success).length,
      failed: failedCount,
      error: errorCount
    },
    tests: results
  };

  await fs.writeFile(metadataPath, JSON.stringify(metadataData, null, 2), 'utf8');
  
  console.log('\nSummary');
  console.log(`   Total Test Cases: ${metadataData.summary.total}`);
  console.log(`   Successful: ${metadataData.summary.successful}`);
  console.log(`   Failed: ${metadataData.summary.failed}`);
  console.log(`   Error: ${metadataData.summary.error}`);
  console.log(`   Metadata generated: ${metadataPath}`);

  console.log('\nhttpYac Action - Phase 2: Markdown Summary');
  
  const reports = await loadReports(outputDir);

  if (!reports || reports.length === 0) {
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
