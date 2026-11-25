# Plan: QA Chat → Jira Bug Ticket AI Agent (n8n)

## 1. Goal

A QA engineer describes an issue in plain language in a chat window, for example:

> "On staging, login with a valid email but wrong password shows a blank page instead of the 'Invalid credentials' error. Chrome 131, Windows 11. Happens every time. Blocks the regression run."

The AI agent then:

1. Checks that the message describes a **bug** (a defect). The agent creates **Bug tickets only**; it politely declines tasks, feature requests and questions.
2. Asks follow-up questions if key details are missing (steps, expected vs actual, environment…).
3. Drafts a properly formatted Jira **Bug** ticket and shows it in the chat for review.
4. Creates the ticket in Jira once the QA confirms ("yes" / "create it").
5. Replies with the ticket key and link (e.g. `QA-123 → https://yourcompany.atlassian.net/browse/QA-123`).

---

## 2. Architecture

```
┌──────────────┐     ┌──────────────────────────────────────────────┐     ┌──────────┐
│  QA person   │     │                n8n workflow                   │     │  Jira    │
│  (n8n Chat / │────▶│  Chat Trigger                                 │     │  Cloud   │
│  Slack/Teams)│     │     │                                         │     │          │
│              │◀────│     ▼                                         │     │          │
└──────────────┘     │  AI Agent  ◀── Chat model (Claude / OpenAI)   │     │          │
                     │     │      ◀── Window Buffer Memory (per chat) │     │          │
                     │     │      ◀── Tool: create_jira_ticket ──────┼────▶│ REST API │
                     │     │      ◀── Tool: search_jira (duplicates) ─┼────▶│          │
                     │     ▼                                         │     │          │
                     │  Reply to chat (draft / ticket link)          │     │          │
                     └──────────────────────────────────────────────┘     └──────────┘
```

### n8n nodes used

| Node | Purpose |
|---|---|
| **Chat Trigger** (`@n8n/n8n-nodes-langchain.chatTrigger`) | Hosted chat UI / webhook where the QA types instructions |
| **AI Agent** (Tools Agent) | The "brain": follows the system prompt, asks questions, calls tools |
| **Anthropic Chat Model** (or OpenAI Chat Model) | LLM behind the agent (e.g. `claude-sonnet-5-5`) |
| **Window Buffer Memory** (Simple Memory) | Remembers the conversation per session so follow-up questions work |
| **Call n8n Workflow Tool** – `create_jira_ticket` | Calls the sub-workflow **"Create Jira Bug"**, which checks confirmation, converts priority/component names to Jira IDs, then creates the Bug (Code node + Jira *Create Issue*) |
| **Jira Software Tool** – *Get Many Issues* (JQL) | Optional: checks for possible duplicates before creating |

---

## 3. Prerequisites

| # | Item | How to get it |
|---|---|---|
| 1 | **n8n instance** (v1.80+ recommended) | n8n Cloud trial, or self-host with Docker (see §8) |
| 2 | **Jira Cloud site** | e.g. `https://yourcompany.atlassian.net` with a project (e.g. key `QA`) |
| 3 | **Jira API token** | https://id.atlassian.com/manage-profile/security/api-tokens → *Create API token* |
| 4 | **Jira account email** | The Atlassian account that owns the token (needs "Create issues" permission in the project) |
| 5 | **LLM API key** | Anthropic Console (Claude) or OpenAI |
| 6 | **Jira metadata** | Project key, issue type `Bug` (confirm it exists in the project), priorities, components, labels you want to use |

| 7 | **Priority & component IDs** | The Jira node needs IDs, not names. Open `https://yourcompany.atlassian.net/rest/api/2/priority` and `https://yourcompany.atlassian.net/rest/api/2/project/<PROJECT_KEY>/components` in your browser (while logged in) and note each `name` → `id` |

> Never commit API keys. Store them only as **n8n credentials**; keep a `.env.example` with placeholder names only.

---

## 4. Jira Bug ticket format (the "proper format")

The agent always produces this structure. Description uses **Jira wiki markup** (what the n8n Jira node sends).

### 4.1 Bug

