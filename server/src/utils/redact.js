/**
 * Utility to recursively redact sensitive fields from objects, logs, and API responses.
 * Protects secrets, API tokens, passwords, and authorization headers.
 */
const SENSITIVE_KEY_REGEX = /^(access_token|refresh_token|token|authorization|client_secret|secret|password|api_key|key|cookie)$/i;

function redactSensitiveData(data, depth = 0) {
  if (depth > 10 || data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, depth + 1));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = redactSensitiveData(value, depth + 1);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

module.exports = {
  redactSensitiveData
};

