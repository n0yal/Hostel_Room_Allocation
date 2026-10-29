/* ==========================================================
   Hostel Room Allocation – application logic
   Data layer: data.json -> fetch() -> JS object -> JSON.stringify
   -> localStorage -> JSON.parse on next visit.
   ========================================================== */
"use strict";

const STORAGE_KEY = "hostelRoomAllocation.v2";
const PAGES = ["dashboard", "rooms", "students", "allocation", "data"];

/* ---------- State ---------- */
let db = null;                  // the whole hostel database (plain JSON-compatible object)
let ui = {
  roomBlock: "all",
  studentFilter: "all",
  selStudent: null,
  selRoom: null,
  jsonTab: "view",
  donutAnimated: false
};

/* ---------- Tiny helpers ---------- */
const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const escText = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const blockOf = (gender) => (gender === "Male" ? "Boys" : "Girls");
const tone = (block) => block.toLowerCase();               // "boys" | "girls"
const ordinal = (n) => ["", "1st", "2nd", "3rd", "4th"][n] || n + "th";
const floorName = (n) => (n === 0 ? "Ground floor" : "Floor " + n);
const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id), 0) + 1;

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function formatTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/* ---------- Data access ---------- */
const roomById = (id) => db.rooms.find((r) => r.id === id);
const studentById = (id) => db.students.find((s) => s.id === id);
const occupantsOf = (roomId) => db.students.filter((s) => s.roomId === roomId);
const freeBeds = (room) => room.capacity - occupantsOf(room.id).length;
const pendingStudents = () => db.students.filter((s) => s.roomId === null);

function roomState(room) {
  const n = occupantsOf(room.id).length;
  if (n === 0) return "vacant";
  return n >= room.capacity ? "full" : "partial";
}

/* Best-fit score: prefer rooms that are already partly filled and
   that hold students from the same year. */
function fitScore(room, student) {
  const occ = occupantsOf(room.id);
  return occ.length + occ.filter((o) => o.year === student.year).length * 2;
}

function roomsFor(student) {
  return db.rooms
    .filter((r) => r.block === blockOf(student.gender) && freeBeds(r) > 0)
    .sort((a, b) => fitScore(b, student) - fitScore(a, student) || a.number.localeCompare(b.number));
}

function logActivity(text) {
  db.activity.unshift({ text, at: new Date().toISOString() });
  db.activity = db.activity.slice(0, 20);
}

/* ---------- JSON validation (used for storage, editor and import) ---------- */
function validateDb(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "The top level must be a JSON object.";
  if (!obj.hostel || typeof obj.hostel !== "object") return 'Missing the "hostel" object.';
  for (const key of ["rooms", "students", "activity"]) {
    if (!Array.isArray(obj[key])) return `"${key}" must be an array.`;
  }

  const roomIds = new Set();
  const roomNumbers = new Set();
  for (const r of obj.rooms) {
    if (!Number.isInteger(r.id) || roomIds.has(r.id)) return `Room id ${r.id} is missing or repeated.`;
    if (typeof r.number !== "string" || !r.number) return `Room ${r.id} needs a "number".`;
    if (roomNumbers.has(r.number)) return `Room number ${r.number} appears twice.`;
    if (r.block !== "Boys" && r.block !== "Girls") return `Room ${r.number}: "block" must be "Boys" or "Girls".`;
    if (!Number.isInteger(r.capacity) || r.capacity < 1) return `Room ${r.number}: "capacity" must be a whole number of 1 or more.`;
    roomIds.add(r.id);
    roomNumbers.add(r.number);
  }

  const studentIds = new Set();
  const regNos = new Set();
  const load = {};
  for (const s of obj.students) {
    if (!Number.isInteger(s.id) || studentIds.has(s.id)) return `Student id ${s.id} is missing or repeated.`;
    if (typeof s.name !== "string" || !s.name) return `Student ${s.id} needs a "name".`;
    if (regNos.has(s.regNo)) return `Register number ${s.regNo} appears twice.`;
    if (s.gender !== "Male" && s.gender !== "Female") return `${s.name}: "gender" must be "Male" or "Female".`;
    if (s.roomId !== null) {
      if (!roomIds.has(s.roomId)) return `${s.name}: roomId ${s.roomId} does not match any room.`;
      const room = obj.rooms.find((r) => r.id === s.roomId);
      if (room.block !== blockOf(s.gender)) return `${s.name} is placed in the wrong block (${room.number}).`;
      load[s.roomId] = (load[s.roomId] || 0) + 1;
      if (load[s.roomId] > room.capacity) return `Room ${room.number} has more students than beds.`;
    }
    studentIds.add(s.id);
    regNos.add(s.regNo);
  }
  return null;
}

