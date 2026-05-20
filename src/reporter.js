const fs = require('fs').promises;
const path = require('path');
const { ERROR_TYPES, resolveFailureMessage, isTestFailed, isErrorResult } = require('./error-types');

const MAX_BODY_LINES = 1000;
const IMPORTANT_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'date',
  'server',
  'cache-control',
  'etag',
  'transfer-encoding',
  'content-encoding'
]);

function normalizeSummary(summary = {}) {
  const passed = Number(summary.successTests || 0);
  const failed = Number(summary.failedTests || 0);
  const errored = Number(summary.erroredTests || 0);
  const skipped = Number(summary.skippedTests || 0);
  const total = Number(summary.totalTests || passed + failed + errored + skipped);
  return { passed, failed, errored, skipped, total };
}

function normalizeRequestSummary(request = {}) {
  if (request.summary && typeof request.summary === 'object') {
    return normalizeSummary(request.summary);
  }

  const results = Array.isArray(request.testResults) ? request.testResults : [];
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let skipped = 0;

  for (const result of results) {
    switch (result.status) {
      case 'SUCCESS':
        passed += 1;
        break;
      case 'SKIPPED':
        skipped += 1;
        break;
      case 'FAILED':
        failed += 1;
        break;
      case 'ERROR':
        errored += 1;
        break;
      default:
        break;
    }
  }

  return {
    passed,
    failed,
    errored,
    skipped,
    total: passed + failed + errored + skipped
  };
}

function formatDurationMs(value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    return 'N/A';
  }

  return `${Math.round(Number(value))}ms`;
}

function getTotalDuration(requests = []) {
  const total = requests.reduce((sum, request) => {
    const duration = Number(request.duration);
    return Number.isFinite(duration) ? sum + duration : sum;
  }, 0);

  return formatDurationMs(total);
}

function getPassPercentage(passed, failed, errored) {
  const executed = passed + failed + errored;
  if (executed <= 0) {
    return 'N/A';
  }

  return ((passed / executed) * 100).toFixed(2);
}

function getBadgeStyle(passed, failed, errored, skipped) {
  if (errored > 0) {
    return { badge: 'critical', alt: 'Tests errored' };
  }

  if (failed > 0) {
    return { badge: 'critical', alt: 'Tests failed' };
  }

  if (passed > 0) {
    return { badge: 'success', alt: 'Tests passed' };
  }

  if (skipped > 0) {
    return {  badge: 'inactive', alt: 'Tests skipped' };
  }

  return { badge: 'inactive', alt: 'No tests executed' };
}

function parseJsonString(value) {
  if (typeof value !== 'string') {
    return { parsed: false, value };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { parsed: false, value: '' };
  }

  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return { parsed: false, value };
  }

  try {
    return { parsed: true, value: JSON.parse(trimmed) };
  } catch (_err) {
    return { parsed: false, value };
  }
}

function toCodeBlock(content, language = '') {
  const safeContent = content === undefined || content === null ? '' : String(content);
  const lines = safeContent.split('\n');

  if (lines.length > MAX_BODY_LINES) {
    const truncated = lines.slice(0, MAX_BODY_LINES).join('\n');
    return `\n\n\`\`\`${language}\n${truncated}\n... (truncated)\n\`\`\``;
  }

  return `\n\n\`\`\`${language}\n${safeContent}\n\`\`\``;
}

function prettyPrintBody(body) {
  if (body === undefined || body === null || body === '') {
    return '_Empty_';
  }

  if (typeof body === 'object') {
    return toCodeBlock(JSON.stringify(body, null, 2), 'json');
  }

  const parsedResult = parseJsonString(body);
  if (parsedResult.parsed) {
    return toCodeBlock(JSON.stringify(parsedResult.value, null, 2), 'json');
  }

  return toCodeBlock(String(body));
}

