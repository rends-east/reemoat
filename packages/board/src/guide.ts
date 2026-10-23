// The whole reference for the agent that writes a person's board, served as board_guide. Every bound and list is the parser's own.
import {
  BOARD_FIELDS,
  BOARD_VERSION,
  COLUMN_ID,
  DEFAULT_BUDGET,
  DEFAULT_SEES,
  EXIT_NAME,
  LAST_RUN,
  MAX_BOARD_BYTES,
  MAX_BUDGET,
  MAX_CHOICE_CHARS,
  MAX_COLUMN_LIMIT,
  MAX_COLUMN_TITLE_CHARS,
  MAX_COLUMNS,
  MAX_DECIDE,
  MAX_EXIT_LABEL_CHARS,
  MAX_EXIT_MEANS_CHARS,
  MAX_EXITS,
  MAX_MACHINE_NAME_CHARS,
  MAX_MODEL_CHARS,
  MAX_ON_MACHINES,
  MAX_PROMPT_CHARS,
  MAX_ROLE_INSTRUCTIONS_CHARS,
  MAX_ROLES,
  MAX_SKILL_ARGS_CHARS,
  MIN_BUDGET,
  RESERVED_ROLES,
  ROLE_NAME,
  SEES,
  SHORTHAND_EXIT,
  SKILL_NAME,
  STAY,
  type Sees,
} from "./config.js";
import { NO_EXECUTOR_ASK_MS } from "./engine.js";
import { DEFAULT_BOARD_TEXT, REVIEW_LOOP_TEXT } from "./presets.js";
import { MAX_RULES, RULE_FACTS } from "./rules.js";
import { MAX_SIMULATED_EVENTS } from "./simulate.js";
import { RETURN_HINT, TEMPLATE_NAMES, type TemplateName } from "./template.js";
import {
  CLASSIFIER_TIMEOUT_MS,
  JUDGE_TIMEOUT_MS,
  MAX_JUDGE_INSTRUCTIONS_BYTES,
  MAX_JUDGE_PROMPT_BYTES,
  MAX_SEEN_DIFF_BYTES,
  MAX_SEEN_LAST_MESSAGE_BYTES,
} from "./verdict.js";

const FENCE = "```";
const code = (word: string): string => `\`${word}\``;
const codes = (words: readonly string[]): string => words.map(code).join(", ");
const pattern = (name: RegExp): string => code(name.source.replace(/^\^/, "").replace(/\$$/, ""));
const kib = (bytes: number): string => `${bytes / 1024} KiB`;
const hours = (ms: number): string => `${ms / (60 * 60 * 1000)} hours`;

type Level = keyof typeof BOARD_FIELDS;

