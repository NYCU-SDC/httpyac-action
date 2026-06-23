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

function resolveEntry(manifest, entry, context) {
  const selected = [];
  const selectedGroups = [];

  if (Array.isArray(entry.journeys)) {
    selected.push(...entry.journeys);
  }

  if (entry.group) {
    const group = manifest.journey_groups && manifest.journey_groups[entry.group];
    if (!group) {
      throw new Error(`${context} references unknown journey group: ${entry.group}`);
    }
    selectedGroups.push(entry.group);
    selected.push(...(group.journeys || []));
  }

  return {
    journeys: selected,
    groups: selectedGroups
  };
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

async function validateManifest(manifest, scenariosPath) {
  if (!manifest.defaults || typeof manifest.defaults !== 'object') {
    throw new Error('Manifest must define defaults');
  }

  if (!Array.isArray(manifest.defaults.always_run)) {
    throw new Error('Manifest defaults.always_run must be an array');
  }

  if (!manifest.journey_groups || typeof manifest.journey_groups !== 'object') {
    throw new Error('Manifest must define journey_groups');
  }

  if (!manifest.journey_groups.full || !Array.isArray(manifest.journey_groups.full.journeys)) {
    throw new Error('Manifest must define journey_groups.full.journeys');
  }

  if (!Array.isArray(manifest.rules)) {
    throw new Error('Manifest rules must be an array');
  }

  let knownJourneys;
  try {
    knownJourneys = await getKnownJourneys(scenariosPath);
  } catch (err) {
    throw new Error(`Failed to read scenarios path for manifest validation: ${err.message}`);
  }

  const validateEntry = (entry, context) => {
    const hasJourneys = Array.isArray(entry.journeys);
    const hasGroup = Boolean(entry.group);
    if (!hasJourneys && !hasGroup) {
      throw new Error(`${context} must define journeys or group`);
    }
    if (hasGroup && !manifest.journey_groups[entry.group]) {
      throw new Error(`${context} references unknown journey group: ${entry.group}`);
    }
    if (hasJourneys) {
      for (const journey of entry.journeys) {
        if (!knownJourneys.has(journey)) {
          throw new Error(`${context} references unknown journey: ${journey}`);
        }
      }
    }
  };

  for (const journey of manifest.defaults.always_run) {
    if (!knownJourneys.has(journey)) {
      throw new Error(`defaults.always_run references unknown journey: ${journey}`);
    }
  }

  for (const [groupName, group] of Object.entries(manifest.journey_groups)) {
    if (!Array.isArray(group.journeys)) {
      throw new Error(`journey_groups.${groupName}.journeys must be an array`);
    }
    validateEntry(group, `journey_groups.${groupName}`);
  }

  for (const [label, entry] of Object.entries(manifest.labels || {})) {
    validateEntry(entry, `labels.${label}`);
  }

  for (const rule of manifest.rules) {
    if (!rule || typeof rule.name !== 'string' || !rule.name.trim()) {
      throw new Error('Each rule must define a non-empty name');
    }
    if (!Array.isArray(rule.paths) || rule.paths.length === 0) {
      throw new Error(`Rule ${rule.name} must define at least one path`);
    }
    validateEntry(rule, `rules.${rule.name}`);
  }

  return knownJourneys;
}

function buildSelection({ manifest, changedFiles, labels, mode, explicitJourneys }) {
  const selected = new Set();
  const reasons = [];
  const unmatchedFiles = [];
  const fallbacks = [];
  const ignoredFiles = [];

  const addJourneys = (journeys) => {
    for (const journey of journeys) {
      selected.add(journey);
    }
  };

  const addGroup = (groupName, reasonType, source) => {
    const entry = { group: groupName };
    const resolved = resolveEntry(manifest, entry, `${reasonType}.${source}`);
    addJourneys(resolved.journeys);
    return resolved;
  };

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
    const resolved = addGroup('full', 'mode', 'all');
    reasons.push({
      type: 'mode',
      mode,
      selected_groups: resolved.groups,
      selected_journeys: resolved.journeys
    });
    return {
      mode: 'all',
      journeys: unique([...selected]),
      reasons,
      unmatched_files: [],
      ignored_files: [],
      fallbacks: []
    };
  }

  for (const label of labels) {
    const entry = manifest.labels && manifest.labels[label];
    if (!entry) {
      continue;
    }
    const resolved = resolveEntry(manifest, entry, `labels.${label}`);
    addJourneys(resolved.journeys);
    reasons.push({
      type: 'label',
      label,
      selected_groups: resolved.groups,
      selected_journeys: resolved.journeys
    });
  }

  if (mode === 'explicit') {
    if (explicitJourneys.length > 0) {
      addJourneys(explicitJourneys);
      reasons.push({
        type: 'explicit',
        source: 'journeys',
        selected_journeys: explicitJourneys
      });
    }

    return {
      mode: 'explicit',
      journeys: unique([...selected]),
      reasons,
      unmatched_files: [],
      ignored_files: [],
      fallbacks: []
    };
  }

  const ignorePaths = Array.isArray(manifest.ignore_paths) ? manifest.ignore_paths : [];
  const threshold = Number(manifest.defaults.large_change_threshold || 0);
  if (threshold > 0 && changedFiles.length > threshold) {
    const resolved = addGroup('full', 'fallback', 'large_change');
    fallbacks.push({
      type: 'large_change',
      changed_file_count: changedFiles.length,
      threshold,
      selected_groups: resolved.groups,
      selected_journeys: resolved.journeys
    });
    return {
      mode: 'full',
      journeys: unique([...selected]),
      reasons,
      unmatched_files: [],
      ignored_files: [],
      fallbacks
    };
  }

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

    const matchedRules = [];
    const candidatePaths = getPathCandidates(file);

    for (const rule of manifest.rules) {
      const matches = [];
      for (const candidate of candidatePaths) {
        for (const pattern of rule.paths) {
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

      const resolved = resolveEntry(manifest, rule, `rules.${rule.name}`);
      addJourneys(resolved.journeys);
      matchedRules.push(rule.name);
      reasons.push({
        type: 'changed_file',
        file: file.path,
        previous_file: file.previousPath || '',
        status: file.status,
        matched_rule: rule.name,
        matched_paths: unique(matches.map((match) => match.pattern)),
        matched_file_paths: matches,
        selected_groups: resolved.groups,
        selected_journeys: resolved.journeys
      });
    }

    if (matchedRules.length === 0) {
      unmatchedFiles.push(file.path);
    }
  }

  if (unmatchedFiles.length > 0 && manifest.defaults.unknown_change_policy === 'full') {
    const resolved = addGroup('full', 'fallback', 'unknown_change');
    fallbacks.push({
      type: 'unknown_change',
      files: unmatchedFiles,
      selected_groups: resolved.groups,
      selected_journeys: resolved.journeys
    });
    return {
      mode: 'full',
      journeys: unique([...selected]),
      reasons,
      unmatched_files: unmatchedFiles,
      ignored_files: ignoredFiles,
      fallbacks
    };
  }

  return {
    mode: 'affected',
    journeys: unique([...selected]),
    reasons,
    unmatched_files: unmatchedFiles,
    ignored_files: ignoredFiles,
    fallbacks
  };
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
  for (const journey of explicitJourneys) {
    if (!knownJourneys.has(journey)) {
      throw new Error(`Explicit journey does not exist: ${journey}`);
    }
  }

  return buildSelection({ manifest, changedFiles, labels, mode, explicitJourneys });
}

module.exports = {
  selectJourneys,
  loadChangedFiles,
  parseLabels,
  parseListInput,
  shouldIgnoreFile,
  matchesPath
};
