// ============================================================================
// CLI entry for the tournament-graph username trace (bundled by
// scripts/trace-username.mjs). Runs the SAME engine the browser uses, but
// builds the USCF tournament graph directly against the MUIR API — Node has no
// CORS wall, so no edge function is needed. Great for testing the detective
// end-to-end from a terminal:
//
//   node scripts/trace-username.mjs --name "First Last" [--state XX]
//   node scripts/trace-username.mjs --id 12345678 [--budget 300] [--list]
//
// `--budget 0` removes the time limit entirely (run until exhausted, like the
// app). With GEMINI_API_KEY / ANTHROPIC_API_KEY (and optionally GOOGLE_CSE_KEY
// + GOOGLE_CSE_ID) in the environment, the Google-index username discovery and
// flyer search hooks run exactly as they do in production.
// ============================================================================

import {
  searchUscfByName,
  fetchUscfMember,
  buildOnlineGraphForMember,
  type UscfMember,
} from "../supabase/functions/resolve-identity/uscf";
import {
  findUsernamesOnWeb,
  discoverEventOnWeb,
} from "../supabase/functions/resolve-identity/googleSearch";
import { readEnv } from "../supabase/functions/_shared/ai";
import { runGraphTraversal, type TraversalHooks } from "../src/lib/identity/uscfGraphEngine";
import type { TournamentGraph } from "../src/lib/identity/graphTypes";

interface Args {
  id?: string;
  name?: string;
  state?: string;
  budget: number;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { budget: 300, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") args.id = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--state") args.state = argv[++i];
    else if (a === "--budget") args.budget = Number(argv[++i] ?? "300");
    else if (a === "--list") args.list = true;
  }
  return args;
}

