import { END, START, StateGraph } from '@langchain/langgraph';
import type { LlmCallRecord } from '../../llm/model.types.js';
import type { StructuredCall } from '../../llm/structured.js';
import {
  ChecklistOutputSchema,
  type ChecklistOutput,
  TimelineOutputSchema,
  type TimelineOutput,
} from './llm-schemas.js';
import { checklistPrompt, timelinePrompt } from './prompts.js';
import {
  EventBriefSchema,
  type EventBrief,
  type PlannerState,
  PlannerStateSchema,
} from './planner.state.js';
import { type Milestone, computeMilestones } from './timeline.js';

/** Everything the flow produces, before anything is persisted. */
export interface PlanDraft {
  brief: EventBrief;
  milestones: Milestone[];
  timeline: TimelineOutput;
  checklist: ChecklistOutput;
  calls: LlmCallRecord[];
}

export interface PlanRunOptions {
  /** Ladder index to start at (evals pin a rung). */
  startAt?: number;
  now?: Date;
}

/** What the service depends on; tests stub it with a canned draft. */
export interface PlannerGraph {
  run(brief: EventBrief, options?: PlanRunOptions): Promise<PlanDraft>;
}

// --- Node bodies: plain functions, unit-testable with a stubbed StructuredCall. ---------------

/** No model call. Validates the brief and computes milestone dates from the event date. */
export function normaliseBrief(state: PlannerState): Pick<PlannerState, 'brief' | 'milestones'> {
  const brief = EventBriefSchema.parse(state.brief);
  const now = state.nowIso ? new Date(state.nowIso) : new Date();
  return { brief, milestones: computeMilestones(brief.date, now) };
}

export async function generateTimeline(
  call: StructuredCall,
  state: PlannerState,
): Promise<Pick<PlannerState, 'timeline' | 'calls'>> {
  if (!state.brief || !state.milestones)
    throw new Error('generateTimeline ran before normaliseBrief');
  const r = await call(TimelineOutputSchema, timelinePrompt(state.brief, state.milestones), {
    node: 'generateTimeline',
    ...(state.startAt === undefined ? {} : { startAt: state.startAt }),
  });
  return { timeline: r.value, calls: r.calls };
}

export async function generateChecklist(
  call: StructuredCall,
  state: PlannerState,
): Promise<Pick<PlannerState, 'checklist' | 'calls'>> {
  if (!state.brief || !state.milestones || !state.timeline) {
    throw new Error('generateChecklist ran before generateTimeline');
  }
  const r = await call(
    ChecklistOutputSchema,
    checklistPrompt(state.brief, state.milestones, state.timeline),
    {
      node: 'generateChecklist',
      ...(state.startAt === undefined ? {} : { startAt: state.startAt }),
    },
  );
  return { checklist: r.value, calls: r.calls };
}

// --- The graph: normaliseBrief -> generateTimeline -> generateChecklist --------------------------

export function buildPlannerGraph(call: StructuredCall) {
  return new StateGraph(PlannerStateSchema)
    .addNode('normaliseBrief', (state) => normaliseBrief(state))
    .addNode('generateTimeline', (state) => generateTimeline(call, state))
    .addNode('generateChecklist', (state) => generateChecklist(call, state))
    .addEdge(START, 'normaliseBrief')
    .addEdge('normaliseBrief', 'generateTimeline')
    .addEdge('generateTimeline', 'generateChecklist')
    .addEdge('generateChecklist', END)
    .compile();
}

export class LangGraphPlanner implements PlannerGraph {
  private readonly graph: ReturnType<typeof buildPlannerGraph>;

  constructor(call: StructuredCall) {
    this.graph = buildPlannerGraph(call);
  }

  async run(brief: EventBrief, options: PlanRunOptions = {}): Promise<PlanDraft> {
    const out = await this.graph.invoke({
      brief,
      ...(options.now ? { nowIso: options.now.toISOString() } : {}),
      ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
    });
    if (!out.brief || !out.milestones || !out.timeline || !out.checklist) {
      throw new Error('Planner graph finished without a complete plan'); // a bug, not a model failure
    }
    return {
      brief: out.brief,
      milestones: out.milestones,
      timeline: out.timeline,
      checklist: out.checklist,
      calls: out.calls,
    };
  }
}
