# Project Brain: Problem, Solution, Execution Plan

## 1. Core Idea

For each engineering project, we create a dedicated Project Brain. This is a timestamped, per-project system that continuously gathers what the team has documented, what the team has discussed, and what the codebase currently looks like. The purpose is not just to store knowledge. The purpose is to turn project context into clear, execution-ready next steps.

In practice, each Project Brain combines three kinds of context. The first is documents and static sources, such as specs, design docs, architecture notes, tickets, planning notes, and important Slack summaries. The second is meeting transcripts, including planning meetings, standups, technical reviews, brainstorms, and bug triage conversations. The third is codebase context, such as the relevant repository, important files and modules, recent pull requests, implementation patterns, and technical constraints.

The key idea is simple: each project gets its own brain, and that brain reads what the team wrote, what the team said, and what the codebase reflects, then turns that combined understanding into actionable work.

---

## 2. Problem

Engineering teams rarely suffer from a lack of information. The real problem is that project context is fragmented across different systems and changes over time. Useful information lives in docs, tickets, Slack threads, meetings, and the codebase itself, but these sources do not naturally come together into a single execution-ready view.

This creates a few recurring problems. Important decisions are made in meetings but never converted into structured follow-up. Docs may describe the intended plan, but meetings often contain the latest changes to scope or priorities. The codebase reflects implementation reality, but it may no longer match what the docs say. Action items are often implied rather than explicitly recorded, so teams leave meetings with shared understanding but no operational output.

This gets worse on existing projects. Over time, projects accumulate too much context for people to hold in their heads. Even current team members can struggle to reconstruct what matters now, and new contributors have to piece together history manually. As a result, teams spend time re-understanding the project instead of executing on it.

The core problem is therefore not missing information. The core problem is that project context is scattered, time-sensitive, and not naturally transformed into execution.

---

## 3. Solution

We solve this by building a per-project execution brain. For every engineering project, the system maintains two main timestamped repositories of knowledge, plus access to codebase context.

The first repository contains documents and static sources. This includes things like specs, PRDs, design docs, architecture notes, tickets, planning docs, and exported or summarized Slack discussions. These sources usually represent the more stable or intended understanding of the project.

The second repository contains meeting transcripts. These transcripts capture the freshest and often highest-signal context in the project, such as changing priorities, implementation concerns, bug discussions, follow-up ideas, and decisions made live during collaboration.

On top of these two repositories, the system also reads the codebase context. This gives the Project Brain technical grounding in the repo structure, relevant files, recent PRs and issues, implementation patterns, and constraints already present in the system.

What makes this useful is that the Project Brain does not treat these as isolated inputs. It continuously processes them per project, with timestamps attached, so it can reason about what is new, what has changed, and what is most relevant now. Processing can happen automatically on a schedule, such as daily, or when a new document or transcript is added. It can also happen on demand when a user selects the latest sources they want to use.

The system then combines the latest relevant document context, the latest relevant meeting context, and the current codebase context. From that combined view, it identifies issues to fix, features to build, improvements to plan, blockers to resolve, and follow-up work that has been discussed but not yet operationalized.

---

## 4. How the Product Thinks

This product should be understood as a per-project system, not a generic company-wide assistant. The company brain is made up of multiple project brains, and each one has its own evolving memory, current state, and execution opportunities.

Because this memory is timestamped, the system can distinguish between older context and newer context. That matters because project truth changes over time. A meeting from yesterday may supersede a design decision written two weeks ago. A recent implementation may show that a plan in an older document is no longer accurate. By storing project context as a timeline rather than one giant summary, the Project Brain can keep track of what happened, when it happened, and what should be considered the latest source of truth.

Each Project Brain should help answer four questions. What is happening in this project right now? What changed recently? What work is implied by the latest docs, meetings, and code context? What can we execute immediately?

---

## 5. Processing Flow

The flow begins when a project is set up and linked to its sources. Each project is associated with a repository of documents and static sources, a repository of meeting transcripts, and the relevant codebase or repository.