function toHeaderName(name) {
  return String(name)
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

function normalizeBodyText(body) {
  if (body === undefined || body === null || body === '') {
    return '';
  }

  if (typeof body === 'object') {
    return JSON.stringify(body, null, 2);
  }

  const parsedResult = parseJsonString(body);
  if (parsedResult.parsed) {
    return JSON.stringify(parsedResult.value, null, 2);
  }

  return String(body);
}

function getRequestTarget(urlValue) {
  if (!urlValue) {
    return '/';
  }

  try {
    const parsed = new URL(urlValue);
    return `${parsed.pathname || '/'}${parsed.search || ''}`;
  } catch (_err) {
    return String(urlValue);
  }
}

function getHostFromUrl(urlValue) {
  if (!urlValue) {
    return null;
  }

  try {
    const parsed = new URL(urlValue);
    return parsed.host || null;
  } catch (_err) {
    return null;
  }
}

function getHttpProtocol(response = {}) {
  if (response.protocol) {
    return response.protocol;
  }

  return 'httpYac/6.16.7'; // Default to httpYac version if protocol is not provided
}

function formatHttpRequestBlock(responseRequest = {}, response = {}) {
  const method = responseRequest.method || 'N/A';
  const requestUrl = responseRequest.url || null;
  const protocol = getHttpProtocol(response);
  const target = getRequestTarget(requestUrl);
  const requestLine = `${method} ${target} ${protocol}`;

  const headers = { ...(responseRequest.headers || {}) };
  const host = getHostFromUrl(requestUrl);
  if (host && !Object.keys(headers).some((key) => key.toLowerCase() === 'host')) {
    headers.host = host;
  }

  const headerLines = Object.entries(headers).map(([key, value]) => `${toHeaderName(key)}: ${value}`);
  const bodyText = normalizeBodyText(responseRequest.body);

  return [requestLine, ...headerLines, '', bodyText].join('\n').trimEnd();
}

function formatHttpResponseBlock(response = {}) {
  const protocol = getHttpProtocol(response);
  const statusCode = response.statusCode ?? 'N/A';
  const statusMessage = response.statusMessage || '';
  const statusLine = `${protocol} ${statusCode} ${statusMessage}`.trim();

  const headers = response.headers || {};
  const headerLines = Object.entries(headers).map(([key, value]) => `${toHeaderName(key)}: ${value}`);
  const bodyText = normalizeBodyText(response.body);

  return [statusLine, ...headerLines, '', bodyText].join('\n').trimEnd();
}

function formatHeaders(headers, onlyImportant = false) {
  if (!headers || typeof headers !== 'object') {
    return '_N/A_';
  }

  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (onlyImportant && !IMPORTANT_RESPONSE_HEADERS.has(lowerKey)) {
      continue;
    }

    normalized[key] = value;
  }

  if (Object.keys(normalized).length === 0) {
    return '_N/A_';
  }

  return toCodeBlock(JSON.stringify(normalized, null, 2), 'json');
}

function getRequestDisplayName(request, existingNames) {
  const baseName = request.name || `${path.basename(request.fileName || 'request.http')}#${request.line || 'unknown'}`;

  if (!existingNames.has(baseName)) {
    existingNames.add(baseName);
    return baseName;
  }

  const withLine = `${baseName} (line ${request.line || 'unknown'})`;
  if (!existingNames.has(withLine)) {
    existingNames.add(withLine);
    return withLine;
  }

  let suffix = 2;
  while (existingNames.has(`${withLine} #${suffix}`)) {
    suffix += 1;
  }

  const uniqueName = `${withLine} #${suffix}`;
  existingNames.add(uniqueName);
  return uniqueName;
}

function getFailedTests(testResults = []) {
  return testResults.filter((result) => result.status && result.status !== 'SUCCESS' && result.status !== 'SKIPPED');
}

function getTestResultLabel(test = {}) {
  const status = (test.status || '').toUpperCase();

  if (status === 'ERROR') {
    return 'ERROR';
  }

  if (status === 'FAILED') {
    return 'FAILED';
  }

  if (test.error && test.error.errorType) {
    return test.error.errorType;
  }

  if (test.errorType) {
    return test.errorType;
  }

  return status || 'FAILED';
}

function buildRequestFailureDetails(request, reportIndex, requestIndex, requestName) {
  const anchorId = `user-content-r${reportIndex}s${requestIndex}`;
  const response = request.response || {};
  const responseRequest = response.request || {};
  const failedTests = getFailedTests(request.testResults || []);

  const lines = [];
  lines.push(`#### <a id="${anchorId}" href="#${anchorId}"></a>🧪 ${requestName}`);
  lines.push('');
  lines.push('**Test Details**');

  if (failedTests.length === 0) {
    lines.push('- _No test details found._');
    return lines.join('\n');
  }

  failedTests.forEach((test, idx) => {
    lines.push(`${idx + 1}. ${getTestResultLabel(test)}: ${test.message || 'Unnamed test'}`);
  });

  lines.push('\n**Request Information**');
  lines.push(toCodeBlock(formatHttpRequestBlock(responseRequest, response), 'http'));
  lines.push('');
  lines.push('**Response Information**');
  lines.push(toCodeBlock(formatHttpResponseBlock(response), 'http'));
  lines.push('');

  return lines.join('\n');
}

