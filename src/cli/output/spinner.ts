import type { ColorMode } from './color.js';
import { styles } from './color.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export interface Spinner {
  stop(): void;
  setText(text: string): void;
}

export function startSpinner(text: string, mode: ColorMode): Spinner {
  // Silent in plain mode and when stdout is not a TTY (don't pollute pipes/CI).
  if (!mode.color || !process.stdout.isTTY) {
    return { stop: () => {}, setText: () => {} };
  }

  const s = styles(mode);
  let frame = 0;
  let currentText = text;
  let stopped = false;

  const render = (): void => {
    if (stopped) return;
    // \r returns to start; \x1b[K clears to end of line.
    process.stdout.write(`\r\x1b[K${s.cyan(FRAMES[frame % FRAMES.length])} ${s.dim(currentText)}`);
    frame++;
  };

  render();
  const interval = setInterval(render, INTERVAL_MS);
  // Don't keep the event loop alive just for the spinner.
  if (typeof interval.unref === 'function') interval.unref();

  return {
    setText(t: string): void { currentText = t; },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      process.stdout.write('\r\x1b[K');
    }
  };
}
