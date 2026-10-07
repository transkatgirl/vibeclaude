const TOOL_CALL_DURATION = 120;
const TOOL_CALL_INTENSITY = 0.5;
const TOOL_SUCCESS_DURATION = 180;
const TOOL_SUCCESS_INTENSITY = 0.7;
const TOOL_FAILURE_DURATION = 280;
const TOOL_FAILURE_INTENSITY = 1.0;
const TODO_COMPLETE_DURATION = 200;
const TODO_COMPLETE_INTENSITY = 0.8;

export const isFileMutationTool = (tool) =>
  tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit';

export class ActivityHandler {
  toolStatuses = new Map();

  /**
   * `taskStatuses`: what the tasks have come to, where the list is not this handler's alone.
   * `todoStatuses`: what the todos had come to before, where they are not new to this handler.
   */
  constructor(engine, taskStatuses = new Map(), todoStatuses = new Map()) {
    this.engine = engine;
    this.taskStatuses = taskStatuses;
    this.todoStatuses = todoStatuses;
  }

  onToolUpdated(callID, tool, status) {
    const previous = this.toolStatuses.get(callID);
    if (previous === status) return;
    this.toolStatuses.set(callID, status);

    // File edits get the "preparing" hold instead of a start pulse.
    if (isFileMutationTool(tool) && (status === 'pending' || status === 'running')) return;

    if (status === 'pending' || status === 'running') {
      if (previous === 'pending' || previous === 'running') return;
      this.engine.stopStreaming();
      this.engine.play({
        source: 'tool',
        intensity: TOOL_CALL_INTENSITY,
        duration: TOOL_CALL_DURATION,
      });
      return;
    }

    this.playResult(status);
  }

  /** A subagent's run ended, 'completed' or in 'error': felt as a tool call's result is. */
  onAgentCompleted(status) {
    this.playResult(status);
  }

  playResult(status) {
    if (status === 'completed') {
      this.engine.play({
        source: 'tool',
        intensity: TOOL_SUCCESS_INTENSITY,
        duration: TOOL_SUCCESS_DURATION,
      });
      return;
    }

    if (status === 'error') {
      this.engine.play({
        source: 'tool',
        intensity: TOOL_FAILURE_INTENSITY,
        duration: TOOL_FAILURE_DURATION,
      });
    }
  }

  /** todos: the whole list, as [{ key, status }]. Pulses when any item newly completes. */
  onTodosUpdated(todos) {
    const nextStatuses = new Map();
    let completed = 0;

    for (const todo of todos) {
      const previous = this.todoStatuses.get(todo.key);
      nextStatuses.set(todo.key, todo.status);
      if (todo.status === 'completed' && previous !== 'completed') {
        completed += 1;
      }
    }

    this.todoStatuses = nextStatuses;
    if (completed === 0) return;

    this.playTodoCompleted();
  }

  /** A single item changed status (task tools report one item at a time). */
  onTodoUpdated(key, status) {
    const previous = this.taskStatuses.get(key);
    this.taskStatuses.set(key, status);
    if (status === 'completed' && previous !== 'completed') this.playTodoCompleted();
  }

  playTodoCompleted() {
    this.engine.play({
      source: 'todo',
      intensity: TODO_COMPLETE_INTENSITY,
      duration: TODO_COMPLETE_DURATION,
    });
  }
}