function buildRequestTableRows(report, reportIndex) {
  const existingNames = new Set();

  return report.requests.map((request, requestIndex) => {
    const requestSummary = normalizeRequestSummary(request);
    const hasTests = requestSummary.total > 0;
    const requestFailed = requestSummary.failed > 0 || requestSummary.errored > 0;
    const displayName = getRequestDisplayName(request, existingNames);

    const requestNameCell = requestFailed
      ? `[${displayName}](#user-content-r${reportIndex}s${requestIndex})`
      : displayName;

    const passedCell = hasTests && requestSummary.passed > 0 ? `${requestSummary.passed} ✅` : '';
    const failedCell = hasTests && requestSummary.failed > 0 ? `${requestSummary.failed} ❌` : '';
    const erroredCell = hasTests && requestSummary.errored > 0 ? `${requestSummary.errored} 🔥` : '';
    const skippedCell = hasTests && requestSummary.skipped > 0 ? `${requestSummary.skipped} ⚪` : '';

    return {
      requestName: displayName,
      row: `|${requestNameCell}|${passedCell}|${failedCell}|${erroredCell}|${skippedCell}|${formatDurationMs(request.duration)}|`
    };
  });
}

function buildReportSection(report, reportIndex) {
  const requestRows = buildRequestTableRows(report, reportIndex);
  const requestNameByIndex = requestRows.map((row) => row.requestName);

  const sectionLines = [];
  const reportAnchor = `user-content-r${reportIndex}`;
  const allPassed = report.total > 0 && report.passed === report.total;

  sectionLines.push(`### <a id="${reportAnchor}" href="#${reportAnchor}"></a>${report.displayName}`);

  if (report.parseError) {
    sectionLines.push(`> Failed to parse ${report.displayName}: ${report.parseError}`);
    sectionLines.push('');
    return sectionLines.join('\n');
  }

  if (report.description) {
    sectionLines.push(`${report.description}`);
    sectionLines.push('');
  }
  if (report.metadataFailure) {
    sectionLines.push(`> Error occurred during testing: ${report.metadataFailure}`);
    sectionLines.push('');
  }

  if (allPassed) {
    sectionLines.push('<details>');
    sectionLines.push(`  <summary>All ${report.total} tests passed</summary>`);
    sectionLines.push('');
  }

  sectionLines.push('|Test Name|Passed|Failed|Errored|Skipped|Time|');
  sectionLines.push('|:---|---:|---:|---:|---:|---:|');
  requestRows.forEach((row) => sectionLines.push(row.row));

  const failedRequests = report.requests
    .map((request, idx) => ({ request, idx }))
    .filter(({ request }) => {
      const requestSummary = normalizeRequestSummary(request);
      return requestSummary.failed > 0 || requestSummary.errored > 0;
    });

  for (const { request, idx } of failedRequests) {
    sectionLines.push('');
    sectionLines.push(buildRequestFailureDetails(request, reportIndex, idx, requestNameByIndex[idx]));
  }

  if (allPassed) {
    sectionLines.push('');
    sectionLines.push('</details>');
  }

  return sectionLines.join('\n');
}

function buildOverviewSection(reports, globalTotals) {
  const { passed, failed, errored, skipped } = globalTotals;
  const badgeStyle = getBadgeStyle(passed, failed, errored, skipped);
  const badgeText = encodeURIComponent(`${passed} passed, ${failed} failed, ${errored} errored, ${skipped} skipped`);

  const lines = [];
  lines.push(`## Overview`);
  lines.push(`![${badgeStyle.alt}](https://img.shields.io/badge/tests-${badgeText}-${badgeStyle.badge})`);

  const groups = {};
  reports.forEach((report, index) => {
    const title = report.journeyTitle || 'Other';
    if (!groups[title]) {
      groups[title] = [];
    }
    groups[title].push({ report, index });
  });

  for (const [title, groupReports] of Object.entries(groups)) {
    lines.push('');
    lines.push(`**${title}**`);
    lines.push('|Test Case|Passed|Failed|Errored|Skipped|Pass %|Time|');
    lines.push('|:---|---:|---:|---:|---:|---:|---:|');

    groupReports.forEach(({ report, index }) => {
      lines.push(
        `|[${report.displayName}](#user-content-r${index})|${report.passed}|${report.failed}|${report.errored}|${report.skipped}|${report.passPercent}|${report.duration}|`
      );
    });
  }

  return lines.join('\n');
}

