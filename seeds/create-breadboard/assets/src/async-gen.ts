/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

type AsyncGenNext<T> = (value: T) => Promise<void>;
type AsyncGenCallback<T> = (next: AsyncGenNext<T>) => Promise<void>;

/**
 * Converts async/await style code into an async generator.
 * Useful when you need to combine arrow-style functions and yield.
 *
 * Example:
 *
 * ```ts
 * async function* foo() {
 *   yield 1;
 *   yield* asyncGen(async (next) => {
 *     await next(2);
 *     await next(3);
 *   });
 *   yield 4;
 * }
 *
 * for await (const val of foo()) {
 *   console.log(val);
 * }
 * ```
 *
 * This code will print:
 *
 * ```
 * 1
 * 2
 * 3
 * 4
 * ```
 *
 * @param callback A callback that will be called with a `next` function.
 * The callback should call `next` with the next value to yield.
 * @returns An async generator.
 */
export const asyncGen = <T>(callback: AsyncGenCallback<T>) => {
  type MaybeT = T | undefined;
  let proceedToNext: (() => void) | undefined;
  let nextCalled: (value: MaybeT) => void;

  const next = async (result: T) => {
    nextCalled(result);
    return new Promise<void>((resolve) => {
      proceedToNext = resolve;
    });
  };

  return {
    [Symbol.asyncIterator]() {
      let waitForCallbackToCallNext: Promise<MaybeT>;
      let done = false;
      const resolver = (resolve: (value: MaybeT) => void) => {
        nextCalled = resolve;
      };

      waitForCallbackToCallNext = new Promise<MaybeT>(resolver);
      proceedToNext = () => {
        callback(next).then(() => {
          done = true;
          nextCalled(undefined);
        });
      };
      return {
        async next() {
          proceedToNext && proceedToNext();
          const value = await waitForCallbackToCallNext;
          waitForCallbackToCallNext = new Promise<MaybeT>(resolver);
          return { done, value };
        },
      };
    },
  };
};

export type PatchedReadableStream<T> = ReadableStream<T> & AsyncIterable<T>;

// A polyfill for ReadableStream.from:
// See https://streams.spec.whatwg.org/#rs-from
// TODO: Do a proper TypeScript types polyfill.
export const streamFromAsyncGen = <T>(
  iterator: AsyncIterableIterator<T>
): PatchedReadableStream<T> => {
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();

      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
  }) as PatchedReadableStream<T>;
};

// Polyfill to make ReadableStream async iterable
// See https://bugs.chromium.org/p/chromium/issues/detail?id=929585
export const patchReadableStream = () => {
  // eslint-disable-next-line
  // @ts-ignore
  ReadableStream.prototype[Symbol.asyncIterator] ||
    // eslint-disable-next-line
    // @ts-ignore
    (ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
      const reader = this.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    });
};

/**
 * A helper class for keeping track of the last message in a stream.
 *
 * Example:
 *
 * ```ts
 * const keeper = new LastMessageKeeper<string>();
 * const stream = new ReadableStream({
 *  start: (controller) => {
 *   controller.enqueue("foo");
 *   controller.enqueue("bar");
 *   controller.enqueue("baz");
 *   controller.close();
 * });
 * stream.pipeThrough(keeper.watch());
 * console.log(keeper.lastMessage()); // "baz"
 */
export class LastMessageKeeper<Res> {
  #lastMessage: Res | undefined;

  watch() {
    return new TransformStream({
      transform: (chunk, controller) => {
        this.#lastMessage = chunk;
        controller.enqueue(chunk);
      },
    });
  }

  lastMessage(): Res | undefined {
    return this.#lastMessage;
  }
}