/* ---------- Persistence ---------- */
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));      // object -> JSON string
  } catch (e) {
    toast("Changes could not be saved in this browser.", true);
  }
}

function readSaved() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return null;
    const obj = JSON.parse(text);                                // JSON string -> object
    return validateDb(obj) ? null : obj;
  } catch (e) {
    return null;
  }
}

/* data.json is read with fetch(). Browsers block fetch() on pages opened
   straight from disk (file://), so a copy sits inside index.html as a fallback. */
async function loadSeed() {
  try {
    if (location.protocol === "file:") throw new Error("fetch is not available on file:// pages");
    const res = await fetch("data.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    const text = $("seed-data").textContent.trim();
    if (text && !text.startsWith("/*")) return JSON.parse(text);
    throw e;
  }
}

/* ---------- Toast & confirm dialog ---------- */
let toastTimer;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function confirmAction(title, text, okLabel) {
  return new Promise((resolve) => {
    const dlg = $("confirmDialog");
    $("confirmTitle").textContent = title;
    $("confirmText").textContent = text;
    $("confirmOk").textContent = okLabel;
    dlg.returnValue = "cancel";
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
    dlg.showModal();
  });
}

/* ==========================================================
   Rendering
   ========================================================== */
function renderAll() {
  renderChrome();
  renderDashboard();
  renderRooms();
  renderStudents();
  renderAllocation();
  renderJson();
}

function renderChrome() {
  $("hostelName").textContent = db.hostel.name || "Hostel";
  $("yearLabel").textContent = "Academic year " + (db.hostel.academicYear || "");
  const waiting = pendingStudents().length;
  const badge = $("navBadge");
  badge.textContent = waiting;
  badge.hidden = waiting === 0;
}

/* ---------- Dashboard ---------- */
function renderDashboard() {
  const beds = db.rooms.reduce((n, r) => n + r.capacity, 0);
  const used = db.students.filter((s) => s.roomId !== null).length;
  const waiting = pendingStudents().length;
  const pct = beds ? Math.round((used / beds) * 100) : 0;

  $("dashSub").textContent = `${db.rooms.length} rooms, ${beds} beds, ${db.students.length} students registered.`;

  /* donut */
  const C = 2 * Math.PI * 60;
  $("donut").innerHTML = `
    <svg viewBox="0 0 150 150" role="img" aria-label="${pct}% of beds occupied">
      <circle class="ring-track" cx="75" cy="75" r="60"></circle>
      <circle class="ring-fill" id="ringFill" cx="75" cy="75" r="60" transform="rotate(-90 75 75)"
        stroke-dasharray="${C}" stroke-dashoffset="${ui.donutAnimated ? C * (1 - pct / 100) : C}"></circle>
    </svg>
    <div class="donut-label"><strong>${pct}%</strong><span>beds in use</span></div>`;
  if (!ui.donutAnimated) {
    ui.donutAnimated = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ring = $("ringFill");
      if (!ring) return;
      ring.classList.add("animate");
      ring.setAttribute("stroke-dashoffset", C * (1 - pct / 100));
    }));
  }

  /* per-block bars */
  $("blockBars").innerHTML = ["Boys", "Girls"].map((block) => {
    const rooms = db.rooms.filter((r) => r.block === block);
    const cap = rooms.reduce((n, r) => n + r.capacity, 0);
    const inUse = rooms.reduce((n, r) => n + occupantsOf(r.id).length, 0);
    const p = cap ? Math.round((inUse / cap) * 100) : 0;
    return `
      <div>
        <div class="bar-top"><span>${block} block</span><span>${inUse} of ${cap} beds</span></div>
        <div class="bar" role="img" aria-label="${block} block ${p}% full"><span class="${tone(block)}" style="width:${p}%"></span></div>
      </div>`;
  }).join("");

  /* stat cards */
  $("stats").innerHTML = `
    <div class="stat"><b>${db.rooms.length}</b><span>Rooms</span></div>
    <div class="stat"><b>${beds - used}</b><span>Free beds</span></div>
    <div class="stat"><b>${db.students.length}</b><span>Students</span></div>
    <div class="stat hot"><b>${waiting}</b><span>Waiting for a room</span></div>`;

  /* waiting list */
  const wait = pendingStudents().slice(0, 5);
  $("waitingList").innerHTML = wait.length
    ? wait.map((s) => `
      <div class="row">
        <span class="avatar ${tone(blockOf(s.gender))}" aria-hidden="true">${esc(initials(s.name))}</span>
        <div class="who"><strong>${esc(s.name)}</strong><span>${esc(s.department)}, ${ordinal(s.year)} year</span></div>
        <button class="link-btn" data-act="pick-student" data-id="${s.id}">Allocate</button>
      </div>`).join("")
    : `<div class="empty"><strong>Everyone has a room</strong>New students will show up here.</div>`;

  /* activity */
  $("activityFeed").innerHTML = db.activity.length
    ? db.activity.slice(0, 6).map((a) => `<li>${esc(a.text)}<small>${esc(formatTime(a.at))}</small></li>`).join("")
    : `<li class="muted">Nothing yet. Allocate a room and it will be listed here.</li>`;
}

