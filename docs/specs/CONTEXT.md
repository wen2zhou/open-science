# Open Science

Open Science is a local-first research workbench that keeps agent-assisted research, executable work, and inspectable evidence together in a durable project record.

## Research Record

**Project**:
A durable research workspace that keeps related Sessions and Project Files together. A Project is the top-level boundary for a line of research, not a single analysis request.
_Avoid_: Workspace, study, folder

**Session**:
A durable research conversation within one Project, including its selected conversation path, execution history, files, and approval posture. A Session can outlive any live Agent Session that serves it.
_Avoid_: Chat, thread, Agent Session

**Conversation Turn**:
One user request together with the agent activity, result, and terminal outcome attributable to that request within a Session. A turn is anchored by its initiating user Message and can remain suspended for user review across multiple Attempts, Agent Sessions, or Runtime Segments without changing identity.
_Avoid_: Message, Run, request

**Message**:
One user or agent contribution to a Session's conversation. A Message is a component of a Conversation Turn, not the complete record of that turn.
_Avoid_: Turn, prompt, response

**Message Branch**:
A selectable alternative path through Messages created when a completed user Message is revised and resent. It preserves the original downstream path rather than replacing it.
_Avoid_: Conversation branch, overwrite, revision history

**Agent Frame**:
A role-bound body of agent work within a Session that owns a Message Branch. The root frame is the ordinary research conversation; review or delegated work is a distinct frame.
_Avoid_: Agent Session, Message Branch

**Agent Session**:
The live agent conversational context currently backing an Open Science Session. It may be replaced or resumed without changing the durable Session's identity or research record.
_Avoid_: Session, Agent Frame

**Runtime Segment**:
A contiguous period in an Agent Frame during which one agent identity and model context applies. A specialist change can create a new Runtime Segment without changing the Session, Turn, or Message Branch.
_Avoid_: Agent Session, Conversation Turn

**Handoff**:
An approved continuation of an in-progress Conversation Turn under the Main Agent or a different Specialist. It preserves the originating turn's identity and associated inputs rather than starting an unrelated task.
_Avoid_: New Session, delegated task

## Files and Traceability

**Project File**:
A file available in a Project's file library. A Project File may be a user-supplied Upload or a generated Artifact Version.
_Avoid_: Artifact, Upload

**Upload**:
A Project File supplied by the user for use in research. Its immutable Upload Version identifies the captured input bytes rather than merely the source file's current contents.
_Avoid_: Artifact, attachment

**Upload Version**:
An immutable captured instance of an Upload. It is the input identity used when evidence needs to distinguish a later replacement of the same logical upload.
_Avoid_: Upload, file path

**Artifact**:
A logical generated research result, such as a report, table, figure, or data file. An Artifact identifies the result across its successive immutable versions.
_Avoid_: Project File, Artifact Version, upload

**Artifact Version**:
One immutable captured result for an Artifact, with its own durable identity and creation evidence. New output creates a new version instead of mutating an earlier result.
_Avoid_: Artifact, revision, file save

**Artifact Finalization**:
The transition that makes generated output a durable Artifact Version associated with its producing Conversation Turn and available production evidence.
_Avoid_: Artifact publication, file save

**Provenance**:
The inspectable, version-scoped record of evidence Open Science could verify for an Artifact Version, including its producing research context and available inputs, execution, environment, and review evidence. Provenance supports audit and investigation; it is not a guarantee of deterministic replay.
_Avoid_: Reproducibility guarantee, citation

**Preview**:
An in-workbench view of a Project File or research output. A Preview is a way to inspect a file, not a new Artifact or a modified copy of it.
_Avoid_: Artifact, export, rendered result

## Research Execution

**Notebook**:
The persistent execution record associated with a Session, containing executable research work and its run history. It is the research work surface, not necessarily a traditional authored notebook document.
_Avoid_: Session, Artifact

**Kernel**:
A language-specific execution context used for notebook work. A Kernel carries executable state across compatible Runs, unlike a standalone shell command.
_Avoid_: Notebook, Runtime Environment

**Run**:
One durable record of an execution attempt, including its submitted work, outcome, outputs, and available environment evidence. A Run is local notebook execution, whereas a Compute Job is externally submitted asynchronous work.
_Avoid_: Conversation Turn, Compute Job, Artifact

**Runtime Environment**:
The selected language runtime and package context in which notebook work can execute. It may be app-managed, user-owned, or agent-created.
_Avoid_: Kernel, Runtime Binding

