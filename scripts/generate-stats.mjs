#!/usr/bin/env node
/**
 * Renders every card used by the profile README straight into `assets/`.
 *
 * The README used to embed third party card services (github-profile-summary-cards,
 * streak-stats, activity-graph, ...). Those run on shared free instances and answer with
 * "Cards are temporarily rate limited" whenever the instance is busy, which broke the
 * README for visitors (issue #1). Everything is generated here instead and the SVGs are
 * committed, so GitHub only ever serves static files from this repository.
 *
 * Usage: GITHUB_TOKEN=<token> node scripts/generate-stats.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");

const LOGIN = process.env.GH_LOGIN || "Isma-L154";
const TOKEN = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN;

const T = {
  bg0: "#0C0E11",
  bg1: "#08090B",
  bar0: "#151920",
  bar1: "#0F1216",
  border: "#242932",
  accent: "#39D353",
  text: "#E8EBEF",
  sub: "#B6BCC4",
  dim: "#8B939E",
  muted: "#5A616C",
  grid: "#1B2027",
  font: "&apos;JetBrains Mono&apos;,&apos;DejaVu Sans Mono&apos;,monospace",
};

/* ------------------------------------------------------------------ helpers */

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const num = (n) => Number(n || 0).toLocaleString("en-US");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().slice(0, 10);
const short = (d) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

const monthYear = (d) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/* --------------------------------------------------------------- github api */

async function gql(query, variables) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": `${LOGIN}-profile-stats`,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      lastError = err;
      await sleep(attempt * 2000);
      continue;
    }
    if ([429, 502, 503, 504].includes(res.status)) {
      lastError = new Error(`GitHub API responded ${res.status}`);
      await sleep(attempt * 2000);
      continue;
    }
    const body = await res.json();
    if (!res.ok) throw new Error(`GitHub API responded ${res.status}: ${JSON.stringify(body)}`);
    if (body.errors) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
    return body.data;
  }
  throw lastError;
}

const PROFILE_QUERY = `
query($login: String!) {
  user(login: $login) {
    name
    login
    createdAt
    followers { totalCount }
    pullRequests { totalCount }
    issues { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestReviewContributions
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

const CALENDAR_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

/** Contribution calendars are capped at one year, so walk the account year by year. */
async function fetchCalendar(createdAt) {
  const start = new Date(createdAt);
  const now = new Date();
  const days = new Map();
  for (let year = start.getUTCFullYear(); year <= now.getUTCFullYear(); year++) {
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
    const data = await gql(CALENDAR_QUERY, {
      login: LOGIN,
      from: (from < start ? start : from).toISOString(),
      to: (to > now ? now : to).toISOString(),
    });
    for (const week of data.user.contributionsCollection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) days.set(day.date, day.contributionCount);
    }
  }
  return [...days.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------------------------------------------------------ streaks */

function computeStreaks(days) {
  const total = days.reduce((acc, d) => acc + d.count, 0);
  let longest = { length: 0, start: null, end: null };
  let run = { length: 0, start: null, end: null };

  for (const day of days) {
    if (day.count > 0) {
      run = { length: run.length + 1, start: run.length ? run.start : day.date, end: day.date };
      if (run.length > longest.length) longest = { ...run };
    } else {
      run = { length: 0, start: null, end: null };
    }
  }

  // A day with no contributions yet does not break the current streak until it ends.
  const current = { length: 0, start: null, end: null };
  const today = iso(new Date());
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (day.count === 0) {
      if (day.date === today && current.length === 0) continue;
      break;
    }
    current.length += 1;
    current.start = day.date;
    if (!current.end) current.end = day.date;
  }

  return { total, longest, current, first: days[0]?.date ?? today, last: today };
}

/* --------------------------------------------------------------- svg chrome */

function card({ width, height, title, body, defs = "" }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${T.bg0}"/>
      <stop offset="1" stop-color="${T.bg1}"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${T.bar0}"/>
      <stop offset="1" stop-color="${T.bar1}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="1.05" r="0.85">
      <stop offset="0" stop-color="${T.accent}" stop-opacity="0.18"/>
      <stop offset="1" stop-color="${T.accent}" stop-opacity="0"/>
    </radialGradient>${defs}
  </defs>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="url(#bg)" stroke="${T.border}" stroke-width="1"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="url(#glow)"/>
  <path d="M0.5,14.5 A14,14 0 0 1 14.5,0.5 H${width - 14.5} A14,14 0 0 1 ${width - 0.5},14.5 V36.5 H0.5 Z" fill="url(#bar)"/>
  <line x1="0.5" y1="36.5" x2="${width - 0.5}" y2="36.5" stroke="${T.border}" stroke-width="1"/>
  <circle cx="22" cy="18.5" r="5" fill="#FF5F57"/>
  <circle cx="40" cy="18.5" r="5" fill="#FFBD2E"/>
  <circle cx="58" cy="18.5" r="5" fill="#28C840"/>
  <text x="80" y="22.5" font-family="${T.font}" font-size="11" fill="${T.muted}" letter-spacing="1">${esc(title)}</text>
${body}
</svg>
`;
}

