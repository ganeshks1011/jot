#!/usr/bin/env node
import fs from "fs";
import path from "path";

const PROJECT = path.resolve("project.md");
const PROGRESS = path.resolve("docs/architecture/progress.md");
const VALID = new Set(["available", "planned", "in progress", "done", "blocked", "abandoned"]);
const MAP = {
  available: "PENDING",
  planned: "PENDING",
  "in progress": "IN PROGRESS",
  blocked: "BLOCKED",
  abandoned: "ABANDONED",
  done: "DONE",
};

function words(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function read(p) {
  return fs.readFileSync(p, "utf8");
}
function write(p, s) {
  fs.writeFileSync(p, s, "utf8");
}

function parseProject(text) {
  const lines = text.split("\n");
  let inActive = false,
    inDone = false;
  let activeStart = -1,
    activeEnd = -1,
    doneStart = -1,
    doneEnd = -1;
  let activeHeader = -1,
    doneHeader = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## Active todos")) {
      inActive = true;
      inDone = false;
      activeStart = i;
      continue;
    }
    if (lines[i].startsWith("## Completed")) {
      inDone = true;
      inActive = false;
      doneStart = i;
      continue;
    }
    if (inActive && lines[i].startsWith("|") && lines[i].includes("ID") && lines[i].includes("Task")) activeHeader = i;
    if (inDone && lines[i].startsWith("|") && lines[i].includes("ID") && lines[i].includes("Task")) doneHeader = i;
    if (inActive && lines[i].startsWith("## ") && !lines[i].includes("Active")) {
      activeEnd = i;
      inActive = false;
    }
    if (inDone && lines[i].startsWith("## ") && !lines[i].includes("Completed")) {
      doneEnd = i;
      inDone = false;
    }
  }
  if (activeStart !== -1 && activeEnd === -1) {
    // find next ## after Active
    for (let i = activeStart + 1; i < lines.length; i++)
      if (lines[i].startsWith("## Completed")) {
        activeEnd = i;
        break;
      }
    if (activeEnd === -1) activeEnd = lines.length;
  }
  if (doneStart !== -1 && doneEnd === -1) doneEnd = lines.length;

  function rowsToObjs(start, header, end) {
    const out = [];
    if (header === -1 || start === -1 || end === -1) return out;
    for (let i = header + 2; i < end; i++) {
      const l = lines[i].trim();
      if (!l.startsWith("|")) break;
      const cols = l
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cols.length < 3) continue;
      // Active: ID, Task, Status, Owner ; Completed: ID, Task, Done
      out.push({ idx: i, cols, raw: lines[i] });
    }
    return out;
  }
  const activeRows = rowsToObjs(activeStart, activeHeader, activeEnd);
  const doneRows = rowsToObjs(doneStart, doneHeader, doneEnd);
  return { lines, activeRows, doneRows, activeStart, activeHeader, activeEnd, doneStart, doneHeader, doneEnd };
}

function maxId(activeRows, doneRows) {
  let m = 0;
  for (const r of [...activeRows, ...doneRows]) {
    const id = parseInt(r.cols[0], 10);
    if (!isNaN(id) && id > m) m = id;
  }
  return m;
}

function validateTask(t) {
  if (words(t) >= 10) throw new Error(`Task must be <10 words (got ${words(t)}): "${t}"`);
  if (t.includes("\n") || t.includes("|")) throw new Error("Task must be one line, no '|'");
}

function list() {
  const p = read(PROJECT);
  console.log(p);
}

function add(task, status = "available") {
  if (!VALID.has(status)) throw new Error(`Invalid status ${status}`);
  validateTask(task);
  const text = read(PROJECT);
  const { lines, activeRows, doneRows } = parseProject(text);
  const id = maxId(activeRows, doneRows) + 1;
  const newRow = `| ${id} | ${task} | ${status} |  |`;
  // find insertion point: after last active row or after header if none
  let insertAt = -1;
  if (activeRows.length) insertAt = activeRows[activeRows.length - 1].idx + 1;
  else {
    // find header
    for (let i = 0; i < lines.length; i++)
      if (lines[i].includes("## Active todos")) {
        // find header row
        for (let j = i; j < lines.length; j++)
          if (lines[j].includes("| ID") && lines[j].includes("Task")) {
            insertAt = j + 2;
            break;
          }
        break;
      }
  }
  lines.splice(insertAt, 0, newRow);
  write(PROJECT, lines.join("\n"));
  console.log(`Added ${id}: "${task}" [${status}]`);
}

