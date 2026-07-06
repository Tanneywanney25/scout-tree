// Regression proof for time-control scoping: parseEventTc/gameMatchesTc over
// the real formats MUIR and the platforms emit, plus the ground-truth case that
// motivated it (PNWCC_G60_ONLINE_NOV_12: 23 window games, exactly 4 at G/60;+5
// — precisely the crosstable rounds). Bundled + run by scripts/test-tc.mjs.
import { parseEventTc, gameMatchesTc } from "../src/lib/identity/uscfGraphEngine";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

// --- parseEventTc over real MUIR strings -----------------------------------
const g60p5 = parseEventTc("G/60;+5");
check("G/60;+5 parses", !!g60p5 && g60p5.baseSecs === 3600 && g60p5.incSecs === 5, JSON.stringify(g60p5));
const g60p10 = parseEventTc("G/60;+10");
check("G/60;+10 parses", !!g60p10 && g60p10.baseSecs === 3600 && g60p10.incSecs === 10);
const g45inc = parseEventTc("G/45;inc/15");
check("G/45;inc/15 parses", !!g45inc && g45inc.baseSecs === 2700 && g45inc.incSecs === 15);
const g25d5 = parseEventTc("G/25 d5");
check("G/25 d5 parses as delay", !!g25d5 && g25d5.baseSecs === 1500 && g25d5.incSecs === undefined && g25d5.delaySecs === 5);
const g90p30 = parseEventTc("G/90;+30");
check("G/90;+30 parses", !!g90p30 && g90p30.baseSecs === 5400 && g90p30.incSecs === 30);
check("multi-stage 40/90;SD/30 returns null", parseEventTc("40/90;SD/30 +30") === null);
check("empty/undefined returns null", parseEventTc(undefined) === null && parseEventTc("") === null);

// --- gameMatchesTc ----------------------------------------------------------
const tc = g60p5!;
check("3600+5 matches G/60;+5", gameMatchesTc({ baseSecs: 3600, incSecs: 5 }, tc));
check("3600+0 does NOT match G/60;+5", !gameMatchesTc({ baseSecs: 3600, incSecs: 0 }, tc));
check("180+2 does NOT match G/60;+5", !gameMatchesTc({ baseSecs: 180, incSecs: 2 }, tc));
check("daily (no clock) does NOT match", !gameMatchesTc({}, tc));
const d5 = g25d5!;
check("1500+5 matches G/25 d5 (delay≈inc)", gameMatchesTc({ baseSecs: 1500, incSecs: 5 }, d5));
check("1500+0 matches G/25 d5 (delay dropped)", gameMatchesTc({ baseSecs: 1500, incSecs: 0 }, d5));
check("1500+3 does NOT match G/25 d5", !gameMatchesTc({ baseSecs: 1500, incSecs: 3 }, d5));

// --- the NoobSIaya ground-truth window (real clocks, Nov 11-13 2022) --------
// 23 in-window games: 18× 180+0 blitz, 1× daily, 4× 3600+5 — the four
// crosstable rounds. TC scoping must keep exactly the 4.
const window: { baseSecs?: number; incSecs?: number }[] = [
  ...Array.from({ length: 18 }, () => ({ baseSecs: 180, incSecs: 0 })),
  {}, // daily 1/259200 — no live clock
  { baseSecs: 3600, incSecs: 5 },
  { baseSecs: 3600, incSecs: 5 },
  { baseSecs: 3600, incSecs: 5 },
  { baseSecs: 3600, incSecs: 5 },
];
const kept = window.filter((g) => gameMatchesTc(g, tc));
check("NoobSIaya window scopes 23 → 4", kept.length === 4, `kept ${kept.length}`);

process.exit(failures ? 1 : 0);