function classifyFailureFromMetadata(testMeta = {}) {
  if (testMeta.success) {
    return { failed: 0, errored: 0 };
  }

  if (isTestFailed(testMeta)) {
    return { failed: 1, errored: 0 };
  }

  if (isErrorResult(testMeta)) {
    return { failed: 0, errored: 1 };
  }

  return { failed: 0, errored: 1 };
}

function getMetadataFailureMessage(testMeta = {}) {
  if (testMeta.success) {
    return null;
  }

  if (isTestFailed(testMeta)) {
    return null;
  }

  const failureType = testMeta.failureType || ERROR_TYPES.UNKNOWN_ERROR;
  const message = testMeta.error || resolveFailureMessage(failureType, { exitCode: testMeta.exitCode });

  return `${failureType}: ${message}`;
}

async function loadReports(outputDir) {
  const metadataPath = path.join(outputDir, 'metadata.json');
  let metadata;

  try {
    const content = await fs.readFile(metadataPath, 'utf8');
    metadata = JSON.parse(content);
  } catch (err) {
    console.warn(`Could not read or parse metadata.json at ${metadataPath}: ${err.message}`);
    return [];
  }

  const reports = [];

  for (const testMeta of (metadata.tests || [])) {
    const fallbackSummary = classifyFailureFromMetadata(testMeta);
    const report = {
      path: testMeta.rawOutputFile,
      journeyTitle: testMeta.journeyTitle || 'Unnamed Journey',
      displayName: testMeta.caseName || path.basename(testMeta.rawOutputFile || 'unknown'),
      description: testMeta.description || '',
      requests: [],
      passed: testMeta.success ? 1 : 0,
      failed: fallbackSummary.failed,
      errored: fallbackSummary.errored,
      skipped: 0,
      total: 1,
      duration: 'N/A',
      passPercent: testMeta.success ? '100.00' : '0.00',
      metadataFailure: getMetadataFailureMessage(testMeta) || null,
      parseError: null
    };

    try {
      if (testMeta.rawOutputFile) {
        const rawContent = await fs.readFile(testMeta.rawOutputFile, 'utf8');
        const testData = JSON.parse(rawContent);

        const requests = Array.isArray(testData.requests) ? testData.requests : [];
        const normalizedSummary = normalizeSummary(testData.summary);

        report.requests = requests;
        report.passed = normalizedSummary.passed;
        report.failed = normalizedSummary.failed;
        report.errored = normalizedSummary.errored;
        report.skipped = normalizedSummary.skipped;
        report.total = normalizedSummary.total;
        report.duration = getTotalDuration(requests);
        report.passPercent = getPassPercentage(normalizedSummary.passed, normalizedSummary.failed, normalizedSummary.errored);
      } else {
        report.parseError = 'No raw output file specified in metadata.';
      }
    } catch (err) {
      report.parseError = report.parseError 
        ? `${report.parseError} | Failed to load raw output: ${err.message}` 
        : `Failed to load raw output: ${err.message}`;
    }

    reports.push(report);
  }

  return reports;
}

function buildMarkdownSummary(reports) {
  const totals = reports.reduce(
    (acc, report) => {
      acc.passed += report.passed;
      acc.failed += report.failed;
      acc.errored += report.errored;
      acc.skipped += report.skipped;
      return acc;
    },
    { passed: 0, failed: 0, errored: 0, skipped: 0 }
  );

  const lines = [];
  lines.push('# httpYac Test Summary');
  lines.push('');
  lines.push(buildOverviewSection(reports, totals));
  lines.push('');

  const groupedReports = {};
  reports.forEach((report, index) => {
    const title = report.journeyTitle || 'Unnamed Journey';
    if (!groupedReports[title]) {
      groupedReports[title] = [];
    }
    groupedReports[title].push({ report, index });
  });

  for (const [title, journeyReports] of Object.entries(groupedReports)) {
    lines.push(`## ${title}`);

    journeyReports.forEach(({ report, index }) => {
      lines.push(buildReportSection(report, index));
      lines.push('');
    });
  }

  return lines.join('\n').trim() + '\n';
}

async function writeSummary(markdown, outputDir) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (summaryPath) {
    await fs.appendFile(summaryPath, `${markdown}\n`, 'utf8');
    return summaryPath;
  }

  const fallbackPath = path.join(outputDir, 'summary.md');
  await fs.writeFile(fallbackPath, markdown, 'utf8');
  return fallbackPath;
}

module.exports = {
  loadReports,
  buildMarkdownSummary,
  writeSummary
};
