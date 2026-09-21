import { describe, expect, it } from 'vitest';
import { createBackQueue, isLayerState, withLayer } from './backStackLayer';

describe('isLayerState', () => {
  it('matches a state carrying the same layer name', () => {
    expect(isLayerState({ layer: 'sheet' }, 'sheet')).toBe(true);
  });

  it('rejects a state with a different layer name', () => {
    expect(isLayerState({ layer: 'search' }, 'sheet')).toBe(false);
  });

  it('rejects null/undefined state', () => {
    expect(isLayerState(null, 'sheet')).toBe(false);
    expect(isLayerState(undefined, 'sheet')).toBe(false);
  });

  it('rejects non-object state', () => {
    expect(isLayerState('sheet', 'sheet')).toBe(false);
    expect(isLayerState(42, 'sheet')).toBe(false);
  });

  it('rejects an object with no layer field (e.g. a plain router state)', () => {
    expect(isLayerState({ usr: null, key: 'abc', idx: 3 }, 'sheet')).toBe(false);
  });
});

describe('withLayer', () => {
  it('adds the layer tag to an existing state object', () => {
    expect(withLayer({ usr: null, key: 'abc', idx: 3 }, 'sheet')).toEqual({
      usr: null,
      key: 'abc',
      idx: 3,
      layer: 'sheet',
    });
  });

  it('produces a state carrying just the layer tag when there was no prior state', () => {
    expect(withLayer(null, 'sheet')).toEqual({ layer: 'sheet' });
    expect(withLayer(undefined, 'sheet')).toEqual({ layer: 'sheet' });
  });

  it('overwrites a pre-existing layer field with the new layer name', () => {
    expect(withLayer({ layer: 'search' }, 'sheet')).toEqual({ layer: 'sheet' });
  });

  it('round-trips through isLayerState', () => {
    const state = withLayer({ key: 'xyz' }, 'scanner');
    expect(isLayerState(state, 'scanner')).toBe(true);
    expect(isLayerState(state, 'sheet')).toBe(false);
  });
});

describe('createBackQueue — an overlay never opens under an in-flight back()', () => {
  // A hand-rolled clock: tasks run only when the test says so.
  const fakeClock = () => {
    let id = 0;
    const tasks = new Map<number, { fn: () => void; ms: number }>();
    return {
      schedule: (fn: () => void, ms: number) => {
        id += 1;
        tasks.set(id, { fn, ms });
        return id;
      },
      cancel: (handle: unknown) => {
        tasks.delete(handle as number);
      },
      /** Run every task due within `ms` (0 = the next tick). */
      run(ms = 0) {
        for (const [key, task] of [...tasks]) {
          if (task.ms <= ms) {
            tasks.delete(key);
            task.fn();
          }
        }
      },
      pendingDelays: () => [...tasks.values()].map((t) => t.ms),
    };
  };

  it('pushes at once when nothing is in flight', () => {
    const clock = fakeClock();
    const q = createBackQueue(clock.schedule, clock.cancel);
    const calls: string[] = [];
    q.whenIdle(() => calls.push('push'));
    expect(calls).toEqual(['push']);
  });

  it('holds a push until the closing overlay back() lands — then runs it on the NEXT tick', () => {
    const clock = fakeClock();
    const q = createBackQueue(clock.schedule, clock.cancel);
    const calls: string[] = [];
    q.noteBack(); // sheet A closes
    q.whenIdle(() => calls.push('push B')); // sheet B opens in the same tick
    expect(calls).toEqual([]);
    q.notePop(); // A's back() lands
    // Not inside the pop that released it: B's own popstate listener must
    // not mistake that pop for a back press on B.
    expect(calls).toEqual([]);
    clock.run(0);
    expect(calls).toEqual(['push B']);
    expect(q.inFlight).toBe(0);
  });

  it('waits for every back() in flight', () => {
    const clock = fakeClock();
    const q = createBackQueue(clock.schedule, clock.cancel);
    const calls: string[] = [];
    q.noteBack();
    q.noteBack();
    q.whenIdle(() => calls.push('push'));
    q.notePop();
    clock.run(0);
    expect(calls).toEqual([]);
    q.notePop();
    clock.run(0);
    expect(calls).toEqual(['push']);
  });

  it('ignores a pop with nothing in flight (a real back press)', () => {
    const clock = fakeClock();
    const q = createBackQueue(clock.schedule, clock.cancel);
    q.notePop();
    expect(q.inFlight).toBe(0);
    const calls: string[] = [];
    q.whenIdle(() => calls.push('push'));
    expect(calls).toEqual(['push']);
  });

  it('releases waiters if the back() never produces a pop', () => {
    const clock = fakeClock();
    const q = createBackQueue(clock.schedule, clock.cancel, 600);
    const calls: string[] = [];
    q.noteBack();
    q.whenIdle(() => calls.push('push'));
    clock.run(600); // safety timer
    clock.run(0); // the released waiter
    expect(calls).toEqual(['push']);
    expect(q.inFlight).toBe(0);
  });

  it('cancels the safety timer once the pop lands', () => {
    const clock = fakeClock();
    const q = createBackQueue(clock.schedule, clock.cancel, 600);
    q.noteBack();
    expect(clock.pendingDelays()).toContain(600);
    q.notePop();
    expect(clock.pendingDelays()).not.toContain(600);
  });
});
