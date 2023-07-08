/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Breadboard, Core } from "@google-labs/breadboard";
import { writeFile } from "fs/promises";

/** Just playing with the API for now */

// Instance of a graph.
const breadboard = new Breadboard();
// Core handlers.
const n = new Core(breadboard);

const summarizeResults = n.textTemplate({
  template:
    "Use the news headlines below to write a few sentences to summarize the latest news on this topic:\n\n##Topic:\n{{topic}}\n\n## Headlines {{headlines}}\n\\n## Summary:\n",
});

const newsUrl = n.urlTemplate({
  template:
    "https://news.google.com/rss/search?q={{query}}&hl=en-US&gl=US&ceid=US:en",
});

n.input({
  message: "What do you want to search for?",
})
  .wire("text->topic", summarizeResults)
  .wire("text->query", newsUrl);

const fetchHeadlines = n.fetch({ raw: true });

// "url" --> "url:url"
newsUrl.wire("url", fetchHeadlines);

const parseHeadlines = n.jsonata({
  expression: "$join((rss.channel.item.title.`$t`)[[1..20]], `\n`)",
});

// "json" --> "json:json"
fetchHeadlines.wire(
  "response->xml",
  n
    .xmlToJson()
    .wire("json", parseHeadlines.wire("result->headlines", summarizeResults))
);

const textCompletion = n.textCompletion().wire("completion->text", n.output());

n.secrets({ keys: ["API_KEY"] }).wire("API_KEY", textCompletion);

summarizeResults.wire("prompt->text", textCompletion);

// Save breadboard
await writeFile("examples/google-news-2.json", JSON.stringify(breadboard));

breadboard.on("input", async () => {
  // supply input
});

breadboard.on("output", async () => {
  // process output
});

// Run breadboard
await breadboard.run();