As new docs or transcripts are added, they are stored under that project with timestamps. This timestamping is important because it gives us a project timeline rather than a flat knowledge store. The system can then process the latest updates either automatically or on demand.

During processing, the system combines the newest or user-selected documents with the newest or user-selected meeting transcripts, then enriches that with codebase context. It extracts concrete signals from this combined context, including bugs, feature requests, enhancements, technical blockers, follow-up tasks, and implementation implications.

Those findings are then grouped into execution-oriented categories. For example, the system might identify a bug fix that was discussed in a meeting, a new feature idea mentioned in a planning document, an enhancement to an existing feature, or a mismatch between what the docs say and what the codebase currently does.

The output of this pipeline is an execution page. This is where the Project Brain turns understanding into operational suggestions. Instead of stopping at summarization, it surfaces a set of concrete actions that can be taken.

---

## 6. Execution Layer

The execution page is where the product becomes genuinely useful. Based on the combined project context, it generates actionable items that an engineer or agent can run.

Examples of those actions include creating a Jira ticket for a bug discussed in a meeting, generating an implementation plan for a newly proposed feature, drafting a documentation update after a design decision, identifying code areas likely to be affected by a change, or drafting a PR or engineering task plan.

This is the most important point in the product. The Project Brain is not just a memory system and not just a summarizer. It is a project context-to-execution system. It captures context continuously, synthesizes it into the latest understanding of the project, and then presents execution-ready options.

---

## 7. Why This Matters

Engineering teams already produce a large amount of useful context. The challenge is that this context is scattered, partially stale, and difficult to convert into work. Project Brain closes that gap by creating persistent, timestamped memory for each project and using that memory to generate the next actions that matter.

This is valuable for both new and existing projects. In a new project, the brain starts small and helps structure early discussions into execution. In an existing project, the brain becomes even more useful because it helps teams navigate accumulated history, identify what changed recently, and focus on the highest-value next steps.

In both cases, the system reduces coordination overhead and shortens the path from discussion to implementation.

---

## 8. Practical MVP

To keep the first version realistic, the MVP should stay narrow. For one project, we ingest a small set of project documents, one or more recent meeting transcripts, and enough codebase context to ground the system technically.

The MVP then processes the selected latest context and generates a structured execution page. That page should clearly show what kinds of work have emerged from the latest project understanding, such as a bug to fix, a feature to plan, a doc to update, a technical investigation task, or an implementation plan to draft.

The first executable actions should be kept simple and believable. A strong starting point would be creating Jira tickets, generating implementation plans, and drafting documentation updates. More advanced actions such as drafting PRs, opening GitHub issues, or generating code changes can come later.

The strongest MVP demo is therefore simple: for one project, ingest the latest docs, the latest meeting transcript, and relevant code context, then show an execution page with concrete actions that the team can immediately act on.

---

## 9. Recommended Build Direction

The build should start with the per-project data model. Each project needs two main source buckets, one for documents and static sources and one for meeting transcripts, with all entries stored as timestamped items. On top of that, the system needs access to codebase context.

Once that foundation exists, the next step is a processing pipeline that combines the latest project context and categorizes it into issues, features, enhancements, blockers, and follow-up work. After that, we build the execution page that presents these findings as actionable items. Finally, we connect a small number of actions that can actually be run.

What we should not do yet is overcomplicate the system with too many integrations, advanced cross-project reasoning, or fully autonomous coding across large repositories. The best first version is one strong vertical slice: per-project context in, execution opportunities out.

---

## 10. Final Framing for the Team

We are building a per-project engineering brain. For each project, the system continuously gathers what the team has documented, what the team has discussed, and what the codebase currently looks like. It stores this as timestamped project memory so the team can understand not just what exists, but what changed and when.

The system then processes that memory to identify issues to fix, features to build, improvements to plan, docs to update, and execution tasks to run. That is why the product fits the company brain idea well: it is not just helping people look things up. It is using project knowledge to move engineering work forward.

A good one-line summary is this: Project Brain is a timestamped, per-project company brain that combines documents, meeting transcripts, and codebase context to generate execution-ready actions for engineering teams.

