// n8n Code node — sub-workflow "Create Jira Bug"
// Mode: "Run Once for Each Item"   Language: JavaScript
//
// Converts the names the AI agent sends (priority, component, labels)
// into what the Jira node needs (IDs / list), and refuses to continue
// unless the user confirmed the draft.

// ---- 1. Fill these in for YOUR Jira site ---------------------------------
// Priority IDs:  open <<JIRA_BASE_URL>>/rest/api/2/priority in your browser
// (Jira Cloud defaults are shown below — check yours).
const PRIORITY_IDS = {
  highest: '1',
  high: '2',
  medium: '3',
  low: '4',
  lowest: '5',
};

// Component IDs: open
// <<JIRA_BASE_URL>>/rest/api/2/project/<<PROJECT_KEY>>/components
// and copy "name" → "id". Keys must be lowercase.
const COMPONENT_IDS = {
  // authentication: '10001',
  // checkout: '10002',
};
// ---------------------------------------------------------------------------

const input = $json;

// 2. Confirmation guard
const confirmed = input.confirmed === true || String(input.confirmed).toLowerCase() === 'true';
if (!confirmed) {
  throw new Error(
    'Not confirmed by user. Show the draft again and ask the user to reply "yes" before creating the ticket.',
  );
}

// 3. Required fields
const summary = String(input.summary || '').trim();
const description = String(input.description || '').trim();
if (!summary || !description) {
  throw new Error('Missing summary or description. Complete the draft before creating the ticket.');
}

// 4. Priority name -> ID (unknown -> Medium)
const priorityName = String(input.priority || '').trim().toLowerCase();
const priorityId = PRIORITY_IDS[priorityName] || PRIORITY_IDS.medium;
const priorityNote = PRIORITY_IDS[priorityName] ? '' : `Unknown priority "${input.priority}", used Medium.`;

// 5. Component name -> ID (unknown -> none)
const componentName = String(input.component || '').trim().toLowerCase();
const componentIds = COMPONENT_IDS[componentName] ? [COMPONENT_IDS[componentName]] : [];

// 6. Labels -> lowercase, hyphenated list, always with qa-reported
const rawLabels = Array.isArray(input.labels) ? input.labels : String(input.labels || '').split(',');
const labels = [
  ...new Set(
    ['qa-reported', ...rawLabels]
      .map((l) => String(l).trim().toLowerCase().replace(/\s+/g, '-'))
      .filter(Boolean),
  ),
];

return {
  json: {
    summary: summary.slice(0, 255),
    description,
    priorityId,
    componentIds,
    labels,
    note: priorityNote,
  },
};
