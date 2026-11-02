# 0022 — A running work log on a Jira issue

**Status:** Draft
**Package:** `packages/simply-atlassian-core` (log logic); `packages/simply-atlassian`
(`jira issue log`); `packages/simply-atlassian-mcp` (`jira_issue_log`, `--allow-log`)
**Date:** 2026-11-02

## Problem

An agent working a Jira issue only reports back on it when someone asks. The person running it
types "comment on the ticket" at each checkpoint, or forgets to, and everyone else reads a ticket
that says nothing until the work is done. When a comment does appear it rarely says what changed: a
reviewer learns that work happened, not which class was added or why a trigger was touched.

Every primitive exists: `jira_issue_comment_add`, `jira_issue_comment_edit`, and
`jira_issue_comment_list`. What is missing is everything that makes them usable as a habit:

- **One comment per checkpoint is noise.** Ten comments on a ticket bury the discussion in it.
- **Keeping one comment current is fiddly.** The agent has to find its comment, remember its id
  between sessions, read it, append, and write the whole body back in the shape the deployment
  expects.
- **Nothing tells the agent when.** The MCP server only acts when it is called, so "automatically"
  has to come from the agent's instructions or from the client.
- **Nothing tells the agent how much to say.** Without a shape, one update names every file and the
  next says "made progress".
- **The whole write surface is too much to grant for this.** Today the only way to let an agent
  comment is `--allow-writes`, which also hands it transitions and page updates.

## Decision

Add `jira issue log` and a matching `jira_issue_log` tool. Each call appends one timestamped entry
to a running comment per author per issue: a summary line, plus a bullet for each component created
or changed, saying what changed and why. Server instructions tell the agent which checkpoints to
log and what to name. A new server flag, `--allow-log`, registers this one write tool without the
rest.

Hooks that log mechanical events from the client are a later, separate change. The first version
is the command, the tool, the flag, and the instructions.

## Behavior

### The command

```text
simply atlassian jira issue log [ISSUE] --kind <kind> --text <text> [--detail <text>]...
  [--from-branch] [--dry-run]
```

| Input           | Rule                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `ISSUE`         | Issue key. Required unless `--from-branch` is given; giving both is an error.                           |
| `--kind`        | One of `started`, `commit`, `pr`, `ci`, `blocked`, `done`, `note`.                                      |
| `--text`        | The entry's summary. Plain text, one line, at most 500 characters. Longer text is an error, not a trim. |
| `--detail`      | One bullet. Repeatable, at most 15. Plain text, one line, at most 500 characters each.                  |
| `--from-branch` | Takes the key from the current git branch (below). CLI only.                                            |
| `--dry-run`     | Prints the entry and whether it would create or edit a comment. Sends nothing.                          |

The MCP tool takes `issue`, `kind`, `text`, `details` (an array), and `dryRun`. `issue` is required there: the server's
working directory is not reliably the repository, so the agent reads its own branch.

The body is plain text on purpose. There is no `--mention` and no raw `--body`, so a log entry cannot
@-mention anyone or carry a visibility restriction. Those remain `comment add`'s job.

### The comment

```text
Work log (simply-atlassian)
2026-11-02 14:10 UTC | started | Branch feat/PROJ-123-discount-approval
2026-11-02 15:02 UTC | commit | a1b2c3d Added discount approval on opportunities
- OpportunityDiscountService (new class): checks each discount against the approval limit
- OpportunityTrigger (updated): calls the service before update, so bulk edits are checked too
- OpportunityDiscountServiceTest (new test class): covers single and bulk updates
2026-11-02 17:40 UTC | pr | PR #58 opened, CI green
```

A `note` records what the diff cannot show, such as a change in requirements. The person running the
agent says what happened, and the agent writes it up:

```text
2026-11-03 14:20 UTC | note | Requirements changed after talking with John on Nov 2
- Discount limit now applies per region, not globally
- OpportunityDiscountService (updating): adding the regional limit check
```

The agent reads no conversations for this, so what reaches the ticket is what the person chose to
tell it.

Times are UTC, so a team across time zones reads one clock. Entries are plain text, so they read the
same on both deployments.

### Finding the comment

The log is the newest comment whose first line is exactly `Work log (simply-atlassian)` **and**
whose author is the current account (`/myself`). Comment pages are read newest first and stop at
the first match, so a long ticket costs little. The scan also notes whether it passed a comment by
someone else on the way.

The author check means the command never edits another person's comment, even one that copies the
heading. Two people on one issue each get their own log.