/* ---------- Rooms ---------- */
function renderRooms() {
  $("roomBlockSeg").innerHTML = [["all", "All"], ["Boys", "Boys"], ["Girls", "Girls"]]
    .map(([v, label]) => `<button type="button" data-act="room-block" data-val="${v}" aria-pressed="${ui.roomBlock === v}">${label}</button>`)
    .join("");

  const q = $("roomSearch").value.trim().toLowerCase();
  const status = $("roomStatus").value;

  const list = db.rooms.filter((r) =>
    (ui.roomBlock === "all" || r.block === ui.roomBlock) &&
    (status === "all" || roomState(r) === status) &&
    (!q || r.number.toLowerCase().includes(q))
  );

  if (!list.length) {
    $("roomsBoard").innerHTML = `<div class="empty"><strong>No rooms match</strong>Clear the search or change the filters.</div>`;
    return;
  }

  let html = "";
  ["Boys", "Girls"].forEach((block) => {
    const inBlock = list.filter((r) => r.block === block);
    if (!inBlock.length) return;
    const floors = [...new Set(inBlock.map((r) => r.floor))].sort((a, b) => a - b);
    html += `<section class="block-sec"><div class="block-head"><h2>${block} block</h2></div>`;
    floors.forEach((f) => {
      html += `<div class="floor"><h3>${floorName(f)}</h3><div class="plates">`;
      inBlock.filter((r) => r.floor === f).sort((a, b) => a.number.localeCompare(b.number)).forEach((r) => {
        html += roomPlate(r);
      });
      html += `</div></div>`;
    });
    html += `</section>`;
  });
  $("roomsBoard").innerHTML = html;
}

