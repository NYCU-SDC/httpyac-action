const ERROR_TYPES = Object.freeze({
  PROCESS_ERROR: 'PROCESS_ERROR',
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  TEST_FAILED: 'TEST_FAILED',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  ACTION_ERROR: 'ACTION_ERROR'
});

const FAILURE_MESSAGES = Object.freeze({
  PROCESS_ERROR: 'Failed to execute httpyac process.',
  EXECUTION_ERROR: 'Unexpected error during httpyac execution.',
  TEST_FAILED: 'httpyac test failed.',
  UNKNOWN_ERROR: 'httpyac exited with unexpected code.',
  ACTION_ERROR: 'Action failed before test result could be classified.'
});

function resolveFailureMessage(failureType, context = {}) {
  switch (failureType) {
    case ERROR_TYPES.PROCESS_ERROR:
      return context.processErrorMessage || FAILURE_MESSAGES.PROCESS_ERROR;
    case ERROR_TYPES.EXECUTION_ERROR:
      return FAILURE_MESSAGES.EXECUTION_ERROR;
    case ERROR_TYPES.TEST_FAILED:
      return FAILURE_MESSAGES.TEST_FAILED;
    case ERROR_TYPES.ACTION_ERROR:
      return context.actionErrorMessage || FAILURE_MESSAGES.ACTION_ERROR;
    default:
      return FAILURE_MESSAGES.UNKNOWN_ERROR;
  }
}

function isTestFailed(result) {
  return Boolean(result && !result.success && result.failureType === ERROR_TYPES.TEST_FAILED);
}

function isErrorResult(result) {
  return Boolean(result && !result.success && !isTestFailed(result));
}

module.exports = {
  ERROR_TYPES,
  FAILURE_MESSAGES,
  resolveFailureMessage,
  isTestFailed,
  isErrorResult
};