function updateStatus(id, newStatus, extra) {
  if (!VALID.has(newStatus)) throw new Error(`Invalid status ${newStatus}`);
  const text = read(PROJECT);
  const parsed = parseProject(text);
  const { lines, activeRows, doneRows } = parsed;
  let found = null,
    foundIn = null;
  for (const r of activeRows)
    if (r.cols[0] === String(id)) {
      found = r;
      foundIn = "active";
      break;
    }
  if (!found)
    for (const r of doneRows)
      if (r.cols[0] === String(id)) {
        found = r;
        foundIn = "done";
        break;
      }
  if (!found) throw new Error(`ID ${id} not found`);
  if (foundIn === "active" && newStatus === "done") {
    // move to Completed
    const task = found.cols[1];
    const date = new Date().toISOString().slice(0, 10);
    // remove from active
    lines.splice(found.idx, 1);
    // find done insertion point (before end)
    const re = parseProject(lines.join("\n"));
    let ins = re.doneRows.length ? re.doneRows[re.doneRows.length - 1].idx + 1 : re.doneHeader + 2;
    if (ins < 0) ins = lines.length;
    // ensure done header exists
    lines.splice(ins, 0, `| ${id} | ${task} | ${date} |`);
    write(PROJECT, lines.join("\n"));
    console.log(`Moved ${id} to Completed`);
    return;
  }
  if (foundIn === "done" && newStatus !== "done") {
    // move back to active (unlikely)
    const task = found.cols[1];
    lines.splice(found.idx, 1);
    const re = parseProject(lines.join("\n"));
    const ins = re.activeRows.length ? re.activeRows[re.activeRows.length - 1].idx + 1 : re.activeHeader + 2;
    lines.splice(ins, 0, `| ${id} | ${task} | ${newStatus} |  |`);
    write(PROJECT, lines.join("\n"));
    console.log(`Moved ${id} to Active [${newStatus}]`);
    return;
  }
  // in-place status update for active
  const cols = found.cols;
  // cols: [ID, Task, Status, Owner?]
  cols[2] = newStatus;
  if (extra && cols.length > 3) cols[3] = extra;
  const newLine = `| ${cols.join(" | ")} |`;
  lines[found.idx] = newLine;
  write(PROJECT, lines.join("\n"));
  console.log(`Updated ${id} → ${newStatus}`);
}

function editTask(id, newTask) {
  validateTask(newTask);
  const text = read(PROJECT);
  const { lines, activeRows, doneRows } = parseProject(text);
  let found = null;
  for (const r of [...activeRows, ...doneRows])
    if (r.cols[0] === String(id)) {
      found = r;
      break;
    }
  if (!found) throw new Error(`ID ${id} not found`);
  found.cols[1] = newTask;
  lines[found.idx] = `| ${found.cols.join(" | ")} |`;
  write(PROJECT, lines.join("\n"));
  console.log(`Edited ${id}: "${newTask}"`);
}

function sync() {
  const p = read(PROJECT);
  const { activeRows } = parseProject(p);
  if (!fs.existsSync(PROGRESS)) {
    console.log("No progress.md");
    return;
  }
  const prog = read(PROGRESS);
  const lines = prog.split("\n");
  // find table header in progress.md: | ID | Task | Status |
  let hIdx = -1;
  for (let i = 0; i < lines.length; i++)
    if (lines[i].includes("| ID") && lines[i].includes("Task") && lines[i].includes("Status")) {
      hIdx = i;
      break;
    }
  if (hIdx === -1) {
    console.log("No table found in progress.md");
    return;
  }
  // collect existing pending rows until blank or non-table
  let end = hIdx + 2;
  for (let i = hIdx + 2; i < lines.length; i++)
    if (lines[i].trim().startsWith("|")) end = i + 1;
    else break;
  const newRows = activeRows.map((r) => {
    const id = r.cols[0],
      task = r.cols[1],
      status = r.cols[2];
    const mapped = MAP[status] || status.toUpperCase();
    return `| ${id} | ${task} | **${mapped}** |`;
  });
  // also keep header separator
  const header = lines[hIdx];
  const sep = lines[hIdx + 1];
  const before = lines.slice(0, hIdx);
  const after = lines.slice(end);
  const out = [...before, header, sep, ...newRows, "", ...after].join("\n").replace(/\n{3,}/g, "\n\n");
  write(PROGRESS, out);
  console.log(`Synced ${newRows.length} rows to ${PROGRESS}`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case "list":
      list();
      break;
    case "add": {
      const task = rest[0];
      if (!task) throw new Error('add "<task>" [--status <s>]');
      let status = "available";
      const sIdx = rest.indexOf("--status");
      if (sIdx !== -1) status = rest[sIdx + 1];
      add(task, status);
      break;
    }
    case "start":
      updateStatus(rest[0], "in progress");
      break;
    case "block":
      updateStatus(rest[0], "blocked", rest.slice(1).join(" "));
      break;
    case "done":
      updateStatus(rest[0], "done");
      break;
    case "abandon":
      updateStatus(rest[0], "abandoned");
      break;
    case "planned":
      updateStatus(rest[0], "planned");
      break;
    case "available":
      updateStatus(rest[0], "available");
      break;
    case "edit":
      editTask(rest[0], rest.slice(1).join(" "));
      break;
    case "sync":
      sync();
      break;
    default:
      console.log(`Usage:
  node scripts/todo.mjs list
  node scripts/todo.mjs add "<task <10 words>" [--status available|planned]
  node scripts/todo.mjs start <ID>
  node scripts/todo.mjs block <ID> [reason]
  node scripts/todo.mjs done <ID>
  node scripts/todo.mjs abandon <ID>
  node scripts/todo.mjs edit <ID> "<new task>"
  node scripts/todo.mjs sync`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
