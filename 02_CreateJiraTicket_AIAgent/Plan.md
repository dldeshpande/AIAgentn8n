# Plan: QA Chat → Jira Ticket AI Agent (n8n)

## 1. Goal

A QA engineer describes an issue in plain language in a chat window, for example:

> "On staging, login with a valid email but wrong password shows a blank page instead of the 'Invalid credentials' error. Chrome 131, Windows 11. Happens every time. Blocks the regression run."

The AI agent then:

1. Understands the message and works out the ticket type (Bug / Task / Story).
2. Asks follow-up questions if key details are missing (steps, expected vs actual, environment…).
3. Drafts a properly formatted Jira ticket and shows it in the chat for review.
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
| **Jira Software Tool** – *Create Issue* | Creates the ticket (exposed to the agent as a tool) |
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
| 6 | **Jira metadata** | Project key, issue types (Bug/Task/Story), priorities, components, labels you want to use |

> Never commit API keys. Store them only as **n8n credentials**; keep a `.env.example` with placeholder names only.

---

## 4. Jira ticket format (the "proper format")

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

### 4.2 Task / Story (non-bug requests from QA)

```
Summary: Short action-oriented title

h3. Description / User Story
As a <role>, I want <goal> so that <benefit>.

h3. Acceptance Criteria
# Given … When … Then …
# …

h3. Notes
…
```

---

## 5. Agent behaviour (system prompt draft)

Put this in the **AI Agent → System Message**:

```text
You are a QA Jira Assistant. You convert a QA engineer's chat message into a
well-structured Jira ticket for project {{ $env.JIRA_PROJECT_KEY }}.

Process:
1. Classify the request as Bug, Task or Story.
2. Extract: summary, environment, build, browser/OS, preconditions, steps to
   reproduce, expected result, actual result, reproducibility, priority,
   labels, component.
3. If any REQUIRED field is missing, ask the user ONE concise message listing
   only the missing items. Required for Bug: steps to reproduce, expected
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
3. In Jira, confirm project key, issue types, priorities, and create labels/components you plan to use.

### Phase 2 – Basic chat → ticket (MVP)
1. New workflow **"QA → Jira Ticket Agent"**.
2. Add **Chat Trigger** → enable *Make Chat Publicly Available* (or keep internal for testing).
3. Add **AI Agent** node connected to the trigger.
   - Sub-node *Chat Model*: Anthropic Chat Model, model `claude-sonnet-5-5`, temperature `0.2`.
   - Sub-node *Memory*: Simple Memory (window buffer), context window ~20 messages, session key = `{{ $json.sessionId }}`.
   - System message: §5 prompt.
4. Add tool **Jira Software Tool** → *Issue: Create*, name it `create_jira_ticket`:
   - Project: your project (fixed).
   - Issue Type: `{{ $fromAI('issueType', 'Bug, Task or Story') }}`
   - Summary: `{{ $fromAI('summary', 'ticket summary, max 100 chars') }}`
   - Additional Fields → Description: `{{ $fromAI('description', 'full description in Jira wiki markup') }}`
   - Priority: `{{ $fromAI('priority', 'Highest, High, Medium or Low') }}`
   - Labels: `{{ $fromAI('labels', 'comma separated labels') }}`
5. Test with the chat panel → check the issue appears in Jira.

### Phase 3 – Quality & safety
1. Add tool **Jira Software Tool** → *Issue: Get Many* named `search_jira` with JQL:
   `project = QA AND statusCategory != Done AND text ~ "{{ $fromAI('keywords') }}" ORDER BY created DESC`, limit 5.
2. Enforce the **confirm-before-create** rule (already in prompt). Optionally add a guard: a Code/IF node that only allows creation when the last user message contains "yes/confirm/create".
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
| 5 | "We need test data seeding for staging" | Classified as Task, not Bug |
| 6 | User replies "edit: priority High" to a draft | Draft updated and shown again |
| 7 | Very similar issue already exists in Jira | Shows duplicate(s), asks whether to continue |
| 8 | User says "no" / "cancel" | No ticket created |
| 9 | Jira credentials wrong | Friendly error message, no crash |

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
│   ├── bug_template.md          ← §4.1
│   └── story_task_template.md   ← §4.2
├── workflows/
│   └── qa_jira_ticket_agent.json ← exported n8n workflow
└── tests/
    └── test_cases.md            ← §7
```

---

## 10. Checklist

- [ ] n8n running
- [ ] Jira + LLM credentials created in n8n
- [ ] Workflow: Chat Trigger + AI Agent + Model + Memory
- [ ] Tool: `create_jira_ticket`
- [ ] Tool: `search_jira` (duplicate check)
- [ ] System prompt tuned; all §7 tests pass
- [ ] Workflow JSON exported to `workflows/`
- [ ] Pilot with QA team
- [ ] (Optional) Slack/Teams trigger, attachments
