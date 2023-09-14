/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Board, RunResult } from "@google-labs/breadboard";
import { Request, Response } from "express";
import { Store } from "./store.js";
import { GraphMetadata, InputValues } from "@google-labs/graph-runner";
import { Writer, WriterResponse } from "./writer.js";
import { createRequire } from "module";

export type ServerRequest = Pick<Request, "path" | "method" | "body">;
export type ServerResponse = Pick<
  Response,
  "send" | "status" | "type" | "sendFile" | "end"
> &
  WriterResponse;

export async function runResultLoop(
  writer: Writer,
  board: Board,
  inputs: InputValues,
  runResult: RunResult | undefined
) {
  if (runResult && runResult.type === "input") {
    runResult.inputs = inputs;
  }
  for await (const stop of board.run(undefined, undefined, runResult)) {
    if (stop.type === "beforehandler") {
      writer.writeBeforeHandler(stop);
      continue;
    }
    if (stop.type === "input") {
      // TODO: This case is for the "runOnce" invocation, where the board
      // isn't expected to stream outputs and inputs.
      if (inputs && Object.keys(inputs).length > 0) {
        stop.inputs = inputs;
        continue;
      }
      await writer.writeInput(stop);
      return;
    }
    if (stop.type === "output") {
      await writer.writeOutput(stop);
      return;
    }
  }

  writer.writeDone();
}

const IMPORTS_PREFIX = "/node_modules/@google-labs/";

const BREADBOARD_ENTRY_SUFFIX = "/index.js";

export const resolveModulePath = (path: string): string => {
  // This is intentionally hacky. It will be replaced with just serving
  // Breadboard from jsdelivr.
  const [, , project, name, ...rest] = path.split("/");

  // Get the package.
  const packageName = `${project}/${name}`;
  const require = createRequire(import.meta.url);
  const breadboardEntry = require.resolve(packageName);

  if (!breadboardEntry.endsWith(BREADBOARD_ENTRY_SUFFIX))
    throw new Error(`Could not correctly resolve "${packageName}" entry`);
  const basePath = breadboardEntry.substring(
    0,
    breadboardEntry.length - BREADBOARD_ENTRY_SUFFIX.length
  );
  return `${basePath}/${rest.join("/")}`;
};

export const handleNonPostRequest = (
  { url, title, description, version }: GraphMetadata,
  req: ServerRequest,
  res: ServerResponse
): boolean => {
  if (req.method === "POST") return false;
  if (req.method !== "GET") {
    res.status(405);
    res.send("Method not allowed");
    return true;
  }
  if (req.path === "/") {
    res.sendFile(new URL("../../public/index.html", import.meta.url).pathname);
    return true;
  } else if (req.path === "/info") {
    res.type("application/json");
    res.send({ url, title, description, version });
    return true;
  } else if (req.path.startsWith(IMPORTS_PREFIX)) {
    res.sendFile(resolveModulePath(req.path));
    return true;
  }

  res.status(404);
  res.send("Not found");
  return true;
};

export const makeCloudFunction = (url: string) => {
  return async (req: ServerRequest, res: ServerResponse) => {
    // TODO: Handle loading errors here.
    const board = await Board.load(url);

    if (handleNonPostRequest(board, req, res)) return;

    const store = new Store("breadboard-state");

    const { state, inputs } = req.body;

    const writer = new Writer(res, async (newState) =>
      store.saveBoardState(state || "", newState)
    );

    res.type("application/json");

    try {
      const savedState = await store.loadBoardState(state);
      const runResult = savedState ? RunResult.load(savedState) : undefined;

      await runResultLoop(writer, board, inputs, runResult);
    } catch (e) {
      console.error(e);
      const error = e as Error;
      writer.writeError(error);
    }

    writer.writeStop();
    res.end();
  };
};