function roomPlate(r) {
  const occ = occupantsOf(r.id);
  const st = roomState(r);
  const stLabel = { vacant: "Empty", partial: `${freeBeds(r)} free`, full: "Full" }[st];

  let beds = "";
  for (let i = 0; i < r.capacity; i++) {
    beds += occ[i]
      ? `<span class="bed taken ${tone(r.block)}" title="${esc(occ[i].name)}">${esc(initials(occ[i].name))}</span>`
      : `<span class="bed" title="Free bed"></span>`;
  }
  const people = occ.length
    ? occ.map((s) => `<li><span>${esc(s.name)}</span><button class="link-btn warn" data-act="deallocate" data-id="${s.id}" aria-label="Remove ${esc(s.name)} from room ${esc(r.number)}">Remove</button></li>`).join("")
    : `<li class="muted">No one yet</li>`;

  return `
    <article class="plate">
      <div class="plate-top">
        <span class="tag">${esc(r.number)}</span>
        <span class="chip ${r.type === "AC" ? "ac" : ""}">${esc(r.type || "Non-AC")}</span>
      </div>
      <div class="beds" aria-label="${occ.length} of ${r.capacity} beds filled">${beds}</div>
      <ul class="people">${people}</ul>
      <div class="plate-foot">
        <span class="state ${st}">${stLabel}</span>
        <button class="link-btn warn" data-act="delete-room" data-id="${r.id}">Delete room</button>
      </div>
    </article>`;
}

/* ---------- Students ---------- */
function renderStudents() {
  $("studentSeg").innerHTML = [["all", "All"], ["allocated", "Has a room"], ["waiting", "Waiting"]]
    .map(([v, label]) => `<button type="button" data-act="student-filter" data-val="${v}" aria-pressed="${ui.studentFilter === v}">${label}</button>`)
    .join("");

  const q = $("studentSearch").value.trim().toLowerCase();
  const list = db.students.filter((s) =>
    (ui.studentFilter === "all" || (ui.studentFilter === "allocated" ? s.roomId !== null : s.roomId === null)) &&
    (!q || s.name.toLowerCase().includes(q) || s.regNo.toLowerCase().includes(q))
  );

  $("studentBody").innerHTML = list.length
    ? list.map((s) => {
        const room = s.roomId !== null ? roomById(s.roomId) : null;
        return `
        <tr>
          <td><div class="person"><span class="avatar ${tone(blockOf(s.gender))}" aria-hidden="true">${esc(initials(s.name))}</span>
            <div><strong>${esc(s.name)}</strong><span>${esc(s.regNo)}</span></div></div></td>
          <td>${esc(s.department)}, ${ordinal(s.year)} year</td>
          <td>${esc(s.phone || "Not given")}</td>
          <td>${room ? `<span class="pill ok">Room ${esc(room.number)}</span>` : `<span class="pill wait">Waiting</span>`}</td>
          <td><div class="actions">
            ${room
              ? `<button class="link-btn" data-act="deallocate" data-id="${s.id}">Remove from room</button>`
              : `<button class="link-btn" data-act="pick-student" data-id="${s.id}">Allocate</button>`}
            <button class="link-btn warn" data-act="delete-student" data-id="${s.id}">Delete</button>
          </div></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="5"><div class="empty"><strong>No students found</strong>Add a student or change the search.</div></td></tr>`;
}

/* ---------- Allocation ---------- */
function renderAllocation() {
  const pending = pendingStudents();

  if (!pending.some((s) => s.id === ui.selStudent)) {
    ui.selStudent = pending.length ? pending[0].id : null;
    ui.selRoom = null;
  }
  const student = ui.selStudent !== null ? studentById(ui.selStudent) : null;
  const options = student ? roomsFor(student) : [];
  if (!options.some((r) => r.id === ui.selRoom)) ui.selRoom = null;

  $("pendingTitle").textContent = `Students waiting (${pending.length})`;
  $("autoBtn").disabled = pending.length === 0;

  $("pendingList").innerHTML = pending.length
    ? pending.map((s) => `
      <button type="button" class="pick" data-act="select-student" data-id="${s.id}" aria-pressed="${s.id === ui.selStudent}">
        <span class="avatar ${tone(blockOf(s.gender))}" aria-hidden="true">${esc(initials(s.name))}</span>
        <span class="who"><strong>${esc(s.name)}</strong><span>${esc(s.department)}, ${ordinal(s.year)} year, ${blockOf(s.gender)} block</span></span>
      </button>`).join("")
    : `<div class="empty"><strong>No one is waiting</strong>Add a student on the Students page to continue.</div>`;

  $("roomsPickTitle").textContent = student ? `Rooms for ${student.name}` : "Available rooms";

  if (!student) {
    $("roomPickList").innerHTML = `<div class="empty"><strong>Nothing to allocate</strong>All registered students have a room.</div>`;
  } else if (!options.length) {
    $("roomPickList").innerHTML = `<div class="empty"><strong>No free beds in the ${blockOf(student.gender)} block</strong>Add a room on the Rooms page, then come back.</div>`;
  } else {
    $("roomPickList").innerHTML = options.map((r, i) => {
      const f = freeBeds(r);
      return `
      <button type="button" class="pick" data-act="select-room" data-id="${r.id}" aria-pressed="${r.id === ui.selRoom}">
        <span class="tag">${esc(r.number)}</span>
        <span class="who"><strong>${floorName(r.floor)}, ${esc(r.type || "Non-AC")}</strong><span>${f} of ${r.capacity} beds free</span></span>
        ${i === 0 ? `<span class="best">Best fit</span>` : ""}
      </button>`;
    }).join("");
  }

  const chosen = ui.selRoom !== null ? roomById(ui.selRoom) : null;
  $("allocSummary").textContent = student && chosen ? `${student.name} to room ${chosen.number}` : "Pick a student and a room.";
  $("confirmAlloc").disabled = !(student && chosen);
}

/* ---------- JSON page ---------- */
function highlightJson(text) {
  return escText(text).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?/g,
    (m, str, colon, bool) => {
      if (str) return colon ? `<span class="key">${str}</span>${colon}` : `<span class="str">${str}</span>`;
      if (bool) return `<span class="bool">${m}</span>`;
      return `<span class="num">${m}</span>`;
    }
  );
}

function renderJson() {
  const text = JSON.stringify(db, null, 2);               // pretty-printed JSON
  $("jsonView").innerHTML = highlightJson(text);
  $("jsonStats").textContent = `${db.rooms.length} rooms, ${db.students.length} students, ${(new Blob([text]).size / 1024).toFixed(1)} KB`;
  if (ui.jsonTab === "view") $("jsonEditor").value = text;
}

function setJsonTab(tab) {
  ui.jsonTab = tab;
  document.querySelectorAll('[data-act="json-tab"]').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.val === tab)));
  $("jsonViewWrap").hidden = tab !== "view";
  $("jsonEditWrap").hidden = tab !== "edit";
  if (tab === "edit") {
    $("jsonEditor").value = JSON.stringify(db, null, 2);
    setJsonMsg("", "");
  }
}

