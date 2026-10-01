import { emitKeypressEvents } from 'node:readline';
import {
  reduce,
  type Key,
  type PickerEvent,
  type PickerOutcome,
  type PickerState,
} from './state.js';
import { renderPicker } from './view.js';

export interface PickerIO {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

const ALT_ON = '\u001b[?1049h';
const ALT_OFF = '\u001b[?1049l';
const HIDE = '\u001b[?25l';
const SHOW = '\u001b[?25h';
const HOME = '\u001b[H';
const CLEAR_LINE = '\u001b[K';
const CLEAR_DOWN = '\u001b[J';

/**
 * Run the picker until it produces an outcome (ADR 491). The only code that touches the terminal:
 * alternate screen, raw mode, keypresses, repaint, and — on every exit path, a throw and process
 * exit included — restore. `start` receives a dispatcher for asynchronous answers (the catalog
 * scan, the roster). In raw mode ⌃C arrives as a key, not a signal; the reducer maps it to quit 130.
 */
export function runPicker(
  initial: PickerState,
  io: PickerIO,
  start: (dispatch: (e: PickerEvent) => void) => void,
  reducer: typeof reduce = reduce,
): Promise<PickerOutcome> {
  return new Promise((resolve, reject) => {
    let state = initial;
    let finished = false;
    const restore = (): void => {
      try {
        if (io.input.isTTY) io.input.setRawMode(false);
      } catch {
        // the stream is already gone
      }
      io.input.pause();
      io.output.write(SHOW + ALT_OFF);
    };
    const paint = (): void => {
      const lines = renderPicker(state, {
        cols: io.output.columns || 80,
        rows: io.output.rows || 24,
      });
      io.output.write(HOME + lines.map((l) => l + CLEAR_LINE).join('\n') + CLEAR_DOWN);
    };
    const finish = (settle: () => void): void => {
      if (finished) return;
      finished = true;
      io.input.off('keypress', onKey);
      io.output.off('resize', paint);
      process.off('exit', restore);
      restore();
      settle();
    };
    const dispatch = (event: PickerEvent): void => {
      if (finished) return;
      try {
        const next = reducer(state, event);
        state = next.state;
        const outcome = next.outcome;
        if (outcome) finish(() => resolve(outcome));
        else paint();
      } catch (err) {
        finish(() => reject(err));
      }
    };
    const onKey = (str: string | undefined, key: Key | undefined): void =>
      dispatch({ type: 'key', key: key ?? { sequence: str } });

    process.on('exit', restore);
    emitKeypressEvents(io.input);
    if (io.input.isTTY) io.input.setRawMode(true);
    io.input.on('keypress', onKey);
    io.output.on('resize', paint);
    io.input.resume();
    io.output.write(ALT_ON + HIDE);
    paint();
    start(dispatch);
  });
}
