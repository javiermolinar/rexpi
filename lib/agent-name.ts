import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "amber", "brave", "calm", "clever", "cosmic", "crimson", "curious", "dapper",
  "eager", "electric", "emerald", "fuzzy", "gentle", "golden", "happy", "indigo",
  "jolly", "keen", "lively", "lucky", "mellow", "mighty", "misty", "nimble",
  "opal", "patient", "playful", "polished", "proud", "quiet", "rapid", "ruby",
  "silver", "sleek", "sunny", "swift", "teal", "tidy", "violet", "witty",
] as const;
const NOUNS = [
  "badger", "bison", "cat", "cobra", "crane", "crow", "deer", "dolphin",
  "dove", "dragon", "eagle", "falcon", "finch", "fox", "frog", "gecko",
  "goose", "hawk", "heron", "koala", "lemur", "lion", "lynx", "marmot",
  "mole", "moose", "newt", "otter", "owl", "panda", "parrot", "penguin",
  "puma", "rabbit", "raven", "robin", "seal", "sparrow", "tiger", "wolf",
] as const;
const NAME = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*){1,3}$/;

/** Display/lookup validation. Generated names use two lowercase ASCII words. */
export function parseAgentName(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !NAME.test(value))
    throw new Error("Invalid agent name; expected lowercase words separated by hyphens");
  return value;
}

/** User input is case-insensitive, but stored names and filenames are canonical lowercase. */
export function canonicalAgentName(value: unknown): string {
  return parseAgentName(typeof value === "string" ? value.normalize("NFC").trim().toLowerCase() : value);
}

export function generateAgentName(): string {
  return ADJECTIVES[randomInt(ADJECTIVES.length)] + "-" + NOUNS[randomInt(NOUNS.length)];
}