const FIELD_WORDS: { [L in Level]: Record<(typeof BOARD_FIELDS)[L][number], string> } = {
  top: {
    version: `Required, and always ${code(`version: ${BOARD_VERSION}`)}: the version of this format, not of the board.`,
    intake:
      "The column new tasks land in, by id. Default: the first column that is not a view, which it may not be. A task created " +
      "in a work column gets no run until it is moved in again, so the intake is normally a waiting column.",
    budget:
      `How many automatic moves a task may make in a row before the person must act: a whole number from ${MIN_BUDGET} to ` +
      `${MAX_BUDGET}, default ${DEFAULT_BUDGET}. A move by ${code("self")}, rules, a role or a work column's only exit spends one; ` +
      "anything the person does on the task (a move, a comment, an edit, an answer) makes it whole again. Once it is spent the " +
      "person is asked instead, which is what stops two columns sending a task back and forth forever.",
    roles: "A map of role name to role; see Roles. Optional.",
    columns: `Required. A list of at least one and at most ${MAX_COLUMNS} columns, in the order the board draws them; see Columns.`,
  },
  role: {
    agent:
      `Required. What runs: a harness such as ${code("claude")} or ${code("codex")}, an assembled agent (its id, or its name in ` +
      `any case), or a plugin's classifier, which can only judge. ${code("agent@machine")} pins the role to one machine: ` +
      `${code("claude@server")} is ${code("{ agent: claude, on: [server] }")}.`,
    model:
      `A model, at most ${MAX_MODEL_CHARS} characters, picked from the agent's own model list by value or name, for its runs and ` +
      "its judging. One the agent does not offer leaves its default, and the task's history says so.",
    effort:
      `How hard the agent thinks: one of its own effort choices (such as ${code("high")}), by value or name in any case, at most ` +
      `${MAX_CHOICE_CHARS} characters. Set after the model, for its runs and its judging; one the agent does not offer leaves its ` +
      "own, and a run's history says so.",
    mode:
      `The mode its runs start in: one of the agent's own modes (such as ${code("plan")}), matched and bounded as ${code("effort")} ` +
      "is. Set at every run's start, a continued conversation's too. A mode that asks before acting waits on the person; one " +
      "that asks nothing runs the role unwatched.",
    instructions:
      `The person's standing words for the role, at most ${MAX_ROLE_INSTRUCTIONS_CHARS} characters: a lens, a standard, what to ` +
      `look for. Every run's note carries them whole, a continued conversation's too; a judging question, their first ` +
      `${kib(MAX_JUDGE_INSTRUCTIONS_BYTES)}. Plain text, not a template.`,
    on:
      `The machines the role may run on, by preference: one name or a list of at most ${MAX_ON_MACHINES}, each a machine's name or id ` +
      `as ${code("board_get")} lists them (in any case, at most ${MAX_MACHINE_NAME_CHARS} characters); ${code("board_check")} warns of one ` +
      "it does not know. Without it the role runs on any machine that offers its agent. Name the machine here or after `@`, not both.",
    min_confidence:
      "A number from zero to one. A judging answer with a lower confidence counts as none, and the next judge is asked; one " +
      "that gives no confidence is not checked.",
  },
  column: {
    id: `Required. ${pattern(COLUMN_ID)}, and unique on the board. Exits, ${code("intake")} and ${code("visits.<id>")} name a column by it.`,
    title: `Required. What the board shows: one line of at most ${MAX_COLUMN_TITLE_CHARS} characters.`,
    show:
      `Only ${code("sessions")}: a view of the conversations no task holds, with ${code("id")} and ${code("title")} alone. It holds ` +
      "no tasks, is never the intake or an exit's target, and a board has one at most. Today's app does not draw it; add one only when asked.",
    run: `Makes it a work column: a task that enters it is worked on by an agent. A map (see Run); ${code("run: {}")} runs the task's own agent with every default.`,
    next: "The column's exits: where a task may go from here (see Exits). Without it a task stays until the person moves it.",
    decide: `The judges that pick an exit, in order (see Deciding). Default: ${code("[self, human]")} in a work column, ${code("[human]")} in a waiting one.`,
    sees: `What a role judging here is shown: a list of ${codes(SEES)}. Default: ${code(`[${DEFAULT_SEES.join(", ")}]`)}. See Deciding.`,
    holder:
      `Waiting columns only. ${code("you")} means a task here waits on the person, and it is on their For you list. Default ` +
      `${code("nobody")}.`,
    limit:
      `Work columns only. At most this many runs of the column at once on one machine, a whole number up to ${MAX_COLUMN_LIMIT}; ` +
      "the rest queue in the order they entered. Default: no limit.",
    final:
      `Waiting columns only. ${code("true")} closes the task: it is done here whatever its conversations do, and no judge runs but ` +
      `its ${code("wake")}'s. Default ${code("false")}. Its exits, if any, are buttons, to reopen a task say.`,
    wake: `Waiting columns only. Where the task goes when the person writes on it here; see Wake.`,
  },
  run: {
    role:
      `The role whose agent does the work. Default: the task's own agent, the one it is assigned to, else a role named ` +
      `${code("default")}; with neither, the task asks the person to assign one.`,
    skill:
      `A slash command to send instead of a message: ${code("skill: review")} sends ${code("/review")}. A name of ` +
      `${pattern(SKILL_NAME)}; a leading ${code("/")} is dropped. Not with ${code("prompt")}.`,
    args: `Text after the skill, sent as ${code("/<skill> <args>")}. Only with ${code("skill")}; at most ${MAX_SKILL_ARGS_CHARS} characters.`,
    prompt: `The message to send, as a template (see Prompt templates); at most ${MAX_PROMPT_CHARS} characters. Not with ${code("skill")}.`,
    conversation:
      `${code("continue")} (default): the run continues the conversation the task last had in this column, else its last ` +
      "conversation anywhere, while that conversation is still there and runs the same agent on a machine the role allows; " +
      `otherwise it opens a new one. ${code("new")}: always a new conversation, which knows nothing of earlier runs.`,
    done_when:
      `${code("report")} (default): the run ends when a turn of its agent ends after it called ${code("task_update")} with ` +
      `${code("status: review")} or an ${code("outcome")}. ${code("turn")}: the run ends when the agent's turn does, report or ` +
      "not; use it for a skill or prompt that does not know the board, with rules or a role to pick the exit.",
    code:
      `${code("task")} (default): the run works in the task's code, its worktree in a git project, and the code goes with the ` +
      `task to whichever machine runs it. ${code("none")}: the run works in an empty folder of the task's own on the machine that ` +
      "runs it; no code is fetched, committed or carried for it, and that machine needs no copy of the project. Use it for work " +
      "that needs no checkout: a deploy of what is already pushed, a release note, a message. It continues only a conversation " +
      `of another ${code("code: none")} run, and a ${code("task")} run never continues one of those.`,
  },
  exit: {
    to: "Required. The id of the column this exit leads to: any column but a view, this one included.",
    means:
      `When this exit is the right one, in words, at most ${MAX_EXIT_MEANS_CHARS} characters. The run's agent and every role read ` +
      "it to pick. Required on every exit of a column that has a choice to make (two or more exits in a work column, any in a " +
      `waiting one) and whose ${code("decide")} holds ${code("self")} or a role.`,
    label:
      `The button the person presses: one line of at most ${MAX_EXIT_LABEL_CHARS} characters. Default: the exit's name, and for ` +
      `${code(`next: <column>`)} the title of that column.`,
  },
  judge: {
    rules: `The one key of a map in ${code("decide")}: ${code("{ rules: [...] }")}, a list of rules (see Rules).`,
  },
  wake: {
    next: `Required. Exits as a column's ${code("next")} writes them; a ${code("to")} may also be ${code(LAST_RUN)}.`,
    decide: `Judges as a column's ${code("decide")}, without ${code("self")}. Required with two or more exits; without it the one exit is taken at once.`,
  },
};