const text = (x, y, value, { size = 13, fill = T.sub, weight = "normal", anchor = "start" } = {}) =>
  `  <text x="${x}" y="${y}" font-family="${T.font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;

const prompt = (x, y, command) =>
  [text(x, y, "$", { fill: T.accent, weight: "bold" }), text(x + 16, y, command, { fill: T.dim })].join("\n");

/* -------------------------------------------------------------------- cards */

const CARD_W = 460;
const CARD_H = 232;

function statsCard(user, stars) {
  const rows = [
    ["repositories", num(user.repositories.totalCount)],
    ["stars earned", num(stars)],
    ["commits (1y)", num(user.contributionsCollection.totalCommitContributions)],
    ["pull requests", num(user.pullRequests.totalCount)],
    ["issues", num(user.issues.totalCount)],
    ["code reviews", num(user.contributionsCollection.totalPullRequestReviewContributions)],
    ["followers", num(user.followers.totalCount)],
  ];
  const body = [
    prompt(22, 62, `stats --user ${LOGIN}`),
    ...rows.flatMap(([label, value], i) => {
      const y = 92 + i * 20;
      return [
        text(22, y, label, { fill: T.dim, size: 12.5 }),
        text(CARD_W - 22, y, value, { fill: T.text, size: 12.5, weight: "bold", anchor: "end" }),
      ];
    }),
  ].join("\n");
  return card({ width: CARD_W, height: CARD_H, title: "~/stats", body });
}

function streakCard(streaks) {
  const col = CARD_W / 3;
  const range = (streak) => (streak.length > 0 ? `${short(streak.start)} - ${short(streak.end)}` : "no streak yet");

  const block = (index, label, value, caption, highlight) => {
    const cx = col * index + col / 2;
    const out = [];
    if (highlight) {
      out.push(
        `  <circle cx="${cx}" cy="118" r="40" fill="none" stroke="${T.accent}" stroke-width="2" opacity="0.9"/>`,
        `  <circle cx="${cx}" cy="118" r="46" fill="none" stroke="${T.accent}" stroke-width="1" opacity="0.25"/>`
      );
    }
    out.push(
      text(cx, 128, String(value), {
        size: highlight ? 32 : 28,
        weight: "bold",
        fill: highlight ? T.accent : T.text,
        anchor: "middle",
      }),
      text(cx, 180, label, { size: 11.5, fill: highlight ? T.accent : T.sub, anchor: "middle", weight: "bold" }),
      text(cx, 199, caption, { size: 10, fill: T.muted, anchor: "middle" })
    );
    return out.join("\n");
  };

  const body = [
    prompt(22, 62, "streak --all-time"),
    block(0, "Total", num(streaks.total), `since ${monthYear(streaks.first)}`, false),
    block(1, "Current streak", num(streaks.current.length), range(streaks.current), true),
    block(2, "Longest streak", num(streaks.longest.length), range(streaks.longest), false),
    `  <line x1="${col}" y1="80" x2="${col}" y2="208" stroke="${T.border}" stroke-width="1"/>`,
    `  <line x1="${col * 2}" y1="80" x2="${col * 2}" y2="208" stroke="${T.border}" stroke-width="1"/>`,
  ].join("\n");
  return card({ width: CARD_W, height: CARD_H, title: "~/streak", body });
}

function languagesCard(repos) {
  const totals = new Map();
  for (const repo of repos) {
    for (const edge of repo.languages.edges) {
      const entry = totals.get(edge.node.name) || { size: 0, color: edge.node.color || T.dim };
      entry.size += edge.size;
      totals.set(edge.node.name, entry);
    }
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1].size - a[1].size);
  const grand = sorted.reduce((acc, [, v]) => acc + v.size, 0) || 1;
  const top = sorted.slice(0, 8).map(([name, v]) => ({ name, color: v.color, pct: (v.size / grand) * 100 }));

  const barX = 22;
  const barW = CARD_W - 44;
  let offset = barX;
  const segments = top.map((lang) => {
    const w = Math.max((lang.pct / 100) * barW, 2);
    const seg = `    <rect x="${offset.toFixed(1)}" y="84" width="${w.toFixed(1)}" height="12" fill="${lang.color}"/>`;
    offset += w;
    return seg;
  });

  const legend = top.flatMap((lang, i) => {
    const column = i % 2;
    const row = Math.floor(i / 2);
    const x = barX + column * (barW / 2);
    const y = 132 + row * 24;
    return [
      `  <circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${lang.color}"/>`,
      text(x + 18, y, lang.name, { size: 12, fill: T.sub }),
      text(x + barW / 2 - 18, y, `${lang.pct.toFixed(1)}%`, { size: 12, fill: T.dim, anchor: "end" }),
    ];
  });

  const defs = `
    <clipPath id="langclip"><rect x="${barX}" y="84" width="${barW}" height="12" rx="6"/></clipPath>`;

  const body = [
    prompt(22, 62, "languages --top 8"),
    `  <rect x="${barX}" y="84" width="${barW}" height="12" rx="6" fill="${T.grid}"/>`,
    `  <g clip-path="url(#langclip)">`,
    ...segments,
    `  </g>`,
    ...legend,
  ].join("\n");
  return card({ width: CARD_W, height: CARD_H, title: "~/languages", body, defs });
}

