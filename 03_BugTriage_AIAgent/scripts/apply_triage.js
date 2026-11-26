// n8n Code node — sub-workflow "Apply Bug Triage"
// Mode: "Run Once for Each Item"   Language: JavaScript
//
// Checks the user confirmed the triage, validates the values the AI agent
// sends, and builds the JSON body for the Jira "update issue" request
// (priority + Severity custom field). The risk comment is passed on to the
// "Add Comment" step.

// ---- 1. Fill these in for YOUR Jira site ---------------------------------
const JIRA_BASE_URL = 'https://yourcompany.atlassian.net';

// Severity custom field ID: open <JIRA_BASE_URL>/rest/api/2/field and find
// the field named "Severity" → copy its "id" (looks like customfield_10042).
const SEVERITY_FIELD_ID = 'customfield_XXXXX';

// Exact option names as they appear in Jira (case matters in Jira).
// Check them in <JIRA_BASE_URL>/rest/api/2/issue/<KEY>/editmeta
const ALLOWED_PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
const ALLOWED_SEVERITIES = ['Blocker', 'Critical', 'Major', 'Minor', 'Trivial'];
// ---------------------------------------------------------------------------

const input = $json;

// Returns the canonical name from the allowed list, or null.
const pick = (value, allowed) => {
  const v = String(value || '').trim().toLowerCase();
  return allowed.find((a) => a.toLowerCase() === v) || null;
};

// 2. Confirmation guard
const confirmed = input.confirmed === true || String(input.confirmed).toLowerCase() === 'true';
if (!confirmed) {
  throw new Error(
    'Not confirmed by user. Show the triage proposal again and ask the user to reply "yes" before updating Jira.',
  );
}

// 3. Issue key
const issueKey = String(input.issueKey || '').trim().toUpperCase();
if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(issueKey)) {
  throw new Error(`Invalid issue key "${input.issueKey}". Expected something like QA-123.`);
}

// 4. Priority and severity
const priority = pick(input.priority, ALLOWED_PRIORITIES);
if (!priority) {
  throw new Error(`Invalid priority "${input.priority}". Allowed: ${ALLOWED_PRIORITIES.join(', ')}.`);
}
const severity = pick(input.severity, ALLOWED_SEVERITIES);
if (!severity) {
  throw new Error(`Invalid severity "${input.severity}". Allowed: ${ALLOWED_SEVERITIES.join(', ')}.`);
}
if (SEVERITY_FIELD_ID === 'customfield_XXXXX') {
  throw new Error('SEVERITY_FIELD_ID is not set in the "Apply Bug Triage" Code node.');
}

// 5. Body for PUT /rest/api/2/issue/{issueKey}
const updateBody = {
  fields: {
    priority: { name: priority },
    [SEVERITY_FIELD_ID]: { value: severity },
  },
};

// 6. Risk comment (optional)
const riskComment = String(input.riskComment || '').trim();

return {
  json: {
    issueKey,
    priority,
    severity,
    reason: String(input.reason || '').trim(),
    updateBody,
    riskComment,
    hasRiskComment: riskComment.length > 0,
    url: `${JIRA_BASE_URL}/browse/${issueKey}`,
  },
};