function fieldList(level: Level): string {
  const words: Readonly<Record<string, string>> = FIELD_WORDS[level];
  const keys: readonly string[] = BOARD_FIELDS[level];
  return keys.map((key) => `- ${code(key)}: ${words[key]}`).join("\n");
}

const SEES_WORDS: Record<Sees, string> = {
  brief: "the task's brief",
  summary: `the task's summary, as the last ${code("task_update")} left it`,
  report: "the run's report, the summary its agent last gave",
  last_message: `the agent's last message, cut to ${kib(MAX_SEEN_LAST_MESSAGE_BYTES)}`,
  diff_stat: "how many files and lines the run changed, and their paths",
  diff: `the run's diff, cut to ${kib(MAX_SEEN_DIFF_BYTES)}`,
};

const TEMPLATE_WORDS: Record<TemplateName, string> = {
  "task.title": "the task's title",
  "task.brief": "the task's brief",
  "task.summary": `its summary, empty before the first ${code("task_update")}`,
  "from.column": "the title of the column the task came from",
  "from.exit": "the exit it came by, empty where the person moved it by hand",
  "from.report": `the last run's report, or ${code("no report")}`,
};

const FACT_WORDS: Readonly<Record<string, string>> = {
  outcome: `the exit the run's agent named as ${code("task_update")}'s ${code("outcome")}`,
  labels: "the labels on the task",
  "diff.files": "how many files the run changed",
  "diff.lines": "lines added plus lines removed",
  "diff.paths": "the paths it changed",
  agent: `the harness that ran it, such as ${code("claude")}`,
  project: `the project: its git origin as ${code("host/owner/repo")}, else its folder's path`,
};

const factList = Object.entries(FACT_WORDS)
  .map(([fact, words]) => `- ${code(fact)} (${RULE_FACTS[fact] === "string" ? "text" : RULE_FACTS[fact]}): ${words}`)
  .join("\n");