### Appending

| Situation                                          | Result                                                    |
| -------------------------------------------------- | --------------------------------------------------------- |
| No log yet                                         | Creates the comment.                                      |
| The log is the latest activity                     | Adds the entry and edits the comment.                     |
| Someone else has commented since the log           | Creates a new log comment; the old one stays as it is.    |
| Same `kind`, `text`, and details as the last entry | Does nothing and says so, so a repeated call is harmless. |
| The log's text would pass 16,000 characters        | Creates a new log comment; the old one stays as it is.    |

A log keeps its place in the thread when it is edited, so once people reply beneath it, later
entries would land above the discussion, where anyone reading the newest comments misses them.
Starting a new log at that point keeps updates at the bottom, and a ticket nobody is discussing
still has one comment. The agent's own other comments do not count.

The new entry is added to the comment body as Jira returned it: more paragraph nodes on Cloud, more
lines of the string on Server/DC. The body is never rebuilt from text, so anything a person
edited in the comment survives. A log that cannot be parsed in that shape is left alone, and a new
log comment is started.

16,000 sits well under Jira's default text limit of 32,767 characters, because Cloud's ADF body is
larger than the text it carries.

### Ticket from the branch

`--from-branch` runs `git branch --show-current` and looks for `[A-Za-z][A-Za-z0-9_]+-[0-9]+`,
upper-cased.

| Branch                          | Result                                             |
| ------------------------------- | -------------------------------------------------- |
| `feat/PROJ-123-retry-writes`    | `PROJ-123`                                         |
| `feat/proj-123-retry-writes`    | `PROJ-123`                                         |
| `main`, or no key               | Exit `0`, logs nothing, says why.                  |
| Two different keys              | Error listing both, rather than a guess.           |
| A false match such as `sha-256` | Jira answers `404`; reported as an ordinary error. |

A branch with no ticket is not a failure: it is the normal case for a hook that fires on every
commit.

### Errors

The log must never cost the work. The MCP instructions tell the agent to carry on after a failed
log call. Exit codes and MCP codes are otherwise the usual ones.

The edit is a `mutating` call, so 0017 applies: a `5xx` or a dropped connection is not retried and
reports that the change may have been applied. The agent is told not to repeat it, and the
same-as-last-entry rule makes one repeat harmless if it does.

### Secrets

The summary and every detail go through `redactSecrets` with the values from `collectSecrets` before it is sent, so a
configured token cannot reach the ticket. This catches known credentials only. It does not catch a
customer's name, an email address, or a credential the CLI was never given; see open questions.

### Access

| Server started with | `jira_issue_log` | Other write tools |
| ------------------- | ---------------- | ----------------- |
| neither flag        | no               | no                |
| `--allow-log`       | yes              | no                |
| `--allow-writes`    | yes              | yes               |

`ATLASSIAN_READ_ONLY` refuses the tool as it refuses any write, whichever flag was given.
`mcp install` gains `--allow-log`.

`--allow-log` narrows what the agent is offered through this server, not what the credential can do.
Anyone who needs a hard limit still sets it in Jira.

### Agent instructions

When the tool is registered, the server instructions gain:

> When you are working on a Jira issue, call `jira_issue_log` at each checkpoint without being
> asked: when you start, after a meaningful commit, when a PR opens, when CI finishes, when you are
> blocked, and when you are done. Write a one-line summary a teammate would find useful. At a commit
> or PR that changes behavior, and when you are done, add a detail for each class, trigger, or other
> component you created or changed: its name, whether it is new or updated, what changed, and why.
> Take these from the diff, in plain English. The done entry lists everything changed on the issue.
> When the user mentions a conversation or a change in requirements, add a note entry saying what
> changed and which components it affects; record the decision, not a quote. Include no code, customer data, or credentials. Not every small commit is a checkpoint. If the
> call fails, carry on with the work and do not repeat it.

They are not added otherwise, so an agent that cannot log is not told to.

## Alternatives considered

- **A new comment per checkpoint.** The simplest build, and it needs no find-and-edit step or
  race handling. Rejected: it is the noise this record sets out to remove.
- **A hidden marker to find the comment.** Plain-text bodies on Server/DC have nowhere to hide one.
  A visible heading works on both deployments and tells readers what the comment is.
- **A comment property holding the marker.** Survives a person editing the heading, but costs
  extra calls and a second code path. Worth revisiting only if edited headings prove common.
- **A worklog entry or a custom field.** Jira worklogs record time, not progress, and a field needs
  admin setup per project. A comment works on every issue with no configuration.
