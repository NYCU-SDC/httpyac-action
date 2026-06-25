const fs = require('fs').promises;
const path = require('path');
const yaml = require('yaml');

function unique(values) {
  return [...new Set(values)];
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(pattern) {
  let result = '';
  const value = String(pattern);

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const next = value[index + 1];

    if (char === '*' && next === '*') {
      result += '.*';
      index++;
    } else if (char === '*') {
      result += '[^/]*';
    } else {
      result += escapeRegex(char);
    }
  }

  return new RegExp(`^${result}$`);
}

function matchesPath(filePath, pattern) {
  return globToRegex(pattern).test(filePath);
}

function getPathCandidates(file) {
  return [
    { field: 'path', value: file.path },
    { field: 'previousPath', value: file.previousPath }
  ].filter((candidate) => candidate.value);
}

function getIgnoreMatches(file, ignorePaths = []) {
  const matches = [];
  for (const candidate of getPathCandidates(file)) {
    const matchedPatterns = ignorePaths.filter((pattern) => matchesPath(candidate.value, pattern));
    if (matchedPatterns.length > 0) {
      matches.push({
        field: candidate.field,
        path: candidate.value,
        matched_ignore_paths: matchedPatterns
      });
    }
  }
  return matches;
}

function shouldIgnoreFile(file, ignorePaths = []) {
  const candidates = getPathCandidates(file);
  if (candidates.length === 0 || ignorePaths.length === 0) {
    return { ignored: false, matches: [] };
  }

  const matches = getIgnoreMatches(file, ignorePaths);
  const matchedFields = new Set(matches.map((match) => match.field));

  return {
    ignored: candidates.every((candidate) => matchedFields.has(candidate.field)),
    matches
  };
}

async function loadManifest(manifestPath) {
  const content = await fs.readFile(manifestPath, 'utf8');
  const manifest = yaml.parse(content);

  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Manifest must be a YAML object');
  }

  return manifest;
}

async function loadChangedFiles(changedFilesPath) {
  const content = await fs.readFile(changedFilesPath, 'utf8');
  const parsed = JSON.parse(content);
  const files = Array.isArray(parsed) ? parsed : parsed.files;

  if (!Array.isArray(files)) {
    throw new Error('Changed files JSON must be an array or an object with a files array');
  }

  return files.map((file) => {
    if (typeof file === 'string') {
      return { path: file, status: 'modified' };
    }

    if (!file || typeof file.path !== 'string' || !file.path.trim()) {
      throw new Error('Each changed file must include a non-empty path');
    }

    return {
      path: file.path,
      previousPath: file.previousPath || file.previous_path || '',
      status: file.status || 'modified'
    };
  });
}

function parseLabels(labelInput) {
  if (!labelInput) {
    return [];
  }

  const trimmed = labelInput.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const labels = Array.isArray(parsed) ? parsed : parsed.labels;
    if (!Array.isArray(labels)) {
      throw new Error('Labels JSON must be an array or an object with a labels array');
    }
    return labels.map(String);
  }

  return trimmed
    .split(/[\n,]/)
    .map((label) => label.trim())
    .filter(Boolean);
}

function parseListInput(value, fieldName) {
  if (!value) {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`${fieldName} JSON must be an array`);
    }
    return parsed.map(String);
  }

  return trimmed
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function getKnownJourneys(scenariosPath) {
  const knownJourneys = new Set(['smoke']);

  const entries = await fs.readdir(scenariosPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      try {
        await fs.access(path.join(scenariosPath, entry.name, 'journey.yaml'));
        knownJourneys.add(entry.name);
      } catch (_err) {
        // Directory without journey.yaml is not a selectable user journey.
      }
    }
  }

  return knownJourneys;
}

async function loadJourneyCases(scenariosPath) {
  const journeys = new Map();
  const entries = await fs.readdir(scenariosPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const journeyYamlPath = path.join(scenariosPath, entry.name, 'journey.yaml');
    try {
      const content = await fs.readFile(journeyYamlPath, 'utf8');
      const config = yaml.parse(content);
      const cases = Array.isArray(config && config.cases) ? config.cases : [];
      journeys.set(entry.name, {
        name: entry.name,
        title: config && config.name ? config.name : entry.name,
        cases: cases.map((testCase, index) => ({
          name: testCase.name || `Case ${index + 1}`,
          path: testCase.path || '',
          test: testCase.test || '',
          domains: Array.isArray(testCase.domains) ? testCase.domains.map(String) : []
        }))
      });
    } catch (_err) {
      // Directory without journey.yaml is not a selectable user journey.
    }
  }

  return journeys;
}