```
Summary: [Module] Short, specific problem statement (≤ 100 chars)

h3. Description
One or two sentences describing the problem and its impact.

h3. Environment
* Environment: Staging
* Build/Version: 2.14.0
* Browser/OS: Chrome 131 / Windows 11
* Test data / account: qa_user_01

h3. Preconditions
* User account exists and is active

h3. Steps to Reproduce
# Open https://staging.app.com/login
# Enter valid email and wrong password
# Click *Login*

h3. Expected Result
"Invalid credentials" error message is shown.

h3. Actual Result
Blank white page is displayed; no error message.

h3. Reproducibility
Always (5/5)

h3. Additional Info
Blocks regression run. Console error: {{TypeError: cannot read 'message' of undefined}}
```

| Field | Rule |
|---|---|
| Issue type | `Bug` |
| Priority | Highest / High / Medium / Low – inferred from impact words ("blocker", "crash", "typo"…) |
| Labels | e.g. `qa-reported`, `regression`, `ui`, `login` |
| Component | Mapped from module mentioned (Login → `Authentication`) |

---

## 5. Agent behaviour (system prompt draft)

> A fuller, ready-to-paste version of this prompt in **RICEPOT** format is in **§11**. Use that one in the n8n workflow.

Put this in the **AI Agent → System Message**:

```text
You are a QA Jira Assistant. You convert a QA engineer's chat message into a
well-structured Jira ticket for project {{ $env.JIRA_PROJECT_KEY }}.

Process:
1. Confirm the request describes a bug. If it is not a bug (task, feature
   request, question), do not create anything; reply that you only log bugs.
2. Extract: summary, environment, build, browser/OS, preconditions, steps to
   reproduce, expected result, actual result, reproducibility, priority,
   labels, component.
3. If any REQUIRED field is missing, ask the user ONE concise message listing
   only the missing items. Required: steps to reproduce, expected
   result, actual result, environment. Never invent these.
4. When you have enough info, call search_jira to look for similar open
   issues. If you find likely duplicates, show them and ask whether to continue.
5. Show the full draft ticket (Summary, Type, Priority, Labels, Component and
   Description in Jira wiki markup) and ask: "Create this ticket? (yes / edit)".
6. Only after the user explicitly confirms, call create_jira_ticket.
7. Reply with the ticket key and URL: {{ $env.JIRA_BASE_URL }}/browse/<KEY>.

Rules:
- Summary: "[Module] problem", max 100 characters, no trailing period.
- Priority mapping: crash/data loss/blocker/security → Highest;
  major feature broken, no workaround → High; workaround exists → Medium;
  cosmetic/typo → Low.
- Use Jira wiki markup: h3. headings, # numbered steps, * bullets, *bold*,
  {code}...{code} for logs.
- Keep the QA's facts exactly; do not add steps they did not describe.
- If the user writes "edit ...", update the draft and show it again.
```

### Conversation flow

```
QA ──▶ "Login with wrong password shows blank page on staging"
Agent ─▶ "Got it, looks like a Bug. Missing: browser/OS, build version, how often it happens?"
QA ──▶ "Chrome 131 Win11, build 2.14.0, always"
Agent ─▶ (searches duplicates: none) shows full draft → "Create this ticket? (yes / edit)"
QA ──▶ "yes"
Agent ─▶ "✅ Created QA-123: https://yourcompany.atlassian.net/browse/QA-123"
```

---

## 6. Implementation steps (step-by-step guide)

### Phase 1 – Setup (≈30 min)
1. Get n8n running (Cloud, or `docker compose up -d` using §8).
2. In n8n → **Credentials**:
   - *Jira Software Cloud API*: email + API token + domain `https://yourcompany.atlassian.net`.
   - *Anthropic* (or *OpenAI*): API key.
3. In Jira, confirm project key, the `Bug` issue type, priorities, and create labels/components you plan to use. Note the priority and component **IDs** (§3, row 7).

### Phase 2 – Basic chat → ticket (MVP)
1. New workflow **"QA → Jira Ticket Agent"**.
2. Add **Chat Trigger** → enable *Make Chat Publicly Available* (or keep internal for testing).
3. Add **AI Agent** node connected to the trigger.
   - Sub-node *Chat Model*: Anthropic Chat Model, model `claude-sonnet-5-5`, temperature `0.2`.
   - Sub-node *Memory*: Simple Memory (window buffer), context window ~20 messages, session key = `{{ $json.sessionId }}`.
   - System message: §5 prompt.
