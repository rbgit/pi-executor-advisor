import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type GateMode = "off" | "log" | "attempt" | "success";

type RunState = {
  runId: string;
  prompt: string;
  required: boolean;
  reasons: string[];
  startedAt: string;
  advisorAttempted: boolean;
  advisorSucceeded: boolean;
  advisorFailed: boolean;
  advisorToolCallIds: string[];
  mutationAllowedAt?: string;
};

const MUTATION_TOOLS = new Set(["write", "edit"]);
const ADVISOR_TOOL_NAMES = new Set(["advisor", "functions.advisor"]);

const READ_ONLY_BASH = [
  /^\s*(pwd|ls|find|rg|grep|head|tail|wc|stat|file|tree|lsof|pgrep|ps)\b/i,
  /^\s*git\s+(status|diff|log|show|branch|rev-parse|ls-files)\b/i,
  /^\s*(psql|sqlite3)\b.*\b(select|\\d|\\dt)\b/i,
  /^\s*(go|npm|pnpm|yarn|pytest|python|cargo|make)\s+(test|check|build|vet|lint|fmt\s+-w=false)\b/i,
];

function envMode(): GateMode {
  const raw = (process.env.PI_ADVISOR_GATE_MODE ?? "attempt").toLowerCase();
  if (raw === "off" || raw === "log" || raw === "attempt" || raw === "success") return raw;
  return "attempt";
}

function classify(prompt: string): { required: boolean; reasons: string[] } {
  const p = prompt.toLowerCase();
  const reasons: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/(build|implement|create|write|add|modify|refactor|rewrite|migrate|upgrade|integrate)/, "implementation or code change"],
    [/(debug|diagnose|failing|broken|regression|performance|bug)/, "debugging or regression"],
    [/(architecture|design|security|auth|permission|policy|enforce|gate|production)/, "architecture/security/policy"],
    [/(database|schema|migration|postgres|sql|delete|destructive)/, "data/destructive-risk"],
    [/(extension|provider|tool|agent|executor|advisor|model|habitat|absurd)/, "agent/tooling infrastructure"],
  ];
  for (const [re, reason] of checks) if (re.test(p)) reasons.push(reason);
  if (prompt.length > 500) reasons.push("large/ambiguous request");
  return { required: reasons.length > 0, reasons: [...new Set(reasons)] };
}

function isAdvisorTool(toolName: string): boolean {
  return ADVISOR_TOOL_NAMES.has(toolName) || toolName.endsWith(".advisor");
}

function isMutationTool(toolName: string, input: unknown): boolean {
  if (MUTATION_TOOLS.has(toolName)) return true;
  if (toolName !== "bash" && toolName !== "functions.bash") return false;
  const command = typeof (input as any)?.command === "string" ? (input as any).command : "";
  if (!command.trim()) return true;
  return !READ_ONLY_BASH.some((re) => re.test(command));
}

function now(): string {
  return new Date().toISOString();
}

function safeString(x: unknown): string | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => typeof part?.text === "string" ? part.text : safeString(part)).filter(Boolean).join("\n");
  }
  return safeString(content) ?? "";
}

function usageFromDetails(details: any): Record<string, unknown> {
  const usage = details?.usage ?? details?.tokenUsage ?? details?.tokens ?? {};
  return {
    inputTokens: usage.input ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens,
    outputTokens: usage.output ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens,
    totalTokens: usage.totalTokens ?? usage.total ?? usage.total_tokens,
    costTotal: usage.cost?.total ?? usage.costTotal ?? usage.cost,
  };
}

function advisorConfig(): { provider?: string; model?: string; spec?: string } {
  try {
    const raw = readFileSync(join(getAgentDir(), "advisor.json"), "utf8");
    return JSON.parse(raw).advisor ?? {};
  } catch { return {}; }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>'"]/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[ch]!));
}