async function validateManifest(manifest, scenariosPath) {
  if (!manifest.defaults || typeof manifest.defaults !== 'object') {
    throw new Error('Manifest must define defaults');
  }

  if (!Array.isArray(manifest.defaults.always_run)) {
    throw new Error('Manifest defaults.always_run must be an array');
  }

  let knownJourneys;
  try {
    knownJourneys = await getKnownJourneys(scenariosPath);
  } catch (err) {
    throw new Error(`Failed to read scenarios path for manifest validation: ${err.message}`);
  }

  const domainNames = new Set(Object.keys(manifest.domains || {}));

  const validateJourneys = (journeys, context) => {
    if (!Array.isArray(journeys)) {
      return;
    }
    for (const journey of journeys) {
      if (!knownJourneys.has(journey)) {
        throw new Error(`${context} references unknown journey: ${journey}`);
      }
    }
  };

  const validateDomains = (domains, context) => {
    if (!Array.isArray(domains)) {
      return;
    }
    for (const domain of domains) {
      if (!domainNames.has(domain)) {
        throw new Error(`${context} references unknown domain: ${domain}`);
      }
    }
  };

  for (const journey of manifest.defaults.always_run) {
    if (!knownJourneys.has(journey)) {
      throw new Error(`defaults.always_run references unknown journey: ${journey}`);
    }
  }

  for (const [domainName, domain] of Object.entries(manifest.domains || {})) {
    if (!domain || typeof domain !== 'object') {
      throw new Error(`domains.${domainName} must be an object`);
    }
    if (!Array.isArray(domain.paths) || domain.paths.length === 0) {
      throw new Error(`domains.${domainName}.paths must define at least one path`);
    }
    if (domain.risk && domain.risk !== 'full') {
      throw new Error(`domains.${domainName}.risk must be full when defined`);
    }
  }

  for (const [label, entry] of Object.entries(manifest.labels || {})) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`labels.${label} must be an object`);
    }
    if (entry.mode && entry.mode !== 'full') {
      throw new Error(`labels.${label}.mode must be full when defined`);
    }
    validateJourneys(entry.journeys, `labels.${label}`);
    validateDomains(entry.domains, `labels.${label}`);
  }

  return knownJourneys;
}