async function pickMember(args: Args): Promise<UscfMember | null> {
  if (args.id) return await fetchUscfMember(args.id);
  if (!args.name) return null;
  const rows = await searchUscfByName(args.name, args.state);
  if (!rows.length) return null;
  const online = rows.filter((r) => r.hasOnline);
  const pool = online.length ? online : rows;
  pool.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  console.log(
    `USCF search: ${rows.length} member(s), ${online.length} with online ratings.` +
      (pool.length > 1 ? ` Using the strongest online-rated match; pass --id to pick another:` : "")
  );
  for (const r of rows.slice(0, 6)) {
    console.log(`  #${r.id}  ${r.name}  ${r.state || "--"}  rating=${r.rating ?? "?"}  online=${r.hasOnline ? "yes" : "no"}`);
  }
  return pool[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id && !args.name) {
    console.log('Usage: node scripts/trace-username.mjs --name "First Last" [--state XX] [--id USCFID] [--budget seconds] [--list]');
    process.exit(1);
  }

  const member = await pickMember(args);
  if (!member) {
    console.error("No USCF member found for that query.");
    process.exit(2);
  }
  console.log(`\nTarget: ${member.name} (USCF #${member.id}${member.state ? `, ${member.state}` : ""})`);
  console.log(`Ratings: ${JSON.stringify(member.ratings)}  fideId=${member.fideId ?? "none"}\n`);
  if (!member.hasOnline) {
    console.error("Member has no online (OR/OQ/OB) ratings — nothing to traverse.");
    process.exit(3);
  }

  // Cache the graph between runs — MUIR rate-limits repeated full builds.
  const fs = await import("node:fs");
  const cachePath = `node_modules/.trace-graph-${member.id}.json`;
  let sections: Awaited<ReturnType<typeof buildOnlineGraphForMember>> | null = null;
  if (!process.argv.includes("--fresh") && fs.existsSync(cachePath)) {
    try {
      sections = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      console.log("Using cached tournament graph (pass --fresh to rebuild).");
    } catch {
      sections = null;
    }
  }
  if (!sections) {
    console.log("Building the online tournament graph from MUIR…");
    sections = await buildOnlineGraphForMember(member, { maxSections: 16, maxEvents: 100 });
    try {
      fs.writeFileSync(cachePath, JSON.stringify(sections));
    } catch {
      /* cache is best-effort */
    }
  }
  const graph: TournamentGraph = {
    rootUscfId: member.id,
    rootName: member.name,
    rootState: member.state,
    onlineEvents: sections,
    graphTraversalReady: sections.length > 0,
  };
  console.log(`Graph: ${sections.length} online section(s).`);
  for (const s of sections) {
    const me = s.players.find((p) => p.isTarget);
    console.log(
      `  [${s.eventId}] ${s.name}${s.sectionName ? ` — ${s.sectionName}` : ""} (${s.ratingSystem}, ${s.startDate ?? "?"}..${
        s.endDate ?? "?"
      }) players=${s.players.length} myGames=${me?.games.length ?? 0} platformGuess=${s.platformGuess ?? "-"}`
    );
  }
  if (!sections.length) process.exit(4);
  if (args.list) {
    for (const s of sections) {
      console.log(`\nRoster of ${s.name}${s.sectionName ? ` — ${s.sectionName}` : ""}:`);
      for (const p of s.players) {
        console.log(`  ${p.isTarget ? "*" : " "} ${p.name} (#${p.uscfId}, ${p.rating ?? "?"}) games=${p.games.length}`);
      }
    }
    return;
  }

  const targetRating =
    member.ratings.onlineRegular ?? member.ratings.onlineQuick ?? member.ratings.onlineBlitz ?? member.ratings.regular;

  // Same hooks the browser wires via the edge function — here they run
  // directly. Google-index discovery + flyer search need an AI/search key.
  const hasAiKey = !!(readEnv("GEMINI_API_KEY") || readEnv("GOOGLE_API_KEY") || readEnv("ANTHROPIC_API_KEY"));
  const hasCse = !!((readEnv("GOOGLE_CSE_KEY") || readEnv("GOOGLE_SEARCH_KEY")) && (readEnv("GOOGLE_CSE_ID") || readEnv("GOOGLE_SEARCH_CX")));
  if (!hasAiKey && !hasCse) {
    console.log("NOTE: no GEMINI_API_KEY/ANTHROPIC_API_KEY (or GOOGLE_CSE_KEY+GOOGLE_CSE_ID) in env — Google-index username discovery and flyer search are OFF for this run.");
  }
  const expandCache = new Map<string, Promise<TournamentGraph | null>>();
  // Memoize the web-search hooks across the WHOLE run (the engine memoizes
  // per traversal instance; deep-phase sub-traversals are separate instances
  // and must not repeat an identical Google search / flyer lookup).
  const usernameMemo = new Map<string, ReturnType<NonNullable<TraversalHooks["findUsernames"]>>>();
  const discoverMemo = new Map<string, ReturnType<NonNullable<TraversalHooks["discoverPlatform"]>>>();
  const hooks: TraversalHooks = {
    ...(hasAiKey || hasCse
      ? {
          findUsernames: (req) => {
            const key = JSON.stringify([req.name.toLowerCase(), req.state, req.uscfRating, req.fideId, req.eventName]);
            const hit = usernameMemo.get(key);
            if (hit) return hit;
            const p = findUsernamesOnWeb(req, (m) => console.log(`  [google] ${m}`)).then((r) => r.candidates);
            usernameMemo.set(key, p);
            return p;
          },
        }
      : {}),
    ...(hasAiKey
      ? {
          discoverPlatform: (ev) => {
            const hit = discoverMemo.get(ev.eventId);
            if (hit) return hit;
            const p = discoverEventOnWeb(ev).then((info) =>
              info
                ? {
                    platform: info.platform,
                    chesscomSlugs: info.chesscomSlugs,
                    lichessSwissIds: info.lichessSwissIds,
                    lichessArenaIds: info.lichessArenaIds,
                    confidence: info.confidence,
                    note: info.note,
                  }
                : null
            );
            discoverMemo.set(ev.eventId, p);
            return p;
          },
        }
      : {}),
    expandMember: (memberId: string) => {
      const cached = expandCache.get(memberId);
      if (cached) return cached;
      const p = (async (): Promise<TournamentGraph | null> => {
        const m = await fetchUscfMember(memberId);
        if (!m) return null;
        const secs = await buildOnlineGraphForMember(m, { maxSections: 6, maxEvents: 24 });
        return {
          rootUscfId: m.id,
          rootName: m.name,
          rootState: m.state,
          onlineEvents: secs,
          graphTraversalReady: secs.length > 0,
        };
      })().catch(() => null);
      expandCache.set(memberId, p);
      return p;
    },
  };

  const unlimited = !args.budget || args.budget <= 0;
  console.log(`\n=== Tracing (${unlimited ? "no time limit — runs until exhausted" : `budget ${args.budget}s`}) ===\n`);
  const t0 = Date.now();
  const result = await runGraphTraversal(graph, {
    targetName: member.name,
    targetRating,
    targetFideId: member.fideId,
    ...(unlimited ? {} : { budgetMs: args.budget * 1000 }),
    hooks,
    log: (m) => console.log(`  ${m}`),
  });

  console.log(`\n=== Result (${Math.round((Date.now() - t0) / 1000)}s) ===`);
  console.log(`found=${result.found}  notes: ${result.notes.join(" | ")}`);
  for (const acc of result.accounts) {
    console.log(`\n@${acc.username} on ${acc.platform} — confidence ${(acc.confidence * 100).toFixed(0)}%`);
    console.log(`  name=${acc.displayName ?? "-"} rating=${acc.rating ?? "?"} url=${acc.profileUrl}`);
    for (const e of acc.evidence) console.log(`  [${e.weight >= 0 ? "+" : ""}${e.weight.toFixed(2)}] ${e.label}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(10);
});