function weekdayCard(days) {
  const recent = days.slice(-365);
  const buckets = new Array(7).fill(0);
  for (const day of recent) buckets[new Date(`${day.date}T00:00:00Z`).getUTCDay()] += day.count;
  // Render Monday first, the way a work week reads.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const values = order.map((d) => buckets[d]);
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const max = Math.max(...values, 1);
  const best = labels[values.indexOf(Math.max(...values))];

  const baseline = 176;
  const maxH = 78;
  const slot = (CARD_W - 44) / 7;
  const barW = 26;

  const bars = values.flatMap((value, i) => {
    const h = Math.max((value / max) * maxH, 2);
    const x = 22 + slot * i + (slot - barW) / 2;
    const y = baseline - h;
    const isBest = labels[i] === best;
    return [
      `  <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="4" fill="${T.accent}" opacity="${isBest ? 1 : 0.45}"/>`,
      text(x + barW / 2, y - 7, `${Math.round((value / total) * 100)}%`, {
        size: 10,
        fill: isBest ? T.accent : T.muted,
        anchor: "middle",
      }),
      text(x + barW / 2, baseline + 17, labels[i], { size: 11, fill: T.dim, anchor: "middle" }),
    ];
  });

  const body = [
    prompt(22, 62, "habits --by weekday"),
    `  <line x1="22" y1="${baseline + 0.5}" x2="${CARD_W - 22}" y2="${baseline + 0.5}" stroke="${T.border}" stroke-width="1"/>`,
    ...bars,
    text(22, 216, "most productive day", { size: 11, fill: T.muted }),
    text(CARD_W - 22, 216, best, { size: 11, fill: T.accent, weight: "bold", anchor: "end" }),
  ].join("\n");
  return card({ width: CARD_W, height: CARD_H, title: "~/habits", body });
}