function setJsonMsg(text, kind) {
  const el = $("jsonMsg");
  el.textContent = text;
  el.className = "msg " + kind;
}

function replaceDb(obj, message) {
  db = obj;
  ui.selStudent = null;
  ui.selRoom = null;
  save();
  renderAll();
  toast(message);
}

/* ==========================================================
   Actions
   ========================================================== */
function allocate(student, room) {
  student.roomId = room.id;
  logActivity(`${student.name} allocated to room ${room.number}`);
  save();
  renderAll();
  toast(`${student.name} is now in room ${room.number}.`);
}

async function deallocate(studentId) {
  const s = studentById(studentId);
  const room = roomById(s.roomId);
  if (!await confirmAction("Remove from room?", `${s.name} will leave room ${room.number} and go back to the waiting list.`, "Remove")) return;
  s.roomId = null;
  logActivity(`${s.name} removed from room ${room.number}`);
  save();
  renderAll();
  toast(`${s.name} removed from room ${room.number}.`);
}

async function deleteRoom(roomId) {
  const room = roomById(roomId);
  if (occupantsOf(roomId).length) {
    toast(`Room ${room.number} still has students. Remove them first.`, true);
    return;
  }
  if (!await confirmAction("Delete room?", `Room ${room.number} will be removed from the ${room.block} block.`, "Delete room")) return;
  db.rooms = db.rooms.filter((r) => r.id !== roomId);
  logActivity(`Room ${room.number} deleted`);
  save();
  renderAll();
  toast(`Room ${room.number} deleted.`);
}