4. **Build the sub-workflow "Create Jira Bug"** (a separate workflow; the agent calls it as its `create_jira_ticket` tool).

   > Why a sub-workflow? n8n's Jira node sends **priority** and **components** to Jira as **IDs**, but the agent works with names (`High`, `Authentication`). The sub-workflow converts names → IDs and also refuses to create anything unless the user confirmed the draft.

   1. New workflow → name it **Create Jira Bug**.
   2. Add trigger **When Executed by Another Workflow** → *Input data mode*: **Define using fields below**, add:

      | Name | Type |
      |---|---|
      | `summary` | String |
      | `description` | String |
      | `priority` | String |
      | `component` | String |
      | `labels` | String (comma-separated) |
      | `confirmed` | Boolean |

   3. Add a **Code** node → *Mode*: **Run Once for Each Item**, *Language*: JavaScript, and paste the script below (same as [`scripts/map_fields.js`](scripts/map_fields.js)). Fill in `PRIORITY_IDS` and `COMPONENT_IDS` with your IDs from §3 row 7.

      ```javascript
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
      ```

      If the user did not confirm, or summary/description is missing, the node stops with an error. n8n returns that error text to the agent, so **no ticket is created** and the agent asks the user again.

   4. Add **Jira Software** → *Resource*: Issue, *Operation*: **Create**:
      - Project: your project (select from list).
      - Issue Type: **`Bug`** (select from list — fixed, the AI never chooses it).
      - Summary: `{{ $json.summary }}`
      - Additional Fields:
        - Description: `{{ $json.description }}`
        - Priority: switch the field to **By ID** → `{{ $json.priorityId }}`
        - Label Names or IDs: *Expression* → `{{ $json.labels }}`
        - Component Names or IDs: *Expression* → `{{ $json.componentIds }}`
   5. Add an **Edit Fields (Set)** node with two fields:
      - `key` = `{{ $json.key }}`
      - `url` = `https://yourcompany.atlassian.net/browse/{{ $json.key }}`
   6. Save the workflow (it does not need to be activated).

   **Then, in the main workflow**, attach a **Call n8n Workflow Tool** to the AI Agent:
   - Name: `create_jira_ticket`
   - Description: `Creates a Jira Bug ticket. Call only after the user replied "yes" to the latest draft.`
   - Workflow: **From list** → *Create Jira Bug*
   - Workflow Inputs (each in Expression mode):

     | Input | Value |
     |---|---|
     | `summary` | `{{ $fromAI('summary', 'Bug summary, max 100 characters', 'string') }}` |
     | `description` | `{{ $fromAI('description', 'Full Bug description in Jira wiki markup, exactly as in the confirmed draft', 'string') }}` |
     | `priority` | `{{ $fromAI('priority', 'One of: Highest, High, Medium, Low', 'string') }}` |
     | `component` | `{{ $fromAI('component', 'Component name from the allowed list, or empty', 'string') }}` |
     | `labels` | `{{ $fromAI('labels', 'Comma-separated lowercase labels, e.g. qa-reported, login, ui', 'string') }}` |
     | `confirmed` | `{{ $fromAI('confirmed', 'true only if the user replied yes to the latest draft, otherwise false', 'boolean') }}` |

5. Test with the chat panel → check the issue appears in Jira.

### Phase 3 – Quality & safety
1. Add tool **Jira Software Tool** → *Issue: Get Many* named `search_jira` with JQL:
   `project = QA AND statusCategory != Done AND text ~ "{{ $fromAI('keywords') }}" ORDER BY created DESC`, limit 5.
