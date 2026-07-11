// ============================================================================
// CLI entry for the SCHOOL-BASED social-graph resolver (bundled by
// scripts/trace-school.mjs). Runs the same engine the browser uses, wiring the
// server-side hooks directly (Node has no CORS wall, so no edge function is
// needed). This is the fallback for players with ZERO online USCF history —
// where the tournament-graph trace has nothing to work with.
//
//   node scripts/trace-school.mjs --id 32215520
//   node scripts/trace-school.mjs --name "Aditya Brahmachary" --state WA
//
// Optional:
//   --seed-mate <handle[:platform][:name]>   (repeatable) known schoolmate
//        handle(s) to seed the crawl — mirrors "schoolmates the engine already
//        resolved". NOT the target. Lets the social crawl + ranking be exercised
//        without live Google name→handle discovery (which needs an AI key).
//   --no-web   skip the AI web/LinkedIn school search (NWSRS only).
//
// School web search (LinkedIn / state assns / registration) needs an AI/search
// key (AI_PROXY_*, GEMINI_API_KEY or ANTHROPIC_API_KEY). NWSRS needs none.
// Chess.com friends need CHESSCOM_COOKIE (a logged-in member session); without
// it the crawl leans on the fully public game-overlap signal.
// ============================================================================

import { fetchUscfMember, searchUscfByName, type UscfMember } from "../supabase/functions/resolve-identity/uscf";
import {
  findSchoolForPlayer,
  fetchSchoolRoster,
  fetchChesscomFriends,
} from "../supabase/functions/resolve-identity/school";
import { findUsernamesOnWeb } from "../supabase/functions/resolve-identity/googleSearch";
import { readEnv } from "../supabase/functions/_shared/ai";
import { runSchoolResolution, type SchoolResolverHooks } from "../src/lib/identity/schoolResolver";
import type { OnlinePlatform } from "../src/lib/identity/schoolTypes";

interface Args {
  id?: string;
  name?: string;
  state?: string;
  noWeb: boolean;
  seedMates: { platform: OnlinePlatform; username: string; name?: string }[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { noWeb: false, seedMates: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--id") a.id = argv[++i];
    else if (t === "--name") a.name = argv[++i];
    else if (t === "--state") a.state = argv[++i];
    else if (t === "--no-web") a.noWeb = true;
    else if (t === "--seed-mate") {
      const [username, platform, name] = String(argv[++i] ?? "").split(":");
      if (username) a.seedMates.push({ username, platform: platform === "lichess" ? "lichess" : "chesscom", name });
    }
  }
  return a;
}

async function pickMember(a: Args): Promise<UscfMember | null> {
  if (a.id) return await fetchUscfMember(a.id);
  if (!a.name) return null;
  const rows = await searchUscfByName(a.name, a.state);
  if (!rows.length) return null;
  rows.sort((x, y) => (y.rating || 0) - (x.rating || 0));
  return rows[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id && !args.name) {
    console.log('Usage: node scripts/trace-school.mjs --id 32215520   |   --name "First Last" --state WA');
    process.exit(1);
  }

  const member = await pickMember(args);
  const name = member?.name || args.name!;
  const state = member?.state || args.state;
  const uscfId = member?.id || args.id?.replace(/\D/g, "");
  const targetRating =
    member?.ratings.regular ?? member?.ratings.onlineRegular ?? member?.ratings.quick ?? member?.ratings.blitz;

  console.log(`\nTarget: ${name}${uscfId ? ` (USCF #${uscfId}` : ""}${state ? `, ${state}` : ""}${uscfId ? ")" : ""}`);
  console.log(`Rating: ~${targetRating ?? "?"} USCF   fideId=${member?.fideId ?? "none"}`);
  if (member && member.hasOnline) {
    console.log("NOTE: this member HAS online USCF ratings — the tournament-graph engine would run first; the school fallback is for the zero-online-history case.");
  }

  const hasAiKey = !!(
    (readEnv("AI_PROXY_BASE_URL") && readEnv("AI_PROXY_API_KEY")) ||
    readEnv("GEMINI_API_KEY") || readEnv("GOOGLE_API_KEY") || readEnv("ANTHROPIC_API_KEY")
  );
  const hasCse = !!((readEnv("GOOGLE_CSE_KEY") || readEnv("GOOGLE_SEARCH_KEY")) && (readEnv("GOOGLE_CSE_ID") || readEnv("GOOGLE_SEARCH_CX")));
  const hasFriendsCookie = !!(readEnv("CHESSCOM_COOKIE") || readEnv("CHESSCOM_SESSION"));
  console.log(
    `Discovery backends: web-school=${args.noWeb ? "off (--no-web)" : hasAiKey ? "on" : "off (no AI key)"}  ` +
      `name→handle=${hasAiKey || hasCse ? "on" : "off (no key)"}  chess.com-friends=${hasFriendsCookie ? "on" : "off (no CHESSCOM_COOKIE)"}`
  );
  if (args.seedMates.length) console.log(`Seeded schoolmate handle(s): ${args.seedMates.map((s) => `@${s.username}(${s.platform})`).join(", ")}`);

  const hooks: SchoolResolverHooks = {
    findSchool: args.noWeb
      ? async (req) => (await findSchoolForPlayer({ ...req }, (m) => console.log(`  ${m}`))).affiliations.filter((x) => x.source === "nwsrs")
      : async (req) => (await findSchoolForPlayer(req, (m) => console.log(`  ${m}`))).affiliations,
    findSchoolmates: async (school, st, source) => (await fetchSchoolRoster(school, st, source, (m) => console.log(`  ${m}`))).schoolmates,
    fetchFriends: (_platform, username) => fetchChesscomFriends(username, (m) => console.log(`  ${m}`)),
    ...(hasAiKey || hasCse
      ? { findUsernames: (req) => findUsernamesOnWeb(req, (m) => console.log(`  [google] ${m}`)).then((r) => r.candidates) }
      : {}),
  };

  console.log(`\n=== School-based resolution ===\n`);
  const t0 = Date.now();
  const result = await runSchoolResolution(
    {
      name,
      state,
      uscfId,
      targetRating,
      targetFideId: member?.fideId,
      seedSchoolmates: args.seedMates,
    },
    { log: (m) => console.log(`  ${m}`), hooks }
  );

  console.log(`\n=== Result (${Math.round((Date.now() - t0) / 1000)}s) ===`);
  console.log(`found=${result.found}  school=${result.school ?? "?"}  schoolmatesResolved=${result.schoolmatesResolved}`);
  console.log(`notes: ${result.notes.join(" | ")}`);
  for (const acc of result.accounts) {
    console.log(`\n@${acc.username} on ${acc.platform} — confidence ${(acc.confidence * 100).toFixed(0)}%`);
    console.log(`  name=${acc.displayName ?? "-"} rating=${acc.rating ?? "?"} country=${acc.country ?? "?"} url=${acc.profileUrl}`);
    for (const e of acc.evidence) console.log(`  [${e.weight >= 0 ? "+" : ""}${e.weight.toFixed(2)}] ${e.label}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(10);
});