async function deleteStudent(studentId) {
  const s = studentById(studentId);
  const extra = s.roomId !== null ? ` Their bed in room ${roomById(s.roomId).number} will be freed.` : "";
  if (!await confirmAction("Delete student?", `${s.name} (${s.regNo}) will be deleted.${extra}`, "Delete student")) return;
  db.students = db.students.filter((x) => x.id !== studentId);
  logActivity(`Student ${s.name} deleted`);
  save();
  renderAll();
  toast(`${s.name} deleted.`);
}

function autoAllocate() {
  let done = 0;
  pendingStudents().forEach((s) => {
    const best = roomsFor(s)[0];
    if (!best) return;
    s.roomId = best.id;
    logActivity(`${s.name} allocated to room ${best.number} (auto)`);
    done++;
  });
  const left = pendingStudents().length;
  save();
  renderAll();
  if (!done) toast("No free beds are available for the waiting students.", true);
  else toast(left ? `${done} allocated, ${left} still waiting for free beds.` : `All ${done} students allocated.`);
}

/* ---------- Forms ---------- */
function formFail(errorEl, message, input) {
  errorEl.textContent = message;
  document.querySelectorAll("input.invalid").forEach((i) => i.classList.remove("invalid"));
  if (input) { input.classList.add("invalid"); input.focus(); }
}

function openRoomDialog() {
  $("roomForm").reset();
  $("roomFloor").value = 1;
  $("roomCapacity").value = 2;
  $("roomError").textContent = "";
  $("roomDialog").showModal();
  $("roomNumber").focus();
}

function openStudentDialog() {
  $("studentForm").reset();
  $("studentError").textContent = "";
  $("studentDialog").showModal();
  $("stName").focus();
}

$("roomForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = $("roomError");
  const number = $("roomNumber").value.trim().toUpperCase();
  const floor = Number($("roomFloor").value);
  const capacity = Number($("roomCapacity").value);

  if (!/^[A-Z0-9-]{2,10}$/.test(number)) return formFail(err, "Room number needs 2 to 10 letters, digits or hyphens, like A-104.", $("roomNumber"));
  if (db.rooms.some((r) => r.number === number)) return formFail(err, `Room ${number} already exists.`, $("roomNumber"));
  if (!Number.isInteger(floor) || floor < 0 || floor > 10) return formFail(err, "Floor must be a whole number from 0 to 10.", $("roomFloor"));
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 6) return formFail(err, "Beds must be a whole number from 1 to 6.", $("roomCapacity"));

  const block = $("roomBlock").value;
  db.rooms.push({ id: nextId(db.rooms), number, block, floor, capacity, type: $("roomType").value });
  logActivity(`Room ${number} added to the ${block} block`);
  save();
  $("roomDialog").close();
  renderAll();
  toast(`Room ${number} added.`);
});

$("studentForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const err = $("studentError");
  const name = $("stName").value.trim().replace(/\s+/g, " ");
  const regNo = $("stReg").value.trim().toUpperCase();
  const phone = $("stPhone").value.trim();

  if (!/^[A-Za-z][A-Za-z .'-]{2,}$/.test(name)) return formFail(err, "Enter the full name using letters and spaces only.", $("stName"));
  if (!/^[A-Z0-9]{6,15}$/.test(regNo)) return formFail(err, "Register number needs 6 to 15 letters or digits, like FIT23CS045.", $("stReg"));
  if (db.students.some((s) => s.regNo === regNo)) return formFail(err, `Register number ${regNo} is already registered.`, $("stReg"));
  if (!/^[6-9]\d{9}$/.test(phone)) return formFail(err, "Phone must be a 10-digit mobile number.", $("stPhone"));

  db.students.push({
    id: nextId(db.students), name, regNo,
    gender: $("stGender").value, department: $("stDept").value,
    year: Number($("stYear").value), phone, roomId: null
  });
  logActivity(`Student ${name} registered`);
  save();
  $("studentDialog").close();
  renderAll();
  toast(`${name} added. They are waiting for a room.`);
});

/* ---------- JSON import / export ---------- */
function downloadJson() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "hostel-data.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("hostel-data.json downloaded.");
}