**Runtime Binding**:
A Session's selected Runtime Environment for one notebook language. It records the intended execution context; it is not a Run or a Kernel instance.
_Avoid_: Runtime Environment, Kernel

**Compute Host**:
A registered remote execution target available to a Session for external compute work. It represents where work may run, not an individual submitted workload.
_Avoid_: Compute Job, Kernel, Runtime Environment

**Compute Job**:
An asynchronous workload submitted to a Compute Host for a Session. Its status and harvested results belong to the job, even if its outputs later become Project Files or Artifacts.
_Avoid_: Run, Compute Host, Artifact

## Review and Authorization

**Session Plan**:
The active, versioned proposal for how the agent will carry out one Conversation Turn. A Session Plan remains subject to explicit user review, and replacement versions stay within the originating Conversation Turn.
_Avoid_: Conversation Turn, task, transient tool response

**Awaiting Plan Approval**:
The non-terminal state of a Conversation Turn whose active Session Plan is pending an explicit user decision. It is durable product state, not a live provider request or an idle Session.
_Avoid_: Idle, completed, active tool call

**Reviewer**:
The opt-in auditing agent that examines a completed Conversation Turn against its available messages, activity, executions, and artifacts. It is distinct from the Main Agent and from a user-created Specialist.
_Avoid_: Specialist, Main Agent

**Review**:
One audit of a defined Conversation Turn and its scoped artifact versions. A Review records whether it passed or was flagged and retains the evidence window it examined.
_Avoid_: Conversation Turn, Reviewer

**Review Check**:
One pass, warning, or failure assessment recorded by a Review. A warning or failure identifies a claim needing attention; a passing check records verified evidence.
_Avoid_: Finding, review result

**Permission Profile**:
A Session-wide approval posture that determines how the agent requests consent for sensitive work. It expresses the current default interaction mode, not a durable authorization for a particular capability.
_Avoid_: Permission Grant, access token

**Permission Grant**:
A remembered allowance for a defined capability at global, Project, or Session scope. A Permission Grant is narrower and more durable than a Permission Profile's general approval posture.
_Avoid_: Permission Profile, approval prompt

## Research Capabilities

**Main Agent**:
The built-in general-purpose research agent. A Session may bind a Specialist for its root conversation. Delegated child identity defaults are governed by the accepted Subagent identity-resolution spec rather than by this glossary. It is an agent role, not a reusable Specialist profile.
_Avoid_: Specialist, Reviewer

**Attempt**:
One execution episode within an Agent Frame and Conversation Turn. Initial execution and each explicit continuation are separate Attempts; an Attempt ending does not by itself end its Conversation Turn. A terminal Attempt outcome is completed, cancelled, timed out, interrupted, or failed.
_Avoid_: Run, Runtime Segment, retry

**Attempt Deadline**:
The durable upper bound on active work for one Subagent Attempt, measured from durable admission. Expiry fences further writes and ends the Attempt through the timeout termination path; it is independent of how long the Main Agent waits to observe the Attempt.
_Avoid_: Delegated Wait, REPL timeout, polling timeout

**Delegated Wait**:
A bounded observation by the Main Agent of one or more Subagent Attempts until a stated completion condition is satisfied. Expiry returns the latest partial observation and leaves non-terminal Attempts running.
_Avoid_: Attempt Deadline, cancellation, execution timeout

**Delegation Command**:
The durable, idempotent record of one authorized request that admits or controls delegated work. A Host request is scoped to its originating Conversation Turn; a lifecycle request is scoped to its system event. The command identity lets a caller recover the committed effect when an RPC or REPL response is lost.
_Avoid_: Attempt, tool invocation, transient RPC request

**Subagent**:
The product and UI label for work represented by a `kind = delegate` Agent Frame. The Agent Frame is its durable identity, and its execution history consists of Attempts.
_Avoid_: Agent Session, Specialist, nested agent

**Specialist**:
A reusable, user-defined agent profile with a research identity, instructions, and a scoped set of Skills and Connectors. A Specialist can be bound to a Session and become the target of a Handoff.
_Avoid_: Reviewer, Agent Session, Main Agent

**Skill**:
A readable, reusable package of instructions that gives an agent a particular research workflow or capability. A Skill guides agent work; it is not itself an external data service.
_Avoid_: Connector, Specialist

**Connector**:
A configured research data or tool service that an agent can call, subject to permission. A Connector provides callable external or local capabilities; it is not a Skill's instructional content.
_Avoid_: Skill, Model Provider
