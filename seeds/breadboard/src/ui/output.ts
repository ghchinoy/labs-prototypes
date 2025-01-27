/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { OutputValues, type Schema } from "../types.js";
import { StreamCapabilityType } from "../stream.js";

export type OutputArgs = Record<string, unknown> & {
  schema: Schema;
};

export class Output extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host {
          display: block;
        }
        * {
          white-space: pre-wrap;
        }
      </style>
    `;
  }

  async display(values: OutputArgs) {
    const root = this.shadowRoot!;
    const schema = values.schema;
    if (!schema || !schema.properties) {
      root.append(JSON.stringify(values, null, 2) + "\n");
      return;
    }
    await Promise.all(
      Object.entries(schema.properties).map(async ([key, property]) => {
        if (property.type === "object" && property.format === "stream") {
          await this.appendStream(
            property,
            (values[key] as StreamCapabilityType).stream
          );
          return;
        }
        const html = document.createElement("pre");
        html.innerHTML = `${values[key]}`;
        root.append(`${property.title}: `, html, "\n");
      })
    );
  }

  async appendStream(property: Schema, stream: ReadableStream) {
    type ChunkOutputs = OutputValues & { chunk: string };
    const root = this.shadowRoot;
    if (!root) return;
    root.append(`${property.title}: `);
    const pre = document.createElement("pre");
    root.append(pre);
    await stream.pipeTo(
      new WritableStream({
        write(chunk) {
          // For now, presume that the chunk is an `OutputValues` object
          // and the relevant item is keyed as `chunk`.
          const outputs = chunk as ChunkOutputs;
          pre.append(outputs.chunk);
        },
      })
    );
  }
}