function sqlLit(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export default function advisorGate(pi: ExtensionAPI) {
  let mode: GateMode = envMode();
  let current: RunState | undefined;
  let dashboard: Server | undefined;
  const advisorCallStarted = new Map<string, number>();

  const logDir = join(getAgentDir(), "logs");
  const logPath = join(logDir, "advisor-gate.jsonl");
  const pgUrl = process.env.PI_ADVISOR_PG_URL ?? "postgres://localhost/advisor_habitat?sslmode=disable";
  const dashboardPort = Number(process.env.PI_ADVISOR_DASHBOARD_PORT ?? "5000");
  mkdirSync(logDir, { recursive: true });

  function readEvents(): any[] {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8").split(/\n+/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { event: "parse_error", line }; }
    });
  }

  function insertPostgres(row: Record<string, unknown>) {
    if (process.env.PI_ADVISOR_PG_DISABLE === "1") return;
    const json = JSON.stringify(row);
    const data: any = row;
    const reasons = Array.isArray(data.reasons) ? `ARRAY[${data.reasons.map((r: string) => sqlLit(r)).join(",")}]::text[]` : "NULL";
    const sql = `insert into advisor_observability.events (
      ts,event,mode,run_id,tool_call_id,tool_name,status,required,reasons,prompt,cwd,
      executor_provider,executor_model,advisor_provider,advisor_model,input_tokens,output_tokens,total_tokens,cost_total,duration_ms,content_chars,content_preview,data
    ) values (
      ${sqlLit(String(data.ts ?? now()))}::timestamptz,
      ${sqlLit(String(data.event ?? "unknown"))},
      ${data.mode ? sqlLit(String(data.mode)) : "NULL"},
      ${data.runId ? sqlLit(String(data.runId)) : "NULL"},
      ${data.toolCallId ? sqlLit(String(data.toolCallId)) : "NULL"},
      ${data.toolName ? sqlLit(String(data.toolName)) : "NULL"},
      ${data.status ? sqlLit(String(data.status)) : "NULL"},
      ${typeof data.required === "boolean" ? String(data.required) : "NULL"},
      ${reasons},
      ${data.prompt ? sqlLit(String(data.prompt)) : "NULL"},
      ${data.cwd ? sqlLit(String(data.cwd)) : "NULL"},
      ${data.executorProvider ? sqlLit(String(data.executorProvider)) : "NULL"},
      ${data.executorModel ? sqlLit(String(data.executorModel)) : "NULL"},
      ${data.advisorProvider ? sqlLit(String(data.advisorProvider)) : "NULL"},
      ${data.advisorModel ? sqlLit(String(data.advisorModel)) : "NULL"},
      ${Number.isFinite(data.inputTokens) ? Number(data.inputTokens) : "NULL"},
      ${Number.isFinite(data.outputTokens) ? Number(data.outputTokens) : "NULL"},
      ${Number.isFinite(data.totalTokens) ? Number(data.totalTokens) : "NULL"},
      ${Number.isFinite(data.costTotal) ? Number(data.costTotal) : "NULL"},
      ${Number.isFinite(data.durationMs) ? Number(data.durationMs) : "NULL"},
      ${Number.isFinite(data.contentChars) ? Number(data.contentChars) : "NULL"},
      ${data.contentPreview ? sqlLit(String(data.contentPreview)) : "NULL"},
      ${sqlLit(json)}::jsonb
    );`;
    const child = spawn("psql", [pgUrl, "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: "ignore", detached: true });
    child.unref();
  }

  function log(event: string, data: Record<string, unknown>, ctx?: ExtensionContext) {
    const adv = advisorConfig();
    const row = {
      ts: now(),
      event,
      mode,
      cwd: ctx?.cwd,
      runId: current?.runId,
      executorProvider: ctx?.model?.provider,
      executorModel: ctx?.model?.id,
      advisorProvider: adv.provider,
      advisorModel: adv.model,
      ...data,
    };
    appendFileSync(logPath, JSON.stringify(row) + "\n");
    insertPostgres(row);
    try { pi.appendEntry("advisor-gate", row); } catch {}
  }

  function sharedCss(): string {
    return `
      *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
      :root{
        --bg:#080a0f;--bg-card:#0f1219;--bg-elevated:#151923;--bg-muted:#1c2030;
        --fg:#e8ecf4;--fg-muted:#8892a8;--fg-subtle:#5c6480;
        --border:#1e2336;--border-hover:#2a3050;
        --blue:#4d9fff;--purple:#a78bfa;--green:#34d399;--red:#f87171;--orange:#fbbf24;--cyan:#22d3ee;
        --radius:14px;--radius-sm:8px;--radius-xs:6px;
        --font-display:'Outfit',system-ui,sans-serif;--font-mono:'JetBrains Mono',ui-monospace,monospace;
        --shadow:0 4px 24px rgba(0,0,0,0.4);--shadow-lg:0 12px 40px rgba(0,0,0,0.5);
      }
      html{font-family:var(--font-display);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
      body{background:var(--bg);color:var(--fg);min-height:100vh}
      body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 50% -20%,rgba(77,159,255,0.06),transparent),radial-gradient(ellipse 60% 40% at 80% 100%,rgba(167,139,250,0.04),transparent);pointer-events:none;z-index:0}
      .wrap{max-width:1200px;margin:0 auto;padding:24px 28px;position:relative;z-index:1}
      .nav{display:flex;gap:4px;margin-bottom:20px}
      .nav a{padding:8px 16px;border-radius:var(--radius-sm);text-decoration:none;font-size:13px;font-weight:600;color:var(--fg-muted);transition:all 0.2s}
      .nav a:hover{color:var(--fg);background:var(--bg-card)}
      .nav a.active{background:var(--bg-elevated);color:var(--blue);border:1px solid var(--border)}
      .header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap}
      .header-left{display:flex;align-items:center;gap:16px}
      .logo{display:flex;align-items:center;gap:10px}
      .logo-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--blue),var(--purple));display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff}
      .logo h1{font-size:22px;font-weight:700;letter-spacing:-0.03em}
      .live-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.2);font-size:11px;font-weight:600;color:var(--green);text-transform:uppercase;letter-spacing:0.05em}
      .live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
      @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.8)}}
      .header-right{display:flex;align-items:center;gap:12px}
      .last-updated{font-size:12px;color:var(--fg-subtle);font-family:var(--font-mono)}
      .search-box{position:relative}
      .search-box input{width:280px;max-width:100%;padding:9px 12px 9px 36px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--fg);font-size:13px;font-family:var(--font-display);transition:border-color 0.2s,box-shadow 0.2s}
      .search-box input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(77,159,255,0.15)}
      .search-box input::placeholder{color:var(--fg-subtle)}
      .search-box svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--fg-subtle)}
      .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:24px}
      .stat{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;transition:border-color 0.2s,transform 0.2s}
      .stat:hover{border-color:var(--border-hover);transform:translateY(-1px)}
      .stat-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--fg-subtle);margin-bottom:6px}
      .stat-value{font-size:28px;font-weight:700;letter-spacing:-0.03em}
      .stat-value.blue{color:var(--blue)}.stat-value.purple{color:var(--purple)}.stat-value.green{color:var(--green)}.stat-value.red{color:var(--red)}.stat-value.orange{color:var(--orange)}
      .toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px;flex-wrap:wrap}
      .filters{display:flex;gap:6px;flex-wrap:wrap}
      .filter-btn{padding:6px 14px;border-radius:999px;border:1px solid var(--border);background:transparent;color:var(--fg-muted);font-size:12px;font-weight:600;font-family:var(--font-display);cursor:pointer;transition:all 0.2s}
      .filter-btn:hover{border-color:var(--border-hover);color:var(--fg)}
      .filter-btn.active{background:var(--bg-elevated);border-color:var(--blue);color:var(--blue)}
      .toolbar-actions{display:flex;gap:8px}
      .tool-btn{padding:6px 12px;border-radius:var(--radius-xs);border:1px solid var(--border);background:var(--bg-card);color:var(--fg-muted);font-size:12px;font-weight:500;font-family:var(--font-display);cursor:pointer;transition:all 0.2s}
      .tool-btn:hover{border-color:var(--border-hover);color:var(--fg)}
      .tool-btn.active{border-color:var(--purple);color:var(--purple)}
      .runs{display:flex;flex-direction:column;gap:12px}
      .run{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;transition:border-color 0.2s,box-shadow 0.2s;animation:fadeIn 0.3s ease}
      @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      .run:hover{border-color:var(--border-hover);box-shadow:var(--shadow)}
      .run.ok{border-left:3px solid var(--green)}.run.bad{border-left:3px solid var(--red)}.run.mid{border-left:3px solid var(--purple)}.run.dim{border-left:3px solid var(--fg-subtle)}
      .run-head{display:flex;align-items:center;gap:10px;padding:14px 18px;cursor:pointer;user-select:none;flex-wrap:wrap}
      .run-head:hover{background:rgba(255,255,255,0.01)}
      .chevron{font-size:10px;color:var(--fg-subtle);transition:transform 0.2s;flex-shrink:0}
      .run.expanded .chevron{transform:rotate(90deg)}
      .pill{font-weight:700;text-transform:uppercase;font-size:10px;padding:3px 8px;border-radius:999px;letter-spacing:0.04em}
      .pill.ok{background:rgba(52,211,153,0.12);color:var(--green)}.pill.bad{background:rgba(248,113,113,0.12);color:var(--red)}.pill.mid{background:rgba(167,139,250,0.12);color:var(--purple)}.pill.dim{background:rgba(92,100,128,0.12);color:var(--fg-subtle)}
      .run-id{font-family:var(--font-mono);font-size:12px;color:var(--blue);font-weight:500}
      .run-time{font-size:12px;color:var(--fg-subtle);font-family:var(--font-mono)}
      .run-prompt{font-size:13px;font-weight:500;color:var(--fg);margin:0 18px 10px;line-height:1.5;max-height:3em;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
      .run.expanded .run-prompt{max-height:none;-webkit-line-clamp:unset}
      .run-meta{font-size:12px;color:var(--fg-subtle);padding:0 18px 14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .run-meta .tag{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:var(--radius-xs);background:var(--bg-muted);font-size:11px;font-weight:500}
      .run-meta .tag.executor{color:var(--cyan)}.run-meta .tag.advisor{color:var(--purple)}.run-meta .tag.reason{color:var(--orange)}
      .events{display:none;padding:0 18px 14px;gap:6px;flex-direction:column}
      .run.expanded .events{display:flex}
      .event{display:grid;grid-template-columns:140px 60px 80px repeat(4,70px) 60px;gap:6px;align-items:center;padding:8px 12px;border-radius:var(--radius-sm);background:var(--bg);border:1px solid var(--border);font-size:12px}
      .event b{font-weight:600;font-family:var(--font-mono);font-size:11px}
      .event span{color:var(--fg-muted);font-family:var(--font-mono);font-size:11px}
      .event-preview{grid-column:1/-1;margin-top:4px;font-size:12px;color:var(--fg-muted);line-height:1.5;max-height:4.5em;overflow:hidden;white-space:pre-wrap;word-break:break-word}
      .e-run_start b{color:var(--blue)}.e-advisor_call b{color:var(--purple)}.e-advisor_result b{color:var(--green)}.e-mutation_blocked b{color:var(--red)}.e-mutation_allowed b{color:var(--orange)}.e-run_end b{color:var(--fg-subtle)}
      .empty{text-align:center;padding:60px 20px;color:var(--fg-subtle)}
      @media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}}
      @media(max-width:760px){.stats{grid-template-columns:repeat(2,1fr)}.header{flex-direction:column;align-items:stretch}.search-box input{width:100%}.event{grid-template-columns:1fr 1fr;gap:4px}.event-preview{grid-column:1/-1}.toolbar{flex-direction:column;align-items:stretch}}
      @media(max-width:480px){.stats{grid-template-columns:1fr}.stat-value{font-size:22px}}
    `;
  }

  function navHtml(active: string): string {
    return `<nav class="nav"><a href="/" class="${active === "dashboard" ? "active" : ""}">Dashboard</a><a href="/chat" class="${active === "chat" ? "active" : ""}">Chat View</a></nav>`;
  }

  function dashboardHtml(): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Advisor Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${sharedCss()}</style></head><body><div class="wrap">
${navHtml("dashboard")}
<div class="header"><div class="header-left"><div class="logo"><div class="logo-icon">A</div><h1>Advisor</h1></div><span class="live-badge"><span class="live-dot"></span>Live</span></div>
<div class="header-right"><span class="last-updated" id="last-updated">--</span>
<div class="search-box"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
<input id="q" placeholder="Search prompts, models, events..." autocomplete="off"></div></div></div>
<div class="stats" id="stats"></div>
<div class="toolbar"><div class="filters" id="filters"></div>
<div class="toolbar-actions">
<button class="tool-btn" id="sort-btn">\u2195 Newest</button>
<button class="tool-btn" id="collapse-btn">Collapse All</button>
<button class="tool-btn active" id="poll-btn">\u21BB Auto</button>
</div></div>
<div class="runs" id="runs"></div>
</div>
<script>
(function(){
  var allEvents = [], sortOrder = 'newest', activeFilter = 'all', searchQuery = '', polling = true, pollTimer = null, lastCount = 0;
  var runsEl = document.getElementById('runs'), statsEl = document.getElementById('stats'), filtersEl = document.getElementById('filters');
  var sortBtn = document.getElementById('sort-btn'), collapseBtn = document.getElementById('collapse-btn'), pollBtn = document.getElementById('poll-btn');
  var qInput = document.getElementById('q'), lastUpdatedEl = document.getElementById('last-updated');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var s = Math.floor((Date.now() - d) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return d.toLocaleDateString();
  }

  function fmtNum(n) {
    if (n === undefined || n === null) return '\\u2014';
    return Number(n).toLocaleString();
  }

  function groupRuns(events) {
    var map = {};
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e.runId) continue;
      if (!map[e.runId]) map[e.runId] = [];
      map[e.runId].push(e);
    }
    return map;
  }

  function getRunStatus(evs) {
    var advisor = null;
    for (var i = 0; i < evs.length; i++) {
      if (evs[i].event === 'advisor_result') advisor = evs[i];
    }
    if (advisor) return advisor.status === 'success' ? 'success' : 'error';
    for (var i = 0; i < evs.length; i++) {
      if (evs[i].event === 'advisor_call') return 'called';
    }
    return 'none';
  }

  function statusClass(s) {
    return s === 'success' ? 'ok' : s === 'error' ? 'bad' : s === 'called' ? 'mid' : 'dim';
  }

  function renderStats(runs) {
    statsEl.innerHTML = '';
    var ids = Object.keys(runs);
    var total = ids.length, required = 0, satisfied = 0, blocked = 0, calls = 0;
    for (var i = 0; i < ids.length; i++) {
      var evs = runs[ids[i]];
      var start = null;
      for (var j = 0; j < evs.length; j++) { if (evs[j].event === 'run_start') start = evs[j]; }
      if (start && start.required) required++;
      var st = getRunStatus(evs);
      if (st === 'success') satisfied++;
      for (var j = 0; j < evs.length; j++) {
        if (evs[j].event === 'mutation_blocked') blocked++;
        if (evs[j].event === 'advisor_call') calls++;
      }
    }
    var items = [
      {label: 'Total Runs', value: total, color: 'blue'},
      {label: 'Required', value: required, color: 'orange'},
      {label: 'Satisfied', value: satisfied, color: 'green'},
      {label: 'Blocked', value: blocked, color: 'red'},
      {label: 'Advisor Calls', value: calls, color: 'purple'}
    ];
    for (var i = 0; i < items.length; i++) {
      var card = el('div', 'stat');
      card.appendChild(el('div', 'stat-label', items[i].label));
      card.appendChild(el('div', 'stat-value ' + items[i].color, String(items[i].value)));
      statsEl.appendChild(card);
    }
  }

  function renderFilters(runs) {
    filtersEl.innerHTML = '';
    var ids = Object.keys(runs);
    var counts = {all: ids.length, ok: 0, bad: 0, mid: 0, dim: 0};
    for (var i = 0; i < ids.length; i++) {
      var k = statusClass(getRunStatus(runs[ids[i]]));
      counts[k] = (counts[k] || 0) + 1;
    }
    var items = [
      {key: 'all', label: 'All', count: counts.all},
      {key: 'ok', label: 'Success', count: counts.ok},
      {key: 'mid', label: 'Called', count: counts.mid},
      {key: 'bad', label: 'Error', count: counts.bad},
      {key: 'dim', label: 'None', count: counts.dim}
    ];
    for (var i = 0; i < items.length; i++) {
      var btn = el('button', activeFilter === items[i].key ? 'filter-btn active' : 'filter-btn');
      btn.setAttribute('data-filter', items[i].key);
      btn.textContent = items[i].label + ' (' + items[i].count + ')';
      btn.addEventListener('click', function() {
        activeFilter = this.getAttribute('data-filter');
        render();
      });
      filtersEl.appendChild(btn);
    }
  }

  function renderRunCard(runId, evs) {
    var start = null;
    for (var i = 0; i < evs.length; i++) { if (evs[i].event === 'run_start') start = evs[i]; }
    if (!start) start = evs[evs.length - 1];
    var status = getRunStatus(evs);
    var klass = statusClass(status);
    var section = el('section', 'run ' + klass);
    section.setAttribute('data-status', klass);
    var head = el('div', 'run-head');
    head.appendChild(el('span', 'chevron', '\\u25B6'));
    head.appendChild(el('span', 'pill ' + klass, status));
    head.appendChild(el('span', 'run-id', runId));
    head.appendChild(el('span', 'run-time', timeAgo(start.ts)));
    head.addEventListener('click', function() { section.classList.toggle('expanded'); });
    section.appendChild(head);
    section.appendChild(el('p', 'run-prompt', start.prompt || '(no prompt)'));
    var meta = el('div', 'run-meta');
    var exec = (start.executorProvider || '?') + '/' + (start.executorModel || '?');
    var adv = (start.advisorProvider || '?') + '/' + (start.advisorModel || '?');
    var reasons = (start.reasons || []).join(', ') || 'none';
    meta.appendChild(el('span', 'tag executor', '\\u26A1 ' + exec));
    meta.appendChild(el('span', 'tag advisor', '\\uD83E\\uDDE0 ' + adv));
    meta.appendChild(el('span', 'tag reason', '\\uD83D\\uDCCB ' + reasons));
    section.appendChild(meta);
    var eventsDiv = el('div', 'events');
    var sortedEvs = evs.slice().reverse();
    for (var i = 0; i < sortedEvs.length; i++) {
      var e = sortedEvs[i];
      var evEl = el('div', 'event e-' + e.event);
      evEl.appendChild(el('b', null, e.event));
      evEl.appendChild(el('span', null, e.status || ''));
      evEl.appendChild(el('span', null, e.toolName || ''));
      evEl.appendChild(el('span', null, 'in ' + fmtNum(e.inputTokens)));
      evEl.appendChild(el('span', null, 'out ' + fmtNum(e.outputTokens)));
      evEl.appendChild(el('span', null, '\\u03A3 ' + fmtNum(e.totalTokens)));
      evEl.appendChild(el('span', null, e.durationMs ? e.durationMs + 'ms' : ''));
      if (e.costTotal) evEl.appendChild(el('span', null, '$' + Number(e.costTotal).toFixed(4)));
      if (e.contentPreview) evEl.appendChild(el('div', 'event-preview', e.contentPreview.slice(0, 400)));
      eventsDiv.appendChild(evEl);
    }
    section.appendChild(eventsDiv);
    return section;
  }

  function render() {
    var grouped = groupRuns(allEvents);
    var ids = Object.keys(grouped);
    if (sortOrder === 'newest') { ids.sort(function(a, b) { return b.localeCompare(a); }); }
    else { ids.sort(function(a, b) { return a.localeCompare(b); }); }
    renderStats(grouped);
    renderFilters(grouped);
    runsEl.innerHTML = '';
    var visible = 0;
    for (var i = 0; i < ids.length; i++) {
      var runId = ids[i];
      var evs = grouped[runId];
      var st = statusClass(getRunStatus(evs));
      if (activeFilter !== 'all' && st !== activeFilter) continue;
      var card = renderRunCard(runId, evs);
      if (searchQuery && card.textContent.toLowerCase().indexOf(searchQuery.toLowerCase()) === -1) {
        card.style.display = 'none';
      }
      runsEl.appendChild(card);
      visible++;
    }
    if (visible === 0) runsEl.appendChild(el('div', 'empty', 'No matching runs found'));
  }

  function fetchEvents() {
    fetch('/events.json').then(function(r) { return r.json(); }).then(function(data) {
      if (data.length !== lastCount) { allEvents = data; lastCount = data.length; render(); }
      lastUpdatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    }).catch(function(e) { console.error('Poll error:', e); });
  }

  function startPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(fetchEvents, 3000); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  qInput.addEventListener('input', function() { searchQuery = this.value; render(); });
  sortBtn.addEventListener('click', function() {
    sortOrder = sortOrder === 'newest' ? 'oldest' : 'newest';
    this.textContent = sortOrder === 'newest' ? '\\u2195 Newest' : '\\u2195 Oldest';
    render();
  });
  collapseBtn.addEventListener('click', function() {
    var expanded = runsEl.querySelectorAll('.run.expanded');
    if (expanded.length > 0) { for (var i = 0; i < expanded.length; i++) expanded[i].classList.remove('expanded'); }
    else { var all = runsEl.querySelectorAll('.run'); for (var i = 0; i < all.length; i++) all[i].classList.add('expanded'); }
  });
  pollBtn.addEventListener('click', function() {
    polling = !polling;
    if (polling) { startPoll(); this.classList.add('active'); this.textContent = '\\u21BB Auto'; }
    else { stopPoll(); this.classList.remove('active'); this.textContent = '\\u21BB Paused'; }
  });

  fetchEvents();
  startPoll();
})()
</script></body></html>`;
  }

  function chatHtml(): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Advisor Chat View</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${sharedCss()}
.chat-header{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.chat-header select{padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--fg);font-size:13px;font-family:var(--font-display);min-width:300px}
.chat-header select:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(77,159,255,0.15)}
.chat-container{display:flex;flex-direction:column;gap:16px;max-width:800px;margin:0 auto;padding:20px 0}
.bubble{max-width:85%;padding:14px 18px;border-radius:18px;font-size:14px;line-height:1.6;position:relative;animation:bubbleIn 0.3s ease}
@keyframes bubbleIn{from{opacity:0;transform:translateY(12px) scale(0.95)}to{opacity:1;transform:translateY(0) scale(1)}}
.bubble-exec{align-self:flex-start;background:#1a2a3a;border:1px solid rgba(77,159,255,0.2);border-bottom-left-radius:4px;color:#c8ddf5}
.bubble-adv{align-self:flex-end;background:#2a2510;border:1px solid rgba(251,191,36,0.2);border-bottom-right-radius:4px;color:#f0e6c8}
.bubble-sys{align-self:center;background:var(--bg-muted);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:12px;color:var(--fg-subtle);padding:8px 14px}
.bubble-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;opacity:0.7}
.bubble-exec .bubble-label{color:var(--blue)}
.bubble-adv .bubble-label{color:var(--orange)}
.bubble-content{white-space:pre-wrap;word-break:break-word}
.bubble-meta{font-size:11px;color:var(--fg-subtle);margin-top:8px;font-family:var(--font-mono)}
.bubble-wait{align-self:flex-end;display:flex;align-items:center;gap:10px;padding:14px 18px;border-radius:18px;background:#2a2510;border:1px solid rgba(251,191,36,0.2);border-bottom-right-radius:4px}
.bubble-wait .bubble-label{color:var(--orange);margin-bottom:0}
.spinner{width:20px;height:20px;border:2px solid rgba(251,191,36,0.2);border-top-color:var(--orange);border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.bubble-block{color:var(--red)}
.bubble-allow{color:var(--green)}
.empty-chat{text-align:center;padding:80px 20px;color:var(--fg-subtle)}
.empty-chat h3{font-size:18px;margin-bottom:8px;color:var(--fg-muted)}
@media(max-width:760px){.bubble{max-width:95%}.chat-header select{min-width:100%}}
</style></head><body><div class="wrap">
${navHtml("chat")}
<div class="chat-header">
<div class="logo"><div class="logo-icon">A</div><h1>Chat View</h1></div>
<select id="run-select"></select>
</div>
<div class="chat-container" id="chat-container"></div>
</div>
<script>
(function(){
  var allEvents = [], selectedRun = null, pollTimer = null;
  var container = document.getElementById('chat-container');
  var select = document.getElementById('run-select');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function groupRuns(events) {
    var map = {};
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e.runId) continue;
      if (!map[e.runId]) map[e.runId] = [];
      map[e.runId].push(e);
    }
    return map;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var s = Math.floor((Date.now() - new Date(ts)) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return new Date(ts).toLocaleDateString();
  }

  function renderRunSelector(runs) {
    var ids = Object.keys(runs).sort(function(a, b) { return b.localeCompare(a); });
    select.innerHTML = '';
    if (ids.length === 0) {
      var opt = el('option', null, 'No runs available');
      opt.value = '';
      select.appendChild(opt);
      return;
    }
    for (var i = 0; i < ids.length; i++) {
      var evs = runs[ids[i]];
      var start = null;
      for (var j = 0; j < evs.length; j++) { if (evs[j].event === 'run_start') start = evs[j]; }
      var label = (start ? (start.prompt || '').slice(0, 60) : '(no prompt)') + ' \\u2014 ' + ids[i].slice(-8);
      var opt = el('option', null, label);
      opt.value = ids[i];
      if (selectedRun === ids[i]) opt.selected = true;
      select.appendChild(opt);
    }
    if (!selectedRun || !runs[selectedRun]) {
      selectedRun = ids[0];
      select.value = selectedRun;
    }
  }

  function renderChat(runs) {
    container.innerHTML = '';
    if (!selectedRun || !runs[selectedRun]) {
      container.appendChild(el('div', 'empty-chat', 'Select a run to view the conversation'));
      return;
    }
    var evs = runs[selectedRun];
    var hasPendingAdvisor = false;

    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];

      if (e.event === 'run_start') {
        var bubble = el('div', 'bubble bubble-exec');
        bubble.appendChild(el('div', 'bubble-label', '\\u26A1 Executor'));
        bubble.appendChild(el('div', 'bubble-content', e.prompt || '(no prompt)'));
        var meta = el('div', 'bubble-meta');
        meta.textContent = (e.executorProvider || '?') + '/' + (e.executorModel || '?') + ' \\u00B7 ' + timeAgo(e.ts);
        bubble.appendChild(meta);
        container.appendChild(bubble);
      }

      if (e.event === 'advisor_call') {
        hasPendingAdvisor = true;
      }

      if (e.event === 'advisor_result') {
        hasPendingAdvisor = false;
        var bubble = el('div', 'bubble bubble-adv');
        bubble.appendChild(el('div', 'bubble-label', '\\uD83E\\uDDE0 Advisor'));
        if (e.status === 'error') {
          bubble.appendChild(el('div', 'bubble-content', 'Error: ' + (e.contentPreview || 'advisor call failed')));
        } else {
          bubble.appendChild(el('div', 'bubble-content', e.contentPreview || '(no content)'));
        }
        var meta = el('div', 'bubble-meta');
        var parts = [];
        if (e.durationMs) parts.push(e.durationMs + 'ms');
        if (e.inputTokens) parts.push('\\u2191' + e.inputTokens);
        if (e.outputTokens) parts.push('\\u2193' + e.outputTokens);
        if (e.costTotal) parts.push('$' + Number(e.costTotal).toFixed(4));
        meta.textContent = parts.join(' \\u00B7 ') + ' \\u00B7 ' + timeAgo(e.ts);
        bubble.appendChild(meta);
        container.appendChild(bubble);
      }

      if (e.event === 'mutation_blocked') {
        var bubble = el('div', 'bubble bubble-sys');
        bubble.appendChild(el('div', 'bubble-label', '\\uD83D\\uDEAB Blocked'));
        bubble.appendChild(el('div', 'bubble-content bubble-block', e.toolName + ': ' + (e.reason || 'mutation blocked')));
        container.appendChild(bubble);
      }

      if (e.event === 'mutation_allowed') {
        var bubble = el('div', 'bubble bubble-sys');
        bubble.appendChild(el('div', 'bubble-label', '\\u2705 Allowed'));
        bubble.appendChild(el('div', 'bubble-content bubble-allow', e.toolName + ' mutation allowed'));
        container.appendChild(bubble);
      }

      if (e.event === 'run_end') {
        var satisfied = e.satisfied ? 'satisfied' : 'unsatisfied';
        var bubble = el('div', 'bubble bubble-sys');
        bubble.appendChild(el('div', 'bubble-content', 'Run ended \\u2014 ' + satisfied));
        container.appendChild(bubble);
      }
    }

    if (hasPendingAdvisor) {
      var wait = el('div', 'bubble-wait');
      wait.appendChild(el('div', 'bubble-label', '\\uD83E\\uDDE0 Advisor'));
      wait.appendChild(el('div', 'spinner'));
      wait.appendChild(el('span', null, 'Thinking...'));
      container.appendChild(wait);
    }
  }

  function render() {
    var grouped = groupRuns(allEvents);
    renderRunSelector(grouped);
    renderChat(grouped);
  }

  function fetchEvents() {
    fetch('/events.json').then(function(r) { return r.json(); }).then(function(data) {
      allEvents = data;
      render();
    }).catch(function(e) { console.error('Poll error:', e); });
  }

  select.addEventListener('change', function() {
    selectedRun = this.value;
    var grouped = groupRuns(allEvents);
    renderChat(grouped);
  });

  fetchEvents();
  pollTimer = setInterval(fetchEvents, 3000);
})()
</script></body></html>`;
  }

  function startDashboard(ctx?: ExtensionContext) {
    if (dashboard) return;
    dashboard = createServer((req, res) => {
      if (req.url?.startsWith("/events.json")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(readEvents(), null, 2));
        return;
      }
      if (req.url === "/chat") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(chatHtml());
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(dashboardHtml());
    });
    dashboard.listen(dashboardPort, "127.0.0.1", () => ctx?.ui.notify(`Advisor dashboard: http://127.0.0.1:${dashboardPort}`, "info"));
    dashboard.on("error", (err) => ctx?.ui.notify(`Advisor dashboard failed on ${dashboardPort}: ${String(err)}`, "warning"));
  }

  function satisfied(): boolean {
    if (!current?.required) return true;
    if (mode === "off" || mode === "log") return true;
    if (mode === "attempt") return current.advisorAttempted;
    if (mode === "success") return current.advisorSucceeded;
    return false;
  }

  pi.registerCommand("advisor-gate", {
    description: "Show advisor gate status and log path",
    handler: async (_args, ctx) => {
      const status = current
        ? `mode=${mode}\nrequired=${current.required}\nreasons=${current.reasons.join(", ") || "none"}\nadvisorAttempted=${current.advisorAttempted}\nadvisorSucceeded=${current.advisorSucceeded}\nadvisorFailed=${current.advisorFailed}\nlog=${logPath}\ndashboard=http://127.0.0.1:${dashboardPort}\npostgres=${pgUrl}`
        : `mode=${mode}\nNo active run.\nlog=${logPath}\ndashboard=http://127.0.0.1:${dashboardPort}\npostgres=${pgUrl}`;
      ctx.ui.notify(status, "info");
    },
  });

  pi.registerCommand("advisor-dashboard", {
    description: "Start/show local advisor call dashboard",
    handler: async (_args, ctx) => { startDashboard(ctx); ctx.ui.notify(`Advisor dashboard: http://127.0.0.1:${dashboardPort}`, "info"); },
  });

  pi.registerCommand("advisor-dashboard-stop", {
    description: "Stop local advisor call dashboard",
    handler: async (_args, ctx) => { dashboard?.close(); dashboard = undefined; ctx.ui.notify("Advisor dashboard stopped", "info"); },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_ADVISOR_DASHBOARD !== "0") startDashboard(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    mode = envMode();
    const { required, reasons } = classify(event.prompt ?? "");
    current = { runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, prompt: event.prompt ?? "", required, reasons, startedAt: now(), advisorAttempted: false, advisorSucceeded: false, advisorFailed: false, advisorToolCallIds: [] };
    log("run_start", { required, reasons, prompt: event.prompt }, ctx);
    if (!required || mode === "off") return undefined;
    const instruction = `\n\nADVISOR GATE ACTIVE for this user request.\nReason(s): ${reasons.join(", ")}.\nPolicy:\n- Before any mutation tool call (write/edit or non-read-only bash), call the advisor tool.\n- If you change approach, call advisor again before further mutation.\n- Before declaring completion, ensure advisor was called after the main orientation/implementation context was gathered.\n- If advisor fails because provider credentials/config are unavailable, report that explicitly and proceed only if the gate permits attempts rather than success.\n- The runtime extension logs advisor calls and may block mutation tools until this policy is satisfied.`;
    return { systemPrompt: event.systemPrompt + instruction };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!current) return undefined;
    if (isAdvisorTool(event.toolName)) {
      current.advisorAttempted = true;
      current.advisorToolCallIds.push(event.toolCallId);
      advisorCallStarted.set(event.toolCallId, Date.now());
      log("advisor_call", { toolName: event.toolName, toolCallId: event.toolCallId, required: current.required }, ctx);
      return undefined;
    }
    if (!current.required || mode === "off" || mode === "log") return undefined;
    if (!isMutationTool(event.toolName, event.input)) return undefined;
    if (satisfied()) { current.mutationAllowedAt = now(); log("mutation_allowed", { toolName: event.toolName, toolCallId: event.toolCallId }, ctx); return undefined; }
    const needed = mode === "success" ? "a successful advisor result" : "an advisor call attempt";
    const reason = `Advisor gate blocked ${event.toolName}: this task requires ${needed} before mutation. Reasons: ${current.reasons.join(", ")}.`;
    log("mutation_blocked", { toolName: event.toolName, toolCallId: event.toolCallId, reason }, ctx);
    return { block: true, reason };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!current || !isAdvisorTool(event.toolName)) return undefined;
    const text = contentText(event.content);
    const usage = usageFromDetails((event as any).details);
    const started = advisorCallStarted.get(event.toolCallId);
    const common = { toolName: event.toolName, toolCallId: event.toolCallId, contentChars: text.length, contentPreview: text.slice(0, 800), durationMs: started ? Date.now() - started : undefined, ...usage };
    if (event.isError) { current.advisorFailed = true; log("advisor_result", { ...common, status: "error", isError: true }, ctx); return undefined; }
    current.advisorSucceeded = true;
    log("advisor_result", { ...common, status: "success", isError: false }, ctx);
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!current) return undefined;
    log("run_end", { required: current.required, advisorAttempted: current.advisorAttempted, advisorSucceeded: current.advisorSucceeded, advisorFailed: current.advisorFailed, satisfied: satisfied(), reasons: current.reasons }, ctx);
    if (current.required && !satisfied() && ctx.hasUI) ctx.ui.notify(`Advisor gate not satisfied. mode=${mode}; attempted=${current.advisorAttempted}; succeeded=${current.advisorSucceeded}. Log: ${logPath}`, "warning");
  });
}