function activityCard(days) {
  const width = 940;
  const height = 260;
  const recent = days.slice(-30);
  const max = Math.max(...recent.map((d) => d.count), 1);
  const left = 54;
  const right = width - 28;
  const baseline = 202;
  const top = 82;
  const step = (right - left) / Math.max(recent.length - 1, 1);
  const pointX = (i) => left + i * step;
  const pointY = (count) => baseline - (count / max) * (baseline - top);

  const line = recent
    .map((d, i) => `${i === 0 ? "M" : "L"}${pointX(i).toFixed(1)},${pointY(d.count).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${pointX(recent.length - 1).toFixed(1)},${baseline} L${left},${baseline} Z`;

  const gridLines = [0, 0.5, 1].flatMap((ratio) => {
    const y = baseline - ratio * (baseline - top);
    return [
      `  <line x1="${left}" y1="${y.toFixed(1)}" x2="${right}" y2="${y.toFixed(1)}" stroke="${T.grid}" stroke-width="1"/>`,
      text(left - 12, y + 4, String(Math.round(ratio * max)), { size: 10, fill: T.muted, anchor: "end" }),
    ];
  });

  const dots = recent.map(
    (d, i) => `  <circle cx="${pointX(i).toFixed(1)}" cy="${pointY(d.count).toFixed(1)}" r="2.5" fill="${T.accent}"/>`
  );

  const ticks = recent.flatMap((d, i) =>
    i % 5 === 0 || i === recent.length - 1
      ? [text(pointX(i), baseline + 22, short(d.date), { size: 10, fill: T.muted, anchor: "middle" })]
      : []
  );

  const sum = recent.reduce((acc, d) => acc + d.count, 0);
  const defs = `
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${T.accent}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${T.accent}" stop-opacity="0"/>
    </linearGradient>`;

  const body = [
    prompt(22, 62, "activity --last 30d"),
    text(width - 22, 62, `${num(sum)} contributions`, { size: 12, fill: T.dim, anchor: "end" }),
    ...gridLines,
    `  <path d="${area}" fill="url(#area)"/>`,
    `  <path d="${line}" fill="none" stroke="${T.accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    ...dots,
    ...ticks,
  ].join("\n");
  return card({ width, height, title: "~/activity", body, defs });
}

const QUOTES = [
  ["Automate everything that can be automated.", "DevOps mantra"],
  ["Simplicity is prerequisite for reliability.", "Edsger W. Dijkstra"],
  ["Programs must be written for people to read.", "Harold Abelson"],
  ["Make it work, make it right, make it fast.", "Kent Beck"],
  ["Premature optimization is the root of all evil.", "Donald Knuth"],
  ["Hope is not a strategy.", "Google SRE Book"],
  ["Infrastructure should be cattle, not pets.", "Bill Baker"],
  ["If it hurts, do it more often.", "Jez Humble"],
  ["Everything fails all the time.", "Werner Vogels"],
  ["The best code is no code at all.", "Jeff Atwood"],
  ["Talk is cheap. Show me the code.", "Linus Torvalds"],
  ["First, solve the problem. Then, write the code.", "John Johnson"],
  ["Deleted code is debugged code.", "Jeff Sickel"],
  ["Testing shows the presence, not the absence of bugs.", "Edsger W. Dijkstra"],
];

function quoteCard() {
  const width = 940;
  const height = 112;
  const startOfYear = Date.UTC(new Date().getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((Date.now() - startOfYear) / 86400000);
  const [quote, author] = QUOTES[dayOfYear % QUOTES.length];
  const body = [
    prompt(22, 66, "fortune"),
    text(width / 2, 66, `"${quote}"`, { size: 15, fill: T.text, anchor: "middle" }),
    text(width / 2, 92, `- ${author}`, { size: 12, fill: T.accent, anchor: "middle" }),
  ].join("\n");
  return card({ width, height, title: "~/quote", body });
}

/** Animated headline replacing readme-typing-svg, which shares the same rate limits. */
function typingCard() {
  const width = 760;
  const height = 74;
  const size = 27;
  const phrases = [
    "Welcome to my profile!",
    "DevOps Engineer",
    "Automation | IaC | CI/CD",
    "Reliable, scalable, maintainable",
  ];
  const slot = 4; // seconds on screen per phrase
  const cycle = slot * phrases.length;

  const groups = phrases.map((phrase, i) => {
    const textW = phrase.length * size * 0.6;
    const x = (width - textW) / 2;
    const t0 = (i * slot) / cycle;
    const t3 = ((i + 1) * slot) / cycle;
    const keyTimes = [0, t0, t0 + 0.001, t3 - 0.001, t3, 1]
      .map((v) => Math.min(Math.max(v, 0), 1).toFixed(4))
      .join(";");
    return `  <g opacity="0">
    <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="${keyTimes}" dur="${cycle}s" repeatCount="indefinite"/>
    <clipPath id="type${i}">
      <rect x="${x.toFixed(1)}" y="16" width="0" height="42">
        <animate attributeName="width" values="0;${textW.toFixed(1)};${textW.toFixed(1)};0" keyTimes="0;0.45;0.85;1" dur="${slot}s" begin="${i * slot}s" repeatCount="indefinite"/>
      </rect>
    </clipPath>
    <text x="${x.toFixed(1)}" y="47" font-family="${T.font}" font-size="${size}" font-weight="bold" fill="${T.accent}" clip-path="url(#type${i})">${esc(phrase)}</text>
    <rect x="${x.toFixed(1)}" y="25" width="3" height="26" fill="${T.accent}">
      <animate attributeName="x" values="${x.toFixed(1)};${(x + textW).toFixed(1)};${(x + textW).toFixed(1)};${x.toFixed(1)}" keyTimes="0;0.45;0.85;1" dur="${slot}s" begin="${i * slot}s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="0.9s" repeatCount="indefinite"/>
    </rect>
  </g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(phrases.join(" - "))}">
${groups.join("\n")}
</svg>
`;
}

/* --------------------------------------------------------------------- main */

async function main() {
  if (!TOKEN) {
    console.error("Missing GITHUB_TOKEN (or STATS_TOKEN) with access to the GitHub GraphQL API.");
    process.exit(1);
  }

  const { user } = await gql(PROFILE_QUERY, { login: LOGIN });
  const repos = user.repositories.nodes;
  const stars = repos.reduce((acc, repo) => acc + repo.stargazerCount, 0);
  const days = await fetchCalendar(user.createdAt);
  const streaks = computeStreaks(days);

  const files = {
    "stats.svg": statsCard(user, stars),
    "streak.svg": streakCard(streaks),
    "languages.svg": languagesCard(repos),
    "habits.svg": weekdayCard(days),
    "activity.svg": activityCard(days),
    "quote.svg": quoteCard(),
    "typing.svg": typingCard(),
  };

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(ASSETS, name), content, "utf8");
    console.log(`wrote assets/${name}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