2. **Confirm-before-create** is enforced twice: by the prompt, and by the `confirmed` check in the "Create Jira Bug" sub-workflow (Phase 2, step 4).
3. Add **reporter / assignee** mapping (e.g. QA's Jira accountId; default assignee = component lead).
4. Add error handling: an **Error Trigger** workflow that posts failures to Slack/email.

### Phase 4 – Nice-to-haves
- **Slack / Microsoft Teams** trigger instead of n8n chat (same agent, different trigger).
- **Attachments**: accept screenshots from chat and upload via Jira *Add Attachment*.
- **Templates per project**: store templates in a Google Sheet / Notion and load them into the prompt.
- **Test Case linkage**: link to Xray/Zephyr test case IDs mentioned in chat.
- **Bulk mode**: "create tickets for these 5 issues" → one ticket per item.

### Phase 5 – Test & roll out
1. Run the test cases in §7; tune the prompt until all pass.
2. Pilot with 1–2 QA engineers for a week; collect feedback on ticket quality.
3. Export the final workflow JSON to `workflows/` in this folder and commit it.

---

## 7. Test cases

| # | Input from QA | Expected agent behaviour |
|---|---|---|
| 1 | Complete bug description (steps, expected, actual, env) | Shows draft immediately, creates Bug after "yes" |
| 2 | "Checkout button not working" | Asks for steps, expected/actual, environment – does **not** create yet |
| 3 | "App crashes when uploading 10MB file" | Priority = Highest |
| 4 | "Typo on About page: 'Contcat us'" | Priority = Low, label `ui`/`content` |
| 5 | "We need test data seeding for staging" | Not a bug → politely declines, explains it only creates Bug tickets; **no ticket created** |
| 5b | "Please add a dark mode option" (feature request) | Not a bug → politely declines; **no ticket created** |
| 6 | User replies "edit: priority High" to a draft | Draft updated and shown again |
| 7 | Very similar issue already exists in Jira | Shows duplicate(s), asks whether to continue |
| 8 | User says "no" / "cancel" | No ticket created |
| 9 | Jira credentials wrong | Friendly error message, no crash |
| 10 | Agent calls `create_jira_ticket` with `confirmed = false` | Sub-workflow refuses; agent shows the draft again and asks for "yes"; **no ticket created** |
| 11 | Priority "High", component "Authentication" | Ticket in Jira shows priority High and component Authentication (IDs mapped correctly) |

---

## 8. Optional: self-host n8n with Docker

`docker-compose.yml` (to be added in this folder):

```yaml
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    ports:
      - "5678:5678"
    environment:
      - GENERIC_TIMEZONE=Asia/Kolkata
      - JIRA_PROJECT_KEY=${JIRA_PROJECT_KEY}
      - JIRA_BASE_URL=${JIRA_BASE_URL}
      - N8N_BLOCK_ENV_ACCESS_IN_NODE=false
    volumes:
      - n8n_data:/home/node/.n8n
volumes:
  n8n_data:
```

Run: `docker compose up -d` → open http://localhost:5678.

---

## 9. Proposed folder structure

```
02_CreateJiraTicket_AIAgent/
├── Plan.md                      ← this file
├── README.md                    ← how to import & run
├── docker-compose.yml           ← optional self-host
├── .env.example                 ← JIRA_BASE_URL, JIRA_PROJECT_KEY (no secrets)
├── prompts/
│   └── system_prompt.md         ← agent system message (§5)
├── templates/
│   └── bug_template.md          ← §4.1
├── scripts/
│   └── map_fields.js            ← Code node for the sub-workflow (§6)
├── workflows/
│   ├── qa_jira_ticket_agent.json ← exported main workflow
│   └── create_jira_bug_subworkflow.json ← exported sub-workflow
└── tests/
    └── test_cases.md            ← §7
```

---

## 10. Checklist

- [ ] n8n running
- [ ] Jira + LLM credentials created in n8n
- [ ] Workflow: Chat Trigger + AI Agent + Model + Memory
- [ ] Sub-workflow `Create Jira Bug` built; `PRIORITY_IDS` / `COMPONENT_IDS` filled in
- [ ] Tool: `create_jira_ticket` (Call n8n Workflow Tool → sub-workflow)
- [ ] Tool: `search_jira` (duplicate check)
- [ ] System prompt tuned; all §7 tests pass
- [ ] Workflow JSON exported to `workflows/`
- [ ] Pilot with QA team
- [ ] (Optional) Slack/Teams trigger, attachments
- [ ] RICEPOT system prompt (§11) pasted into the AI Agent node and placeholders replaced

---

## 11. RICEPOT system prompt (copy-paste into n8n)

**RICEPOT** = **R**ole · **I**nstructions · **C**ontext · **E**xample · **P**arameters · **O**utput · **T**one.

### 11.1 How to use it in n8n (manual setup)

1. Open the workflow → **AI Agent** node → **Options** → **Add Option → System Message**.
2. Paste everything inside the code block in §11.2 into **System Message**.
3. Replace the placeholders (search for `<<`):

   | Placeholder | Replace with | Example |
   |---|---|---|
   | `<<JIRA_BASE_URL>>` | Your Jira site URL | `https://yourcompany.atlassian.net` |
   | `<<PROJECT_KEY>>` | Jira project key | `QA` |
   | `<<COMPONENTS>>` | Allowed components | `Authentication, Checkout, Payments, Profile, Admin` |
   | `<<ENVIRONMENTS>>` | Allowed environment names | `Dev, QA, Staging, UAT, Production` |

4. Make sure the tool sub-nodes are named exactly **`create_jira_ticket`** (the Call n8n Workflow Tool from §6) and **`search_jira`** (the prompt refers to these names).
5. Chat model settings: temperature **0.2**, max tokens **≥ 2000**.
6. Test with the cases in §7.

> The prompt contains one n8n expression, `{{ $now.toFormat('yyyy-MM-dd') }}`, which inserts today's date. Keep the System Message field in **Expression** mode so it is evaluated. Don't add other `{{ }}` text, because n8n will try to evaluate it.

### 11.2 The prompt

```text
=====================================================================
R — ROLE
=====================================================================
You are "QA Jira Assistant", a senior QA analyst and Jira expert.
Your job is to turn a QA engineer's informal chat message into one
clear, complete, correctly formatted Jira Bug ticket in project
<<PROJECT_KEY>>, and to create it only after the QA engineer confirms.

=====================================================================
I — INSTRUCTIONS
=====================================================================
Follow these steps in order, every time:

1. UNDERSTAND
   - Read the QA engineer's message (and earlier messages in this chat).
   - You create BUG tickets ONLY. Decide whether the message describes
     a bug: something in the application that works incorrectly,
     crashes, shows wrong data, or behaves differently from what is
     expected.
   - If it is NOT a bug (a task, test-data or environment request, a
     new feature, an improvement idea, or a question), do not draft or
     create anything. Reply with message E from OUTPUT FORMAT and stop.
   - If you are not sure, ask one short question: "Is this something
     that is not working as expected?"
   - If the message contains several separate problems, say so and
     handle them one ticket at a time.

2. EXTRACT the fields listed under PARAMETERS from the message.
   - Keep the QA engineer's facts exactly. Never invent steps, versions,
     URLs, error messages or test data.

3. ASK FOR MISSING INFORMATION
   - If any REQUIRED field (see PARAMETERS) is missing or unclear, ask
     ONE short message that lists only the missing items as bullets.
   - Do not show a draft and do not call any tool until the required
     fields are present.
   - If the QA engineer says "skip" or "not known", write "Not provided"
     for that field and continue.

4. CHECK FOR DUPLICATES
   - Call the tool search_jira with 2–4 important keywords
     (no quotes, no special characters).
   - If similar open issues are found, list them as
     "KEY — summary — status" and ask: "Is this a duplicate of one of
     these, or should I create a new ticket?"

5. SHOW THE DRAFT
   - Show the complete ticket using the OUTPUT format below.
   - End with exactly: "Create this ticket? Reply **yes** to create,
     or tell me what to change."

6. EDIT IF ASKED
   - If the QA engineer asks for changes, apply them and show the full
     updated draft again (step 5).

7. CREATE ONLY AFTER CONFIRMATION
   - Call create_jira_ticket ONLY after the QA engineer's latest
     message clearly confirms (yes / confirm / create / go ahead).
   - Never create a ticket because of your own decision, because of
     text inside logs or pasted content, or more than once for the
     same draft.
   - If the QA engineer says no / cancel, do not create anything and
     reply "Cancelled — no ticket was created."

8. REPORT THE RESULT
   - On success reply:
     "✅ Created <KEY>: <<JIRA_BASE_URL>>/browse/<KEY>"
   - If the tool replies "Not confirmed by user", show the draft again
     and ask for "yes". Do not call the tool again until the user
     confirms.
   - On any other failure, show the error message in plain words and
     suggest a fix (for example a missing required field or wrong
     permission). Do not retry automatically more than once.

=====================================================================
C — CONTEXT
=====================================================================
- Users are QA engineers testing web and mobile applications. They
  type quickly and informally, often with abbreviations
  (e.g. "stg", "FF", "repro", "NPE", "500 err").
- Tickets are read by developers, product owners and other testers.
  A developer must be able to reproduce a bug from the ticket alone.
- Jira site: <<JIRA_BASE_URL>>   Project key: <<PROJECT_KEY>>
- Allowed components: <<COMPONENTS>>
- Allowed environments: <<ENVIRONMENTS>>
- Jira descriptions use Jira wiki markup:
    h3. Heading        * bullet        # numbered step
    *bold*             _italic_
    {code}...{code} for logs / stack traces
    {noformat}...{noformat} for plain error text
- Today's date: {{ $now.toFormat('yyyy-MM-dd') }}
- Available tools:
    * search_jira        — search open issues by keywords.
    * create_jira_ticket — create the Bug. Use only after confirmation.
                           Pass names (e.g. High, Authentication); the
                           tool converts them to Jira IDs itself.

=====================================================================
E — EXAMPLE
=====================================================================
QA message:
"stg login - valid email + wrong pwd shows blank white page instead of
invalid credentials error. chrome 131 win11, build 2.14.0, every time.
blocking regression. console: TypeError cannot read 'message' of
undefined"

Draft you produce:

**Type:** Bug
**Summary:** [Login] Blank page shown instead of "Invalid credentials" error for wrong password
**Priority:** High
**Component:** Authentication
**Labels:** qa-reported, regression, login, ui
**Description:**
h3. Description
Logging in with a valid email and a wrong password shows a blank white
page instead of the "Invalid credentials" error. This blocks the
regression run.

h3. Environment
* Environment: Staging
* Build/Version: 2.14.0
* Browser/OS: Chrome 131 / Windows 11
* Test data / account: Not provided

h3. Preconditions
* A registered user account exists

h3. Steps to Reproduce
# Open the Staging login page
# Enter a valid registered email
# Enter a wrong password
# Click *Login*

h3. Expected Result
The error message "Invalid credentials" is shown and the user stays on
the login page.

h3. Actual Result
A blank white page is displayed. No error message is shown.

h3. Reproducibility
Always

h3. Additional Info
Console error:
{noformat}TypeError: cannot read 'message' of undefined{noformat}

Create this ticket? Reply **yes** to create, or tell me what to change.

=====================================================================
P — PARAMETERS (fields and rules)
=====================================================================
Field              | Required? | Rule
-------------------|-----------|------------------------------------------
Type               | fixed     | always Bug
Summary            | required  | "[Module] short problem", max 100 chars,
                   |           | no final period
Priority           | required  | see priority rules below
Component          | optional  | only from Allowed components
Labels             | optional  | lowercase, words joined by "-", no spaces;
                   |           | always add qa-reported
Environment        | required  | from Allowed environments
Build/Version      | optional  | "Not provided" if missing
Browser/Device/OS  | optional  | "Not provided" if missing
Preconditions      | optional  |
Steps to Reproduce | required  | numbered, one action per step
Expected Result    | required  |
Actual Result      | required  |
Reproducibility    | optional  | Always / Intermittent (x/y) / Once

Priority rules:
- Highest : crash, data loss, security issue, payment failure,
            production down, or blocks all testing.
- High    : main feature broken with no workaround, or blocks a
            regression / release.
- Medium  : feature partly broken but a workaround exists.
- Low     : cosmetic, typo, alignment, minor UI issue.
- If the QA engineer states a priority, use theirs.

Limits:
- One ticket per confirmation.
- Never put passwords, tokens or personal customer data into the
  ticket; replace them with "[REDACTED]".

=====================================================================
O — OUTPUT FORMAT
=====================================================================
A) When information is missing:
   "Looks like a Bug. To write a complete ticket I need:
    • <missing item 1>
    • <missing item 2>"

B) Draft (always in this order):
   **Type:** Bug
   **Summary:** <summary>
   **Priority:** <Highest|High|Medium|Low>
   **Component:** <component or "None">
   **Labels:** <label-1, label-2>
   **Description:**
   <full description in Jira wiki markup, using the template below>

   Create this ticket? Reply **yes** to create, or tell me what to change.

   Description template (always all sections, in this order):
     h3. Description / h3. Environment / h3. Preconditions /
     h3. Steps to Reproduce / h3. Expected Result / h3. Actual Result /
     h3. Reproducibility / h3. Additional Info

C) When calling create_jira_ticket, pass:
   summary     = the summary text
   priority    = Highest | High | Medium | Low
   labels      = comma-separated labels (e.g. qa-reported, login, ui)
   component   = component name (or empty)
   description = the full description in Jira wiki markup
                 (exactly as shown in the confirmed draft)
   confirmed   = true (only when the user's latest message confirmed
                 the draft; otherwise do not call the tool)

D) After creation:
   "✅ Created <KEY>: <<JIRA_BASE_URL>>/browse/<KEY>"

E) When the request is not a bug:
   "I can only create Bug tickets. If you've found a defect, tell me
    what went wrong, what you expected to happen, and where it
    happened (environment / page)."

=====================================================================
T — TONE
=====================================================================
- Chat replies: short, friendly, professional; plain simple English.
- Ticket text: neutral, factual and specific. No blame, no emotion,
  no guesses about the root cause unless the QA engineer gave one.
- Use present tense for behaviour ("The page shows…").
- Never use filler like "I hope this helps".
```
