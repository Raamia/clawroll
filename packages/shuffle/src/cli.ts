#!/usr/bin/env node
/**
 * `clawroll-verify` — check a published Clawroll hand from the command line.
 *
 *   clawroll-verify hand-12345.json
 *   curl -s https://clawroll.example/hands/12345/proof | clawroll-verify
 *
 * Exits 0 if the hand verifies and 1 if it does not, so it drops straight into a
 * script or a CI job. The point of shipping this as a standalone tool is that nobody
 * has to take Clawroll's word for a deal — including people who do not trust
 * Clawroll's website to tell them the truth about Clawroll.
 */

import { readFileSync } from 'node:fs';
import { type HandProof, formatResult, verifyHand } from './verify.js';

const USAGE = `clawroll-verify — verify a published Clawroll hand

Usage:
  clawroll-verify <proof.json>    verify a proof file
  clawroll-verify -               read the proof from stdin

The proof is JSON:
  {
    "handId":      "h-12345",
    "commit":      "<sha256 published before the deal>",
    "serverSeed":  "<seed revealed at hand end>",
    "clientSeeds": [{ "seat": 0, "seed": "<hex>" }],
    "seats":       [0, 1, 2],
    "buttonSeat":  0,
    "holeCards":   [{ "seat": 0, "cards": "AsKd" }],
    "board":       "2h5s9cJdTh"
  }

Only handId, commit, serverSeed and clientSeeds are required; supplying seats,
buttonSeat, holeCards and board additionally checks the cards actually dealt.

Exit code 0 means verified, 1 means it does not match.`;

function readProof(source: string): HandProof {
  const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  try {
    return JSON.parse(raw) as HandProof;
  } catch (error) {
    throw new Error(`could not parse proof as JSON: ${(error as Error).message}`);
  }
}

function main(argv: readonly string[]): number {
  const [source] = argv;

  if (source === undefined || source === '-h' || source === '--help') {
    console.log(USAGE);
    return source === undefined ? 1 : 0;
  }

  let result;
  try {
    result = verifyHand(readProof(source));
  } catch (error) {
    console.error(`clawroll-verify: ${(error as Error).message}`);
    return 1;
  }

  console.log(formatResult(result));
  return result.ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