$("jsonFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    const problem = validateDb(obj);
    if (problem) return toast("Import failed. " + problem, true);
    replaceDb(obj, `Imported ${file.name}.`);
  } catch (err) {
    toast("Import failed. That file is not valid JSON.", true);
  }
});

function applyEditor() {
  try {
    const obj = JSON.parse($("jsonEditor").value);
    const problem = validateDb(obj);
    if (problem) return setJsonMsg(problem, "error");
    replaceDb(obj, "JSON applied. The whole app now uses your edited data.");
    setJsonMsg("Applied.", "ok");
  } catch (err) {
    setJsonMsg(err.name + ": " + err.message, "error");
  }
}

async function resetData() {
  if (!await confirmAction("Reset all data?", "Rooms, students and allocations go back to the contents of data.json. Your changes will be lost.", "Reset data")) return;
  try {
    replaceDb(await loadSeed(), "Data reset to data.json.");
  } catch (e) {
    toast("Could not read data.json.", true);
  }
}

/* ==========================================================
   Events (one delegated listener for every data-act button)
   ========================================================== */
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.dataset.id ? Number(btn.dataset.id) : null;

  switch (btn.dataset.act) {
    case "open-room-dialog": openRoomDialog(); break;
    case "open-student-dialog": openStudentDialog(); break;
    case "close-dialog": btn.closest("dialog").close(); break;
    case "room-block": ui.roomBlock = btn.dataset.val; renderRooms(); break;
    case "student-filter": ui.studentFilter = btn.dataset.val; renderStudents(); break;
    case "deallocate": deallocate(id); break;
    case "delete-room": deleteRoom(id); break;
    case "delete-student": deleteStudent(id); break;
    case "pick-student": ui.selStudent = id; ui.selRoom = null; renderAllocation(); location.hash = "#allocation"; break;
    case "select-student": ui.selStudent = id; ui.selRoom = null; renderAllocation(); break;
    case "select-room": ui.selRoom = id; renderAllocation(); break;
    case "confirm-allocate": {
      const s = studentById(ui.selStudent), r = roomById(ui.selRoom);
      if (s && r) allocate(s, r);
      break;
    }
    case "auto-allocate": autoAllocate(); break;
    case "json-tab": setJsonTab(btn.dataset.val); break;
    case "json-apply": applyEditor(); break;
    case "json-revert": $("jsonEditor").value = JSON.stringify(db, null, 2); setJsonMsg("Changes discarded.", "ok"); break;
    case "json-download": downloadJson(); break;
    case "json-reset": resetData(); break;
    case "json-copy":
      navigator.clipboard.writeText(JSON.stringify(db, null, 2))
        .then(() => toast("JSON copied."))
        .catch(() => toast("Copy is blocked in this browser. Use Download instead.", true));
      break;
  }
});

$("roomSearch").addEventListener("input", renderRooms);
$("roomStatus").addEventListener("change", renderRooms);
$("studentSearch").addEventListener("input", renderStudents);

/* ---------- Routing (hash based) ---------- */
function route() {
  const page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "dashboard";
  PAGES.forEach((p) => { $("page-" + p).hidden = p !== page; });
  document.querySelectorAll(".nav a").forEach((a) => {
    if (a.dataset.page === page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    a.classList.toggle("active", a.dataset.page === page);
  });
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

/* ==========================================================
   Start
   ========================================================== */
(async function init() {
  try {
    db = readSaved() || await loadSeed();
    const problem = validateDb(db);
    if (problem) throw new Error(problem);
  } catch (e) {
    document.getElementById("main").innerHTML =
      `<div class="page"><div class="panel empty"><strong>The hostel data could not be loaded</strong>${esc(e.message)}</div></div>`;
    return;
  }
  renderAll();
  route();
})();
