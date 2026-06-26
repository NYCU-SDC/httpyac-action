#!/usr/bin/env node

const core = require('@actions/core');
const fs = require('fs').promises;
const path = require('path');
const { findJourneysYaml, findSmokeHttpFiles, parseJourneyYaml, runHttpYacTest } = require('./executor');
const { loadReports, buildMarkdownSummary, writeSummary } = require('./reporter');
const { isTestFailed, isErrorResult } = require('./error-types');
const { selectJourneys } = require('./selector');

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
  const changedFilesPath = core.getInput('changed-files-path', { required: false });
  const labelsInput = core.getInput('labels', { required: false });
  const manifestPath = path.join(scenariosPath, 'manifest.yaml');
  const smokePath = path.join(scenariosPath, 'smoke');
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
  } 
  console.log(`   Found ${journeys.length} user journey(s)`);

  let selection = null;
  let journeysToRun = journeys;
  let smokeTests = [];

  if (changedFilesPath) {
    try {
      await fs.access(manifestPath);
    } catch (_err) {
      throw new Error(`changed-files-path requires manifest.yaml at ${manifestPath}`);
    }

    selection = await selectJourneys({
      manifestPath,
      changedFilesPath,
      labelsInput,
      scenariosPath
    });
  } else {
    selection = {
      mode: 'all',
      journeys: journeys.map((journey) => journey.name),
      reasons: [{ type: 'mode', mode: 'all', selected_journeys: journeys.map((journey) => journey.name) }],
      unmatched_files: []
    };
  }

  const selectionPath = path.join(outputDir, 'selection.json');
  await fs.writeFile(selectionPath, JSON.stringify(selection, null, 2), 'utf8');
  console.log(`\nSelection generated: ${selectionPath}`);
  console.log(`   Mode: ${selection.mode}`);
  console.log(`   Selected journeys: ${selection.journeys.join(', ') || '(none)'}`);

  const selectedJourneySet = new Set(selection.journeys || []);
  const allCasesJourneySet = new Set(selection.all_cases_journeys || []);
  const selectedCasesByJourney = new Map();
  for (const selectedCase of selection.cases || []) {
    if (!selectedCase || !selectedCase.journey) {
      continue;
    }
    if (!selectedCasesByJourney.has(selectedCase.journey)) {
      selectedCasesByJourney.set(selectedCase.journey, new Set());
    }
    selectedCasesByJourney
      .get(selectedCase.journey)
      .add(`${selectedCase.path || ''}\u0000${selectedCase.test || ''}\u0000${selectedCase.name || ''}`);
  }
  journeysToRun = journeys.filter((journey) => selectedJourneySet.has(journey.name));

  if (selectedJourneySet.has('smoke')) {
    smokeTests = await findSmokeHttpFiles(smokePath);
    if (smokeTests.length === 0) {
      throw new Error(`Selected smoke journey but no .http files were found in ${smokePath}`);
    }
  }

  const knownRunnableJourneys = new Set([
    ...journeys.map((journey) => journey.name),
    ...(smokeTests.length > 0 ? ['smoke'] : [])
  ]);
  const missingJourneys = selection.journeys.filter((journey) => !knownRunnableJourneys.has(journey));
  if (missingJourneys.length > 0) {
    throw new Error(`Selected journey is not runnable from scenarios-path: ${missingJourneys.join(', ')}`);
  }

  if (journeysToRun.length === 0 && smokeTests.length === 0) {
    throw new Error('Selection produced no runnable journeys');
  }
  
  const results = [];

  for (const smokeTest of smokeTests) {
    let caseIndex = 0;
    for (const testCase of smokeTest.config.cases) {
      caseIndex++;
      const outputFileName = `smoke-${caseIndex}.json`;
      const outputPath = path.join(outputDir, outputFileName);
      const metadataResult = await runHttpYacTest(smokeTest.path, smokeTest.config, testCase, outputPath, customEnv, HTTPYAC_VERSION);
      results.push(metadataResult);
    }
  }
  
  for (const journey of journeysToRun) {
    try {
      const config = await parseJourneyYaml(journey.yamlPath);
      const selectedCaseKeys = selectedCasesByJourney.get(journey.name);
      const casesToRun = allCasesJourneySet.has(journey.name) || !selectedCaseKeys
        ? config.cases
        : config.cases.filter((testCase) => {
            return selectedCaseKeys.has(`${testCase.path || ''}\u0000${testCase.test || ''}\u0000${testCase.name || ''}`);
          });

      if (casesToRun.length === 0) {
        console.log(`\nSkipping journey '${journey.name}' because no selected cases are runnable`);
        continue;
      }
      
      let caseIndex = 0;
      for (const testCase of casesToRun) {
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
    selection,
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

  const markdown = buildMarkdownSummary(reports, selection);
  const summaryPath = await writeSummary(markdown, outputDir);

  console.log(`   Summary generated: ${summaryPath}`);
}
main().catch(err => {
  core.setFailed(err.message);
  console.error(err.stack);
});
