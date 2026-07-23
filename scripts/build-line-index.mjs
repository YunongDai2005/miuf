import { readFile, writeFile } from "node:fs/promises";

const input = new URL("../public/berlin-transit.json", import.meta.url);
const output = new URL("../public/berlin-lines.json", import.meta.url);
const network = JSON.parse(await readFile(input, "utf8"));
const keys = ["id", "mode", "ref", "name", "color", "textColor"];
const operators = Object.fromEntries(
  network.lines.flatMap((line) =>
    (line.operators ?? []).map((operator) => [operator.id, operator])
  )
);
const payload = {
  source: network.source,
  sourceUrl: network.sourceUrl,
  sourceUpdatedAt: network.sourceUpdatedAt,
  license: network.license,
  operators,
  lines: network.lines.map((line) => ({
    ...Object.fromEntries(keys.map((key) => [key, line[key]])),
    operatorIds: (line.operators ?? []).map((operator) => operator.id),
  })),
};

await writeFile(output, JSON.stringify(payload));
console.log(`Wrote ${payload.lines.length} line summaries to ${output.pathname}`);
