import { createPaneWidth } from "./paneWidth";

// The declared widths live in `index.css` (Tailwind needs literals); `webcheck` asserts these copies agree.
// The binding clamp is CSS's `--task-fit`; `webcheck` bans layout JavaScript in `TaskPanel.tsx`.

export const TASK_MIN = 288;
export const TASK_MAX = 512;
/** 20rem: `index.css`'s width from `md`. */
export const TASK_DEFAULT = 320;
/** 26rem: `index.css`'s width from `xl`. */
export const TASK_WIDE = 416;

export const taskPane = createPaneWidth({
  key: "reemoat.taskWidth",
  min: TASK_MIN,
  max: TASK_MAX,
  unset: null,
  fallback: TASK_DEFAULT,
  prop: "--task-w",
});

export function taskWidth(): number | null {
  return taskPane.width();
}

export const subscribeTaskWidth = taskPane.subscribe;