function buildSelection({ manifest, changedFiles, labels, mode, explicitJourneys, journeyCases }) {
  const selected = new Set();
  const allCasesJourneys = new Set();
  const selectedCases = new Map();
  const reasons = [];
  const unmatchedFiles = [];
  const fallbacks = [];
  const ignoredFiles = [];

  const addJourneys = (journeys, allCases = false) => {
    for (const journey of journeys) {
      selected.add(journey);
      if (allCases && journey !== 'smoke') {
        allCasesJourneys.add(journey);
      }
    }
  };

  const addCase = (journeyName, testCase) => {
    selected.add(journeyName);
    const key = `${journeyName}\u0000${testCase.path}\u0000${testCase.test || ''}\u0000${testCase.name || ''}`;
    if (!selectedCases.has(key)) {
      selectedCases.set(key, {
        journey: journeyName,
        name: testCase.name,
        path: testCase.path,
        test: testCase.test || '',
        domains: testCase.domains || []
      });
    }
  };

  const addAllJourneys = () => {
    const journeys = [...journeyCases.keys()];
    addJourneys(journeys, true);
    return journeys;
  };

  const addCasesForDomain = (domainName) => {
    const domainSelectedCases = [];
    for (const [journeyName, journey] of journeyCases.entries()) {
      for (const testCase of journey.cases) {
        if ((testCase.domains || []).includes(domainName)) {
          addCase(journeyName, testCase);
          domainSelectedCases.push({
            journey: journeyName,
            name: testCase.name,
            path: testCase.path,
            test: testCase.test || ''
          });
        }
      }
    }
    return domainSelectedCases;
  };

  const selectedPayload = (selectionMode) => ({
    mode: selectionMode,
    journeys: unique([...selected]),
    cases: [...selectedCases.values()],
    all_cases_journeys: unique([...allCasesJourneys]),
    reasons,
    unmatched_files: unmatchedFiles,
    ignored_files: ignoredFiles,
    fallbacks
  });

  const alwaysRun = manifest.defaults.always_run || [];
  addJourneys(alwaysRun);
  if (alwaysRun.length > 0) {
    reasons.push({
      type: 'default',
      source: 'always_run',
      selected_journeys: alwaysRun
    });
  }

  if (mode === 'all') {
    const allJourneys = addAllJourneys();
    reasons.push({
      type: 'mode',
      mode,
      selected_journeys: allJourneys
    });
    return selectedPayload('all');
  }

  let labelRequestedFull = false;
  for (const label of labels) {
    const entry = manifest.labels && manifest.labels[label];
    if (!entry) {
      continue;
    }

    let selectedJourneys = [];
    let selectedDomains = [];
    let selectedLabelCases = [];

    if (entry.mode === 'full') {
      labelRequestedFull = true;
      selectedJourneys = addAllJourneys();
    }

    if (Array.isArray(entry.journeys)) {
      selectedJourneys.push(...entry.journeys);
      addJourneys(entry.journeys, true);
    }

    if (Array.isArray(entry.domains)) {
      selectedDomains = entry.domains;
      for (const domainName of entry.domains) {
        selectedLabelCases.push(...addCasesForDomain(domainName));
      }
    }

    reasons.push({
      type: 'label',
      label,
      mode: entry.mode || '',
      selected_domains: selectedDomains,
      selected_journeys: unique(selectedJourneys),
      selected_cases: selectedLabelCases
    });
  }

  if (labelRequestedFull) {
    return selectedPayload('full');
  }

  if (mode === 'explicit') {
    if (explicitJourneys.length > 0) {
      addJourneys(explicitJourneys, true);
      reasons.push({
        type: 'explicit',
        source: 'journeys',
        selected_journeys: explicitJourneys
      });
    }

    return selectedPayload('explicit');
  }

  const ignorePaths = Array.isArray(manifest.defaults.ignore_paths) ? manifest.defaults.ignore_paths : [];
  const threshold = Number(manifest.defaults.large_change_threshold || 0);
  if (threshold > 0 && changedFiles.length > threshold) {
    const allJourneys = addAllJourneys();
    fallbacks.push({
      type: 'large_change',
      changed_file_count: changedFiles.length,
      threshold,
      selected_journeys: allJourneys
    });
    return selectedPayload('full');
  }

  const domainEntries = Object.entries(manifest.domains || {});
  const impactedDomains = new Map();
  const fullRiskDomainMatches = [];

  for (const file of changedFiles) {
    const ignoreResult = shouldIgnoreFile(file, ignorePaths);
    if (ignoreResult.ignored) {
      ignoredFiles.push({
        path: file.path,
        previousPath: file.previousPath || '',
        status: file.status,
        matches: ignoreResult.matches
      });
      continue;
    }

    const matchedDomains = [];
    const candidatePaths = getPathCandidates(file);

    for (const [domainName, domain] of domainEntries) {
      const matches = [];
      for (const candidate of candidatePaths) {
        for (const pattern of domain.paths) {
          if (matchesPath(candidate.value, pattern)) {
            matches.push({
              field: candidate.field,
              path: candidate.value,
              pattern
            });
          }
        }
      }

      if (matches.length === 0) {
        continue;
      }

      if (!impactedDomains.has(domainName)) {
        impactedDomains.set(domainName, []);
      }
      impactedDomains.get(domainName).push(file.path);
      matchedDomains.push(domainName);
      reasons.push({
        type: 'changed_file_domain',
        file: file.path,
        previous_file: file.previousPath || '',
        status: file.status,
        matched_domain: domainName,
        matched_paths: unique(matches.map((match) => match.pattern)),
        matched_file_paths: matches,
        risk: domain.risk || ''
      });

      if (domain.risk === 'full') {
        fullRiskDomainMatches.push({
          domain: domainName,
          file: file.path
        });
      }
    }

    if (matchedDomains.length === 0) {
      unmatchedFiles.push(file.path);
    }
  }

  if (fullRiskDomainMatches.length > 0) {
    const allJourneys = addAllJourneys();
    fallbacks.push({
      type: 'domain_risk',
      matches: fullRiskDomainMatches,
      selected_journeys: allJourneys
    });
    return selectedPayload('full');
  }

  if (unmatchedFiles.length > 0 && manifest.defaults.unknown_change_policy === 'full') {
    const allJourneys = addAllJourneys();
    fallbacks.push({
      type: 'unknown_change',
      files: unmatchedFiles,
      selected_journeys: allJourneys
    });
    return selectedPayload('full');
  }

  for (const [domainName] of impactedDomains) {
    const domainSelectedCases = addCasesForDomain(domainName);

    reasons.push({
      type: 'domain_selection',
      domain: domainName,
      files: unique(impactedDomains.get(domainName)),
      selected_cases: domainSelectedCases
    });
  }

  const uncoveredDomains = [...impactedDomains.keys()].filter((domainName) => {
    return ![...selectedCases.values()].some((testCase) => (testCase.domains || []).includes(domainName));
  });

  if (uncoveredDomains.length > 0 && manifest.defaults.unknown_change_policy === 'full') {
    const allJourneys = addAllJourneys();
    fallbacks.push({
      type: 'uncovered_domain',
      domains: uncoveredDomains,
      selected_journeys: allJourneys
    });
    return selectedPayload('full');
  }

  return selectedPayload('affected');
}

async function selectJourneys(options) {
  const manifest = await loadManifest(options.manifestPath);
  const changedFiles = options.changedFilesPath ? await loadChangedFiles(options.changedFilesPath) : [];
  const labels = parseLabels(options.labelsInput || '');
  const explicitJourneys = parseListInput(options.journeysInput || '', 'journeys');
  const mode = options.mode || 'affected';

  if (!['all', 'affected', 'explicit'].includes(mode)) {
    throw new Error(`Invalid run mode: ${mode}`);
  }

  const knownJourneys = await validateManifest(manifest, options.scenariosPath);
  const journeyCases = await loadJourneyCases(options.scenariosPath);
  for (const journey of explicitJourneys) {
    if (!knownJourneys.has(journey)) {
      throw new Error(`Explicit journey does not exist: ${journey}`);
    }
  }

  return buildSelection({ manifest, changedFiles, labels, mode, explicitJourneys, journeyCases });
}

module.exports = {
  selectJourneys,
  loadChangedFiles,
  parseLabels,
  parseListInput,
  shouldIgnoreFile,
  matchesPath
};