export const BOARD_GUIDE = `# Writing a task board

You help a person write and change their task board. This is your whole reference: every field, its default and its limits, what the engine does with it, and how to change a board safely. When a draft and this text seem to disagree, ${code("board_check")} is right.

## What a board is

A board is one YAML document per account, and every machine of the account runs it, whether or not an app is open. A change is sent to the account's other machines, and each runs the newest revision it has seen. Where no board was ever stored, every machine runs the default board shown under Examples, at revision zero.

A task stands in one column at a time and leaves it by an exit. There are three kinds of column:

- A **work column** has ${code("run")}. When a task enters it, an agent works on the task in a conversation; when that run ends, the column's exits and judges decide where the task goes.
- A **waiting column** has no ${code("run")}. The task waits there for the person, or for a judge that can decide without them. A ${code("final")} waiting column closes the task.
- A **view** has ${code("show: sessions")} and holds no tasks.

${code("next")} names a column's exits, ${code("decide")} is the ladder of judges that pick one, and ${code("roles")} names the agents that run columns and judge.

The YAML is strict: YAML 1.2's core schema, so ${codes(["yes", "no", "on", "off"])} are plain words and a boolean is ${code("true")} or ${code("false")}. Refused, each with its line, column and path (such as ${code("columns[2].next.fix.to")}): a key written twice, any anchor (${code("&a")}) or alias (${code("*a")}), any tag (${code("!!str")}, ${code("!mine")}), an unknown field at any level, a second document (${code("---")}), and a board over ${kib(MAX_BOARD_BYTES)}. Every refusal comes back at once. Comments are allowed and kept: the revision is over the text byte for byte, so changing only a comment is a new revision.

## The top level

${fieldList("top")}

## Roles

${code("roles")} maps a name to a role: at most ${MAX_ROLES}, each name ${pattern(ROLE_NAME)}. ${RESERVED_ROLES.map(code).join(" and ")} are judges of their own and cannot be role names. A column's ${code("run")} names a role to do the work; its ${code("decide")} names roles to judge.

${fieldList("role")}

A role named ${code("default")} runs every work column whose ${code("run")} names no role, for a task with no agent of its own. Use the machine names and agents ${code("list_projects")} prints. The parser does not check that a machine or agent exists: a run nothing can take waits, and after ${hours(NO_EXECUTOR_ASK_MS)} the person is asked.

## Columns

${code("columns")} is a list in the order the board draws them. ${code("run")} makes a work column, ${code("show")} a view, and anything else is a waiting column.

${fieldList("column")}

Which fields each kind takes:

- Work column: ${codes(["id", "title", "run", "next", "decide", "sees", "limit"])}.
- Waiting column: ${codes(["id", "title", "next", "decide", "sees", "holder", "final", "wake"])}.
- View: ${codes(["id", "title", "show"])}, and nothing else.

## Run

${fieldList("run")}

### What a run sends

The first that applies:

1. ${code("skill")}: ${code("/<skill>")}, or ${code("/<skill> <args>")}.
2. ${code("prompt")}: the prompt with its names filled in. It is sent on every run, the first and every return alike.
3. A new conversation, or the task's first run: the task's brief.
4. A continued conversation: the return hint, ${code(RETURN_HINT)}, without the exit where the person moved the task by hand.

With the message goes a note: the task and the column; the role's ${code("instructions")}, on every run; in a new conversation the brief, where the message was not it, and where the task came back from; how to finish (with two or more exits and ${code("self")} in ${code("decide")}, each exit and its ${code("means")}, to name one as ${code("task_update")}'s ${code("outcome")}; else, under ${code("done_when: report")}, to call ${code("task_update")} with ${code("status: review")}); and the person's comments since the last run.

### Prompt templates

A prompt may name these, as ${code("{{name}}")} or ${code("{{ name }}")}. Any other name, or a ${code("{{")} never closed, is refused. Values go in as they are, unescaped.

${TEMPLATE_NAMES.map((name) => `- ${code(name)}: ${TEMPLATE_WORDS[name]}`).join("\n")}

On a task's first run ${code("from.column")} is the column it came from, usually the intake, and ${code("from.report")} reads ${code("no report")}. Write a prompt of several lines as a block scalar, ${code("prompt: |")}.

### When a run ends

Under ${code("done_when: report")} a turn that ends without a report stops the task: the person is asked, once per turn, and the agent's last message goes to the task's feed. A conversation the person stops, or one that cannot come back, fails the run, and the task waits for the person to move it.

### Where a run goes

In order: the conversation it continues; else the first machine in its role's ${code("on")} that is online, offers the agent and has the project (a ${code("code: none")} run needs no project); else, for a role with no ${code("on")} and a run that needs the code, the machine holding the task's code; else the machine that owns the task; else the least busy machine that can, then by name. A run placed on another machine moves the task there, and its code as a git branch unless the run has ${code("code: none")}. That needs the person to let tasks move between those machines in the app; a task in a folder that is not a git repository cannot move once it has run, whatever its next column. When nothing can take a run it waits, and after ${hours(NO_EXECUTOR_ASK_MS)} the person is asked.

In a git project a task has one worktree per machine, on the branch ${code("reemoat/t-<id>")}, and every run there works in it. When a run ends the board commits what it changed, and that diff is what the ${code("diff")} facts and ${code("sees")} read.

Only what is committed on that branch reaches another machine. Before a run that needs the code goes elsewhere, the board commits what is left in the worktree, as at a run's end. If a commit hook refuses it, files stay uncommitted, or the worktree is on another branch, the task does not go: it stays on its machine, needs the person, and says why, with the hook's words or the files. The person fixes it in the conversation that made the work and presses Retry. The machine with the code refuses to hand it over the same way when the task went through a ${code("code: none")} column first. So when a work column's next column runs on another machine, have its prompt end with everything committed and the hooks passing, and say why in a ${code("#")} comment.

## Exits: ${code("next")}

- ${code(`next: review`)} is one exit named ${code(SHORTHAND_EXIT)} to the column ${code("review")}, labelled with that column's title.
- A map names each exit: ${code("next: { fix: build, ship: approve }")}, or with fields, ${code('ship: { to: approve, means: "nothing blocking is left", label: Ship }')}.

An exit's name is ${pattern(EXIT_NAME)}, and ${code(STAY)} is no exit's name. A column has at most ${MAX_EXITS}.

${fieldList("exit")}

When a task may leave:

- A work column with no exits keeps the task when its run ends; the person moves it.
- A work column with one exit moves the task through it as soon as the run ends. No judge is asked and ${code("means")} is not needed.
- A work column with two or more exits asks its judges when the run ends.
- A waiting column asks its judges as the task enters. With only ${code("human")}, the default, its exits are the person's buttons.
- A ${code("final")} column asks nobody.

## Deciding: ${code("decide")}

${code("decide")} is a list of at most ${MAX_DECIDE} judges, asked in order until one picks an exit. ${code("human")} is always last: it is added when missing, and nothing may follow it. A name may appear once.

- ${code("self")}: the run's own agent, by the ${code("outcome")} it gave ${code("task_update")}. Work columns only.
- ${code("{ rules: [...] }")}: the first rule that holds (see Rules).
- A role's name: the role is asked once per entry, shown its ${code("instructions")}, the exits with their ${code("means")} and what ${code("sees")} allows, and answers ${code('{"exit": "<name>", "confidence": <zero to one>}')}. It abstains when its answer cannot be read, names an exit the column lacks, says it cannot tell, takes longer than ${JUDGE_TIMEOUT_MS / 1000} seconds (${CLASSIFIER_TIMEOUT_MS / 1000} for a plugin's classifier), or gives a confidence under its ${code("min_confidence")}.
- ${code("human")}: the person picks. In a work column the task shows that it needs them, with the exits as buttons; in a waiting column the exits are its buttons.

A judge with no answer passes to the next. A judge that answers ${code(STAY)}, a role or a rule's ${code(`then: ${STAY}`)}, hands the choice to the person at once, and the judges after it are not asked. Every automatic move spends one of the task's ${code("budget")}.

${code("sees")} is what a role is shown, in the order listed:

${SEES.map((one) => `- ${code(one)}: ${SEES_WORDS[one]}`).join("\n")}

The whole question is at most ${kib(MAX_JUDGE_PROMPT_BYTES)}; what does not fit is cut from the end of the list, so put what matters most first. What is a run's is the last run's: in a work column, the one that just ended there; in a waiting column, the one before it. A reviewer that changes no code has an empty diff, so judge a change by its diff in the column that made it, or in a waiting column right after.

## Rules

A rules judge is ${code("{ rules: [...] }")}: a list of at most ${MAX_RULES} rules, each ${code("{ when: {...}, then: <exit> }")}. The first rule whose every condition holds names the exit, or ${code(STAY)}; a rule with no ${code("when")} always holds; where none holds, the next judge is asked.

${FENCE}
decide:
  - rules:
      - { when: { visits.review: { gte: 3 } }, then: stay }
      - { when: { diff.lines: { lte: 20 }, labels: { has: small } }, then: ship }
  - self
${FENCE}

${code("when")} maps a fact to ${code("{ operator: value }")}; every condition in it must hold. A run's facts are the last run's, as with ${code("sees")}:

${factList}
- ${code("visits.<column>")} (number): how many times the task has entered that column, this entry included

The operators, by the kind of fact:

- number: ${code("eq")}, ${code("in")} (a list), ${code("gte")} (at least), ${code("lte")} (at most)
- text: ${code("eq")}, ${code("in")} (a list), ${code("match")}
- list: ${code("has")} (holds the value), ${code("match")} (any item matches)

${code("match")} is a glob over the whole value: ${code("*")} and ${code("?")} stay inside one path segment, ${code("**")} crosses them, as in ${code("src/**/*.ts")}. A fact with no value makes its condition false: every ${code("diff")} fact where the project is not a git repository, and ${code("outcome")} where the agent named none.

## Wake: when the person writes

A comment on a task whose run is at work goes into its conversation. On one that waits, its column's ${code("wake")} says where it goes:

- ${code("wake: build")}: to that column, as the person's own move, spending no budget.
- ${code(`wake: ${LAST_RUN}`)}: to the column its last run worked in, else the first work column. The default, but in the intake.
- ${code("wake: false")}: nowhere; the comment waits for the next run. The intake's default.
- ${code("{ next, decide }")}:

${fieldList("wake")}

A role judging a wake reads the comment first, then what ${code("sees")} allows. ${code(STAY)}, ${code("human")} or the end of the ladder leaves the task where it is. Wherever it goes, its next run's note carries the comment.

${FENCE}
  - id: done
    title: Done
    final: true
    wake:
      next:
        fix:   { to: build, means: "the comment asks for a change" }
        check: { to: review, means: "it asks for another look" }
      decide: [triage]          # a role; a plugin's classifier, such as jev, the same way
${FENCE}

## Examples

The default board, which every machine runs until a board is stored. Backlog is the intake; moving a task into Running starts its own agent, and its report moves it to Review, which waits for the person.

${FENCE}yaml
${DEFAULT_BOARD_TEXT}${FENCE}

A review loop: the coder builds, a reviewer pinned to the server reviews in a new conversation with the ${code("review")} skill, its outcome decides, else a cheap model, else the person, and Approve waits for the person.

${FENCE}yaml
${REVIEW_LOOP_TEXT}${FENCE}

A gate with rules and a judge. The gate is a waiting column right after Build, so its rules and its judge read the coder's run.

${FENCE}yaml
# Build, then a gate that decides whether a change needs review.
version: 1
budget: 6                       # the person asked to be pulled in sooner than the default
roles:
  coder:    { agent: claude }
  reviewer:
    agent: codex
    on: [server, mac]           # the server first; the mac when it is away
    effort: high
    instructions: |             # the person's lens for every review
      Review as the on-call engineer: what breaks, what is untested. Not style.
  triage:   { agent: claude, model: haiku, min_confidence: 0.7 }   # cheap; unsure answers go to the person
columns:
  - { id: inbox, title: Inbox }
  - id: build
    title: Build
    limit: 2                    # two builds at once per machine: the mac runs out of memory past that
    run: { role: coder }
    next: gate
  - id: gate
    title: Gate
    holder: you                 # whatever no judge decides waits on the person
    next:
      review: { to: review, means: "the change needs a second pair of eyes" }
      skip:   { to: approve, means: "the change is small, safe and does what the brief asks" }
    decide:
      - rules:
          - { when: { diff.paths: { match: "**/migrations/**" } }, then: review }   # schema changes are always reviewed
          - { when: { labels: { has: trivial }, diff.lines: { lte: 20 } }, then: skip }
      - triage
    sees: [brief, report, diff_stat]
  - id: review
    title: Review
    run:
      role: reviewer
      conversation: new         # a fresh reviewer each round
      done_when: turn
      prompt: |
        Review the latest commits on this branch for the task "{{task.title}}".
        The task: {{task.brief}}
        The coder's report: {{from.report}}
    next:
      pass: { to: approve, means: "nothing blocking is left" }
      fix:  { to: build, means: "the review found problems that need code" }
    decide:
      - rules:
          - { when: { visits.review: { gte: 3 } }, then: stay }   # a third round is the person's call
      - self
  - id: approve
    title: Approve
    holder: you
    next:
      merge: { to: done, label: Merge }
      again: { to: build, label: Send back }
  - { id: done, title: Done, final: true }
${FENCE}

## How to work

1. Call ${code("board_get")}. It returns the board's YAML exactly as stored, comments included, its revision, and each column in words. Work from that text, never from memory or an earlier read.
2. Change only what the person asked for. Keep everything else byte for byte: order, spacing, quoting and comments.
3. Check the whole draft with ${code("board_check")} (${code("text")}: the whole board). Fix every line it reports and check again.
4. Walk a task through the draft with ${code("board_simulate")} (${code("text")}: the draft; ${code("script")}: at most ${MAX_SIMULATED_EVENTS} lines). The task starts in the intake, and each line is what happens next:
   - ${code("move <column>")}: the person moves the task there. A walk usually starts with one into the first work column.
   - ${code("press <exit>")}: the person presses one of the column's exits.
   - ${code("report")}: the run's agent reports and its turn ends.
   - ${code("outcome <exit>")}: it reports naming that exit, and its turn ends.
   - ${code("silent")}: its turn ends with no report.
   - ${code("<role> <exit|stay|none> [confidence]")}: the role being asked answers; ${code("none")} is no answer.
   - ${code("comment [words]")}: the person writes on the task.

   It answers with every step taken, where the task ends and in what state, and each line that did not apply. The walk has one machine, which offers every agent but is none of the machines an ${code("on")} names, so a pinned role's run waits there: walk a copy with the pin removed to see past it. It has no code, labels or project either, so rules on those never hold. With its reviewer unpinned, the review loop above walks as ${code('["move build", "report", "outcome fix", "report", "silent", "cheap ship 0.9", "press merge"]')}.
5. Apply it with ${code("board_apply")}: ${code("text")}, the whole board; ${code("revision")}, the revision ${code("board_get")} showed; ${code("why")}, one short paragraph on what changed and why. If it answers that the revision moved, somebody else changed the board: call ${code("board_get")} again and make your change again on the new text. Never apply over a revision you have not read.
6. Tell the person in a sentence or two what changed.

When you are not sure what the person wants, ask with your question tool (${code("ask_question")}) before applying, and wait for the answer.

## Changing a board in use

A change reaches the tasks already on the board at their next step:

- A task in a column that no longer exists, a renamed id included, goes to the intake. The board makes that move and it spends no budget.
- A column that becomes a work column starts no run for the tasks already in it; a run starts only when a task enters.
- A changed role, prompt or skill applies from the next run; a run already working is not restarted.
- A machine whose build cannot read the board keeps running the default board until it is updated, so use only what this guide describes.

## Comments are your memory

This conversation may be replaced by another agent, on another machine, that never saw it. What carries over is the board's text, comments included. So write the reason for every choice that is not obvious as a ${code("#")} comment beside it: why a role is pinned to a machine, why a limit, why a rule's threshold, what the person said they wanted. Read the comments before you change anything, keep them true, and change a comment when you change the line it explains.
`;