- **One line per checkpoint.** Shorter, and it was the first draft of this record. Rejected: it
  says that work happened, not which class or trigger changed or why, which is what a reviewer wants
  from the ticket.
- **One comment for the life of the issue.** Tidier, but entries end up above any replies. See
  Appending.
- **Hooks alone.** Reliable, but they only see mechanical events, so they can list changed files
  but cannot say why, or that the agent is blocked. They also differ per client. They are a good second layer.
- **Instructions alone, using the existing comment tools.** No code, but each session redoes the
  find-and-append by hand, and it still requires `--allow-writes`.
- **Reusing `.simply/atlassian.json` from 0020.** That is a sensible home for per-project log
  settings, but it is unmerged, and the first version has no settings.

## Related work

Searched on 2026-11-02 across the SimplySF repositories, open PRs, and issues. Nothing writes
progress back to a Jira issue.

- **`simply cicd notify` (`simply-plugins`, 0046).** Posts Teams cards from the pipeline about
  builds and deployments, listing the issue keys found in commits. It announces results to Teams
  and never writes to Jira. This record writes to the issue during the work, so the two complement
  each other.
- **`AlmProvider` (`simply-cicd-core`).** Recognises issue keys in commit messages. See the open
  question on `--from-branch`.
- **`simply gemini skills`.** Installs shared skills for Gemini CLI. See the open question on server
  instructions.
- **`jira work` (0020, #72, unmerged).** Shapes the issue before the work starts. This record covers
  what happens during it.

## Implementation plan

1. `simply-atlassian-core`: `appendWorkLog()` and the find, append, new-log, and rollover logic in a new
   `jira-work-log.ts`; export it from `index.ts`.
2. `simply-atlassian`: `commands/atlassian/jira/issue/log.ts`, with `--from-branch`.
3. `simply-atlassian-mcp`: a `jira_issue_log` tool in `tools.ts`, a `log` tool kind so `selectTools`
   can register it under `--allow-log`, instructions built per server in `server.ts`, and
   `--allow-log` on `mcp` and `mcp install`.
4. Guides and READMEs: enabling it, and what it does and does not protect.

## Testing

- Core: creates a log; appends an entry with details on Cloud (ADF) and Server/DC (string); preserves
  a person's edit; skips a repeated entry; starts a new log after someone else's comment but not
  after the author's own; rolls over at the limit; ignores another author's log with the same
  heading; finds the newest log across pages; refuses text that is too long and too many details;
  redacts a configured secret in the summary and in a detail.
- CLI: key extraction for each row of the branch table, including exit `0` with no key; `--dry-run`
  sends nothing.
- MCP: `selectTools` for each row of the access table; the instructions appear only with the tool;
  `ATLASSIAN_READ_ONLY` still refuses it.
- Live, on a Cloud site and a Server/DC instance: the full flow, whether watchers are notified by
  each edit, and where an edited comment sits among newer ones.

## Open questions

- **Do edits notify watchers?** Jira can treat an edited comment as an event. Cloud's comment update
  takes `notifyUsers`, which this should set to `false`, but Server/DC may have no equivalent. Must
  be checked on a real instance first: if every edit emails watchers on Data Center, a single
  comment saves less noise than this record claims. Decide before implementing.
- **Two sessions on one issue, same account.** Jira comments have no version check, so two appends
  at once can lose a line. Re-reading just before the write keeps the gap small. Accepted for a log,
  and the lost line is minor; revisit if it happens in practice.
- **Should the text pass a fuller guard?** `simply-teams` 0005 cleans emails, phone numbers, and
  card numbers. Porting that here would catch more than `redactSecrets`, at the cost of a sizeable
  dependency for one command. Clay to decide.
- **Do clients read server instructions?** Support varies by client and is untested for Gemini CLI
  on Windows, the team's target. If they are ignored, a shared skill installed with
  `simply gemini skills install` can carry the same rules, and a line in the project's `AGENTS.md`
  or `GEMINI.md` is the simpler fallback. The guide should give whichever works.
- **Should `--from-branch` match configured project keys?** `JiraProvider` in `simply-cicd-core`
  matches keys only against configured projects, which rules out false matches such as `sha-256`.
  This design has no configuration, so it accepts any key-shaped token and lets Jira answer `404`.
  Revisit if false matches prove common, or when per-project settings arrive.
- **Parity with `simply-gitlab`.** A merge request log could use the same design. Not in scope here.
