const categories = ["胸", "背中", "足", "肩", "腕", "腹筋", "有酸素", "その他"];
const analysisCategories = ["全体", ...categories];
const strengthAnalysisCategories = ["胸", "背中", "足", "肩", "腕", "腹筋"];
const $ = (selector) => document.querySelector(selector);
const form = $("#workout-form");
const categoryInput = $("#category");
const exerciseInput = $("#exercise");
const exerciseSelect = $("#exercise-select");
const setList = $("#set-list");
const todayKey = dateKey(new Date());
let selectedDateKey = todayKey;
let calendarDate = new Date();
calendarDate.setDate(1);
const miniCalendarMonths = { training: new Date(calendarDate), history: new Date(calendarDate) };
let activeWorkoutId = null;
let saveTimer;
let menus = JSON.parse(localStorage.getItem("exerciseMenus")) || {};
let deletedMenus = JSON.parse(localStorage.getItem("deletedExerciseMenus")) || {};
let workouts = migrate(JSON.parse(localStorage.getItem("workouts")) || []);
let pendingDeletedIds = JSON.parse(localStorage.getItem("pendingDeletedWorkoutIds")) || [];
let selectedAnalysisCategory = "全体";
const apiConfig = window.WORKOUT_API_CONFIG || { url: "", token: "" };

migrateRemovedCategoryStore(menus);
migrateRemovedCategoryStore(deletedMenus);

function migrateRemovedCategoryStore(store) {
  const removedItems = Array.isArray(store["お尻"]) ? store["お尻"] : [];
  const otherItems = Array.isArray(store["その他"]) ? store["その他"] : [];
  if (removedItems.length) store["その他"] = [...new Set([...otherItems, ...removedItems])];
  delete store["お尻"];
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function keyDate(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(key, options = { month: "long", day: "numeric" }) {
  return new Intl.DateTimeFormat("ja-JP", options).format(keyDate(key));
}

function migrate(items) {
  return items.map((item) => {
    const category = item.category === "お尻" ? "その他" : (categories.includes(item.category) ? item.category : "その他");
    const setDetails = (item.setDetails || []).map((set) => category === "有酸素"
      ? {
          distance: set.distance == null ? "-" : String(set.distance),
          duration: set.duration == null ? "-" : String(set.duration),
          speed: set.speed == null ? "-" : String(set.speed),
          calories: set.calories == null ? "-" : String(set.calories),
          memo: set.memo || "",
        }
      : {
          weight: set.weight == null ? "-" : String(set.weight),
          reps: set.reps == null ? "-" : String(set.reps),
          memo: set.memo || "",
        });
    if (item.memo && setDetails.length && !setDetails[0].memo) setDetails[0].memo = item.memo;
    return {
      ...item,
      category,
      memo: "",
      dateKey: item.dateKey || todayKey,
      setDetails,
    };
  });
}

function persist() {
  localStorage.setItem("workouts", JSON.stringify(workouts));
  localStorage.setItem("exerciseMenus", JSON.stringify(menus));
  localStorage.setItem("deletedExerciseMenus", JSON.stringify(deletedMenus));
  localStorage.setItem("pendingDeletedWorkoutIds", JSON.stringify(pendingDeletedIds));
}

function apiIsConfigured() {
  return /^https:\/\/script\.google\.com\/.+\/exec$/.test(apiConfig.url) && apiConfig.token && !apiConfig.token.startsWith("CHANGE_THIS");
}

function showSyncError(message = "") {
  const error = $("#sync-error");
  error.textContent = message;
  error.hidden = !message;
}

async function apiRequest(action, payload = {}) {
  if (!apiIsConfigured()) throw new Error("Googleスプレッドシートが未設定です。");
  let response;
  if (action === "list") {
    const url = new URL(apiConfig.url);
    url.searchParams.set("action", "list");
    url.searchParams.set("token", apiConfig.token);
    response = await fetch(url, { cache: "no-store", redirect: "follow" });
  } else {
    response = await fetch(apiConfig.url, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, token: apiConfig.token, ...payload }),
    });
  }
  if (!response.ok) throw new Error(`通信エラー（${response.status}）`);
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || "Googleスプレッドシートとの同期に失敗しました。");
  return data;
}

async function syncWorkout(workout) {
  if (!apiIsConfigured()) return;
  try {
    await apiRequest("upsert", { workout });
    showSyncError();
    $("#connection-status").textContent = "Googleスプレッドシートと接続済みです。";
  } catch (error) {
    showSyncError(`端末には保存しましたが、Googleへの同期に失敗しました：${error.message}`);
  }
}

async function syncDelete(id) {
  if (!apiIsConfigured()) return;
  try {
    await apiRequest("delete", { id });
    pendingDeletedIds = pendingDeletedIds.filter((item) => item !== id);
    persist();
    showSyncError();
  } catch (error) {
    showSyncError(`削除は端末に反映しましたが、Googleへの同期に失敗しました：${error.message}`);
  }
}

async function loadRemoteWorkouts() {
  if (!apiIsConfigured()) {
    $("#connection-status").textContent = "未接続です。config.jsにGASのURLを設定してください。";
    return;
  }
  $("#connection-status").textContent = "Googleスプレッドシートから取得中…";
  try {
    const data = await apiRequest("list");
    const localById = new Map(workouts.map((item) => [item.id, item]));
    const remoteById = new Map(data.workouts.filter((item) => !pendingDeletedIds.includes(item.id)).map((item) => [item.id, item]));
    const merged = new Map(remoteById);
    localById.forEach((local, id) => {
      const remote = remoteById.get(id);
      if (!remote || (local.updatedAt && local.updatedAt > (remote.updatedAt || ""))) merged.set(id, local);
    });
    workouts = migrate([...merged.values()]).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
    persist();
    renderAll();
    await Promise.all([...localById.values()].filter((item) => !remoteById.has(item.id)).map(syncWorkout));
    await Promise.all(pendingDeletedIds.map(syncDelete));
    $("#connection-status").textContent = "Googleスプレッドシートと接続済みです。";
    showSyncError();
  } catch (error) {
    $("#connection-status").textContent = "接続できませんでした。端末内のデータを表示しています。";
    showSyncError(`Googleスプレッドシートから取得できません：${error.message}`);
  }
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function updateMenuOptions() {
  const currentValue = exerciseSelect.value;
  const names = new Set(menus[categoryInput.value] || []);
  workouts.filter((item) => item.category === categoryInput.value).forEach((item) => names.add(item.exercise));
  const deleted = new Set(deletedMenus[categoryInput.value] || []);
  const selectOption = document.createElement("option");
  selectOption.value = "__select__";
  selectOption.textContent = "種目名を選択";
  const newOption = document.createElement("option");
  newOption.value = "__new__";
  newOption.textContent = "＋ 新しい種目を追加";
  exerciseSelect.replaceChildren(selectOption, newOption, ...[...names].filter((name) => !deleted.has(name)).sort((a, b) => a.localeCompare(b, "ja")).map((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    return option;
  }));
  if ([...exerciseSelect.options].some((option) => option.value === currentValue)) {
    exerciseSelect.value = currentValue;
  }
  renderExerciseMenu();
}

function selectedExerciseName() {
  if (exerciseSelect.value === "__new__") return exerciseInput.value.trim();
  return exerciseSelect.value === "__select__" ? "" : exerciseSelect.value;
}

function updateExerciseInputVisibility() {
  $("#new-exercise-field").hidden = exerciseSelect.value !== "__new__";
  renderExerciseMenu();
}

function renderExerciseMenu() {
  const menu = $("#exercise-menu");
  const triggerLabel = $("#exercise-trigger").querySelector("span");
  if (exerciseSelect.value === "__new__") triggerLabel.textContent = "＋ 新しい種目を追加";
  else if (exerciseSelect.value === "__select__" || !exerciseSelect.value) triggerLabel.textContent = "種目名を選択";
  else triggerLabel.textContent = exerciseSelect.value;

  const rows = [...exerciseSelect.options]
    .filter((option) => option.value !== "__select__")
    .map((option) => {
      const row = document.createElement("div");
      row.className = "exercise-menu-row";
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = `exercise-menu-choice${option.value === exerciseSelect.value ? " selected" : ""}`;
      choice.textContent = option.textContent;
      choice.addEventListener("click", () => chooseExerciseOption(option.value));
      row.append(choice);
      if (option.value !== "__new__") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "exercise-menu-delete";
        remove.textContent = "🗑";
        remove.setAttribute("aria-label", `${option.textContent}を候補から削除`);
        remove.addEventListener("click", () => deleteSelectedExercise(option.value));
        row.append(remove);
      }
      return row;
    });
  menu.replaceChildren(...rows);
}

function chooseExerciseOption(value) {
  exerciseSelect.value = value;
  $("#exercise-menu").hidden = true;
  $("#exercise-trigger").setAttribute("aria-expanded", "false");
  exerciseSelect.dispatchEvent(new Event("change"));
}

function loadWorkoutForCurrentSelection() {
  const name = selectedExerciseName();
  activeWorkoutId = null;
  const existing = name
    ? workouts.find((item) => item.dateKey === selectedDateKey && item.category === categoryInput.value && item.exercise === name)
    : null;
  setList.replaceChildren();
  if (existing) {
    activeWorkoutId = existing.id;
    existing.setDetails.forEach(addSet);
  } else {
    addSet();
  }
  renderPreviousWorkout();
}

function renderPreviousWorkout() {
  const name = selectedExerciseName();
  const previous = workouts
    .filter((item) => item.id !== activeWorkoutId && item.exercise === name && item.category === categoryInput.value && item.dateKey < selectedDateKey)
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey))[0];
  const box = $("#previous-workout");
  if (!name || !previous) {
    box.hidden = true;
    return;
  }
  $("#previous-workout-date").textContent = formatDate(previous.dateKey, { year: "numeric", month: "short", day: "numeric" });
  $("#previous-workout-sets").textContent = previous.setDetails.map((set, index) => `${index + 1}. ${formatSetDetails(set, previous.category)}`).join("　");
  box.hidden = false;
}

function deleteSelectedExercise(name = exerciseSelect.value) {
  if (name === "__new__" || name === "__select__") return;
  const category = categoryInput.value;
  const deletingCurrent = exerciseSelect.value === name;
  menus[category] = (menus[category] || []).filter((item) => item !== name);
  deletedMenus[category] ||= [];
  if (!deletedMenus[category].includes(name)) deletedMenus[category].push(name);
  persist();
  updateMenuOptions();
  if (deletingCurrent) resetEntry();
  else renderExerciseMenu();
}

function estimatedRm(weight, reps) {
  const w = Number(weight);
  const r = Number(reps);
  if (!(w > 0) || !(r > 0)) return "";
  // 1回挙げた重量は、その記録自体を1RMとして扱う。
  const rm = r === 1 ? w : w * (1 + r / 30);
  return `${rm.toFixed(1)}kg RM`;
}

function workoutLoad(item) {
  return item.setDetails.reduce((total, set) => {
    const weight = Number(set.weight);
    const reps = Number(set.reps);
    return total + (Number.isFinite(weight) && Number.isFinite(reps) ? weight * reps : 0);
  }, 0);
}

function workoutDistance(item) {
  if (item.category !== "有酸素") return 0;
  return item.setDetails.reduce((total, set) => {
    const distance = Number(set.distance);
    return total + (Number.isFinite(distance) ? distance : 0);
  }, 0);
}

function currentWeekWorkouts() {
  const start = startOfWeek(keyDate(todayKey));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return workouts.filter((item) => {
    const date = keyDate(item.dateKey);
    return date >= start && date <= end;
  });
}

function displayTons(value) {
  return (value / 1000).toLocaleString("ja-JP", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function renderAnalysis() {
  const tabs = analysisCategories.map((category) => {
    const button = document.createElement("button");
    const active = category === selectedAnalysisCategory;
    button.type = "button";
    button.className = active ? "active" : "";
    button.textContent = category;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(active));
    button.addEventListener("click", () => {
      selectedAnalysisCategory = category;
      renderAnalysis();
    });
    return button;
  });
  $("#analysis-category-tabs").replaceChildren(...tabs);

  const overall = selectedAnalysisCategory === "全体";
  $("#analysis-overall").hidden = !overall;
  $("#analysis-specific").hidden = overall;
  if (overall) renderOverallAnalysis();
  else renderCategoryAnalysis(selectedAnalysisCategory);
}

function renderOverallAnalysis() {
  const recent = currentWeekWorkouts();
  const totals = strengthAnalysisCategories.map((category) => ({
    category,
    value: recent.filter((item) => item.category === category).reduce((sum, item) => sum + workoutLoad(item), 0),
  }));
  const max = Math.max(...totals.map((item) => item.value), 1);
  $("#analysis-bodypart-bars").replaceChildren(...totals.map(({ category, value }) => {
    const row = document.createElement("div");
    row.className = "analysis-horizontal-row";
    const width = value > 0 ? (value / max) * 100 : 0;
    row.innerHTML = `<strong>${category}</strong><span class="analysis-horizontal-track"><span class="analysis-horizontal-bar" style="width:${width}%"></span></span><span>${displayTons(value)}t</span>`;
    return row;
  }));
  const distance = recent.reduce((sum, item) => sum + workoutDistance(item), 0);
  $("#analysis-cardio-distance").textContent = distance.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
}

function renderCategoryAnalysis(category) {
  const aerobic = category === "有酸素";
  const totalsByDate = new Map();
  workouts
    .filter((item) => item.category === category)
    .forEach((item) => totalsByDate.set(
      item.dateKey,
      (totalsByDate.get(item.dateKey) || 0) + (aerobic ? workoutDistance(item) : workoutLoad(item)),
    ));
  const values = [...totalsByDate.entries()]
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([date, value]) => ({ date, value }));
  const empty = values.length === 0;
  $("#analysis-empty").hidden = !empty;
  $("#analysis-date-chart").hidden = empty;
  $("#analysis-specific-title").textContent = aerobic ? `${category}の日付別合計距離` : `${category}の日付別合計負荷量`;
  $("#analysis-specific-unit").textContent = aerobic ? "距離 / km" : "負荷量 / t";
  if (empty) {
    $("#analysis-date-chart").replaceChildren();
    return;
  }
  const max = Math.max(...values.map((item) => item.value), 1);
  const container = $("#analysis-date-chart");
  const canvas = document.createElement("canvas");
  const plotLeft = 48;
  const plotRight = 18;
  const plotTop = 28;
  const plotBottom = 38;
  const chartHeight = 250;
  const chartWidth = Math.max(container.clientWidth || 300, plotLeft + plotRight + Math.max(values.length - 1, 1) * 68);
  const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.className = "analysis-line-canvas";
  canvas.width = Math.round(chartWidth * ratio);
  canvas.height = Math.round(chartHeight * ratio);
  canvas.style.width = `${chartWidth}px`;
  canvas.style.height = `${chartHeight}px`;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", values.map(({ date, value }) => {
    const amount = aerobic ? `${value}km` : `${displayTons(value)}t`;
    return `${formatDate(date, { month: "numeric", day: "numeric" })} ${amount}`;
  }).join("、"));
  container.replaceChildren(canvas);

  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(ratio, ratio);
  const styles = getComputedStyle(document.documentElement);
  const ink = styles.getPropertyValue("--ink").trim();
  const muted = styles.getPropertyValue("--muted").trim();
  const line = styles.getPropertyValue("--line").trim();
  const accent = styles.getPropertyValue("--accent").trim();
  const plotWidth = chartWidth - plotLeft - plotRight;
  const plotHeight = chartHeight - plotTop - plotBottom;
  const formatValue = (value) => aerobic
    ? value.toLocaleString("ja-JP", { maximumFractionDigits: 2 })
    : displayTons(value);

  context.font = '10px "Helvetica Neue", "Hiragino Sans", sans-serif';
  context.textBaseline = "middle";
  for (let index = 0; index <= 4; index += 1) {
    const y = plotTop + (plotHeight / 4) * index;
    const tickValue = max * (1 - index / 4);
    context.beginPath();
    context.moveTo(plotLeft, y);
    context.lineTo(chartWidth - plotRight, y);
    context.strokeStyle = line;
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = muted;
    context.textAlign = "right";
    context.fillText(formatValue(tickValue), plotLeft - 7, y);
  }

  const points = values.map(({ date, value }, index) => ({
    date,
    value,
    x: values.length === 1 ? plotLeft + plotWidth / 2 : plotLeft + (plotWidth / (values.length - 1)) * index,
    y: plotTop + plotHeight - (value / max) * plotHeight,
  }));
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.strokeStyle = ink;
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();

  points.forEach((point) => {
    context.beginPath();
    context.arc(point.x, point.y, 5, 0, Math.PI * 2);
    context.fillStyle = accent;
    context.fill();
    context.strokeStyle = ink;
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = ink;
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.fillText(formatValue(point.value), point.x, Math.max(point.y - 8, 12));
    context.fillStyle = muted;
    context.textBaseline = "top";
    context.fillText(formatDate(point.date, { month: "numeric", day: "numeric" }), point.x, chartHeight - plotBottom + 10);
  });
}

function startOfWeek(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = result.getDay() || 7;
  result.setDate(result.getDate() - day + 1);
  result.setHours(0, 0, 0, 0);
  return result;
}

function renderMetrics() {
  const now = keyDate(todayKey);
  const currentWeekLoad = currentWeekWorkouts().reduce((sum, item) => sum + workoutLoad(item), 0);
  const loadInTons = currentWeekLoad / 1000;
  $("#current-week-load").textContent = loadInTons.toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

  const currentWeek = startOfWeek(now);
  const weeks = Array.from({ length: 6 }, (_, index) => {
    const start = new Date(currentWeek);
    start.setDate(currentWeek.getDate() - index * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const value = workouts
      .filter((item) => {
        const date = keyDate(item.dateKey);
        return date >= start && date <= end;
      })
      .reduce((sum, item) => sum + workoutLoad(item), 0);
    return { label: index === 0 ? "今週" : `${index}週前`, value };
  });
  const max = Math.max(...weeks.map((week) => week.value), 1);
  $("#weekly-chart").replaceChildren(...weeks.map((week, index) => {
    const row = document.createElement("div");
    row.className = `chart-row${index === 0 ? " current" : ""}`;
    const width = week.value === 0 ? 0 : (week.value / max) * 100;
    row.innerHTML = `<span>${week.label}</span><span class="chart-track"><span class="chart-bar" style="width:${width}%"></span></span><span class="chart-value">${(week.value / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}t</span>`;
    return row;
  }));
}

function switchTab(tabName) {
  if (tabName === "analysis") {
    selectedAnalysisCategory = "全体";
    renderAnalysis();
  }
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const active = panel.dataset.panel === tabName;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll(".bottom-tabs button").forEach((button) => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renumberSets() {
  const rows = [...setList.querySelectorAll(".set-row")];
  rows.forEach((row, index) => {
    row.querySelector(".set-number").textContent = `SET ${index + 1}`;
    row.querySelector(".remove-set-button").disabled = rows.length === 1;
  });
}

function updateRm(row) {
  const rm = row.querySelector(".rm-value");
  if (rm) rm.textContent = estimatedRm(row.querySelector(".set-weight").value, row.querySelector(".set-reps").value);
}

function normalizeSet(row) {
  const metricInputs = [...row.querySelectorAll("input:not(.set-memo-input)")];
  if (metricInputs.every((input) => !input.value.trim())) {
    if (setList.children.length > 1) row.remove();
  } else {
    metricInputs.forEach((input) => { if (!input.value.trim()) input.value = "-"; });
  }
  renumberSets();
  scheduleSave();
}

function addSet(values = {}) {
  const row = document.createElement("div");
  const cardio = categoryInput.value === "有酸素";
  row.className = `set-row${cardio ? " cardio-set-row" : ""}`;
  row.innerHTML = cardio
    ? `<span class="set-number"></span><label class="field"><span>距離 <small>km</small></span><input class="set-distance" type="text" inputmode="decimal" value="${escapeHtml(values.distance ?? "")}"></label><label class="field"><span>時間 <small>min</small></span><input class="set-duration" type="text" inputmode="decimal" value="${escapeHtml(values.duration ?? "")}"></label><label class="field"><span>速さ <small>km/h</small></span><input class="set-speed" type="text" inputmode="decimal" value="${escapeHtml(values.speed ?? "")}"></label><label class="field"><span>カロリー <small>kcal</small></span><input class="set-calories" type="text" inputmode="decimal" value="${escapeHtml(values.calories ?? "")}"></label><button class="remove-set-button" type="button" aria-label="このセットを削除">×</button><label class="set-memo-field"><span class="visually-hidden">このセットのメモ</span><input class="set-memo-input" type="text" value="${escapeHtml(values.memo ?? "")}" placeholder="メモ（任意）"></label>`
    : `<span class="set-number"></span><label class="field"><span>重量 <small>kg</small></span><input class="set-weight" type="text" inputmode="decimal" value="${escapeHtml(values.weight ?? "")}"></label><label class="field"><span>回数 <small class="rm-value"></small></span><input class="set-reps" type="text" inputmode="numeric" value="${escapeHtml(values.reps ?? "")}"></label><button class="remove-set-button" type="button" aria-label="このセットを削除">×</button><label class="set-memo-field"><span class="visually-hidden">このセットのメモ</span><input class="set-memo-input" type="text" value="${escapeHtml(values.memo ?? "")}" placeholder="メモ（任意）"></label>`;
  row.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => { updateRm(row); scheduleSave(); });
    input.addEventListener("blur", (event) => {
      if (!row.contains(event.relatedTarget)) normalizeSet(row);
    });
  });
  row.querySelector("button").addEventListener("click", () => { row.remove(); renumberSets(); scheduleSave(); });
  setList.append(row);
  renumberSets();
  updateRm(row);
}

function readSets() {
  return [...setList.querySelectorAll(".set-row")].map((row) => {
    if (row.classList.contains("cardio-set-row")) {
      return {
        distance: row.querySelector(".set-distance").value.trim(),
        duration: row.querySelector(".set-duration").value.trim(),
        speed: row.querySelector(".set-speed").value.trim(),
        calories: row.querySelector(".set-calories").value.trim(),
        memo: row.querySelector(".set-memo-input").value.trim(),
      };
    }
    return { weight: row.querySelector(".set-weight").value.trim(), reps: row.querySelector(".set-reps").value.trim(), memo: row.querySelector(".set-memo-input").value.trim() };
  }).filter((set) => Object.entries(set).some(([key, value]) => key !== "memo" && value)).map((set) => Object.fromEntries(Object.entries(set).map(([key, value]) => [key, key === "memo" ? value : value || "-"])));
}

function formatSetDetails(set, category) {
  if (category === "有酸素") return `${set.distance}km / ${set.duration}min / ${set.speed}km/h / ${set.calories}kcal`;
  const rm = estimatedRm(set.weight, set.reps);
  return `${set.weight}kg × ${set.reps}回${rm ? ` / ${rm}` : ""}`;
}

function scheduleSave() {
  $("#save-status").textContent = "保存中…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autoSave, 350);
}

function autoSave() {
  const exercise = selectedExerciseName();
  const setDetails = readSets();
  if (!exercise || !setDetails.length) {
    $("#save-status").textContent = "種目名とセット内容を入力すると自動保存されます";
    return;
  }
  const data = { exercise, category: categoryInput.value, dateKey: selectedDateKey, date: formatDate(selectedDateKey, { dateStyle: "medium" }), setDetails, memo: "", updatedAt: new Date().toISOString() };
  if (activeWorkoutId) workouts = workouts.map((item) => item.id === activeWorkoutId ? { ...item, ...data } : item);
  else {
    activeWorkoutId = crypto.randomUUID();
    workouts.unshift({ id: activeWorkoutId, ...data });
  }
  menus[data.category] ||= [];
  if (exerciseSelect.value === "__new__") {
    if (!menus[data.category].includes(exercise)) menus[data.category].push(exercise);
    deletedMenus[data.category] = (deletedMenus[data.category] || []).filter((name) => name !== exercise);
  }
  persist();
  $("#save-status").textContent = "保存しました ✓";
  updateMenuOptions();
  renderAll();
  void syncWorkout(workouts.find((item) => item.id === activeWorkoutId));
}

function resetEntry() {
  clearTimeout(saveTimer);
  activeWorkoutId = null;
  exerciseInput.value = "";
  exerciseSelect.value = "__select__";
  updateExerciseInputVisibility();
  renderPreviousWorkout();
  setList.replaceChildren();
  addSet();
  $("#save-status").textContent = "入力内容は自動保存されます";
}

function editWorkout(id) {
  const item = workouts.find((workout) => workout.id === id);
  if (!item) return;
  activeWorkoutId = id;
  selectedDateKey = item.dateKey;
  calendarDate = keyDate(item.dateKey);
  calendarDate.setDate(1);
  categoryInput.value = item.category;
  updateMenuOptions();
  exerciseSelect.value = item.exercise;
  if (exerciseSelect.value !== item.exercise) {
    exerciseSelect.value = "__new__";
    exerciseInput.value = item.exercise;
  } else {
    exerciseInput.value = "";
  }
  updateExerciseInputVisibility();
  setList.replaceChildren();
  item.setDetails.forEach(addSet);
  renderPreviousWorkout();
  $("#save-status").textContent = "この記録を編集中（変更は自動保存）";
  renderAll();
  switchTab("training");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function deleteWorkout(id) {
  workouts = workouts.filter((item) => item.id !== id);
  if (!pendingDeletedIds.includes(id)) pendingDeletedIds.push(id);
  if (activeWorkoutId === id) resetEntry();
  persist();
  renderAll();
  void syncDelete(id);
}

function workoutItem(item) {
  const li = document.createElement("li");
  li.className = "workout-item";
  const info = document.createElement("div");
  const title = document.createElement("h3");
  const category = document.createElement("p");
  title.textContent = item.exercise;
  category.textContent = item.category;
  info.append(title, category);
  const sets = document.createElement("div");
  sets.className = "workout-sets";
  item.setDetails.forEach((set, index) => {
    const line = document.createElement("div");
    line.className = "workout-set";
    line.innerHTML = `<span>SET ${index + 1}</span><span>${escapeHtml(formatSetDetails(set, item.category))}${set.memo ? `<small class="set-note">${escapeHtml(set.memo)}</small>` : ""}</span>`;
    sets.append(line);
  });
  const actions = document.createElement("div");
  actions.className = "workout-actions";
  const edit = document.createElement("button");
  edit.className = "edit-button"; edit.type = "button"; edit.textContent = "編集"; edit.addEventListener("click", () => editWorkout(item.id));
  const remove = document.createElement("button");
  remove.className = "delete-button"; remove.type = "button"; remove.textContent = "削除"; remove.addEventListener("click", () => deleteWorkout(item.id));
  actions.append(edit, remove);
  li.append(info, sets, actions);
  return li;
}

function renderHistory() {
  const daily = workouts.filter((item) => item.dateKey === selectedDateKey);
  $("#workout-list").replaceChildren(...daily.map(workoutItem));
  $("#empty-message").hidden = daily.length > 0;
  $("#total-exercises").textContent = daily.length;
  const dailyLoadInTons = daily.reduce((sum, item) => sum + workoutLoad(item), 0) / 1000;
  $("#history-total-load").textContent = dailyLoadInTons.toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  $("#history-date").textContent = formatDate(selectedDateKey);
  $("#training-date-button").textContent = formatDate(selectedDateKey, { month: "short", day: "numeric", weekday: "short" });
  $("#history-date-button").textContent = formatDate(selectedDateKey, { year: "numeric", month: "short", day: "numeric" });
}

function renderMiniCalendar(kind) {
  const container = $(`#${kind}-mini-calendar`);
  const view = miniCalendarMonths[kind];
  const year = view.getFullYear();
  const month = view.getMonth();
  const recorded = new Set(workouts.map((item) => item.dateKey));
  const header = document.createElement("div");
  header.className = "mini-calendar-header";
  const previous = document.createElement("button");
  previous.type = "button"; previous.textContent = "←";
  const title = document.createElement("strong");
  title.textContent = `${year}年 ${month + 1}月`;
  const next = document.createElement("button");
  next.type = "button"; next.textContent = "→";
  previous.addEventListener("click", () => { view.setMonth(view.getMonth() - 1); renderMiniCalendar(kind); });
  next.addEventListener("click", () => { view.setMonth(view.getMonth() + 1); renderMiniCalendar(kind); });
  header.append(previous, title, next);

  const weekdays = document.createElement("div");
  weekdays.className = "mini-weekdays";
  ["日", "月", "火", "水", "木", "金", "土"].forEach((day) => {
    const span = document.createElement("span"); span.textContent = day; weekdays.append(span);
  });
  const grid = document.createElement("div");
  grid.className = "mini-calendar-grid";
  const start = new Date(year, month, 1);
  start.setDate(start.getDate() - start.getDay());
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = dateKey(date);
    const button = document.createElement("button");
    button.type = "button"; button.className = "mini-day"; button.textContent = date.getDate();
    if (date.getMonth() !== month) button.classList.add("outside");
    if (recorded.has(key)) button.classList.add("has-workout");
    if (key === selectedDateKey) button.classList.add("selected");
    button.addEventListener("click", () => selectMiniCalendarDate(kind, key));
    grid.append(button);
  }
  container.replaceChildren(header, weekdays, grid);
}

function selectMiniCalendarDate(kind, key) {
  selectedDateKey = key;
  calendarDate = keyDate(key);
  calendarDate.setDate(1);
  miniCalendarMonths.training = new Date(calendarDate);
  miniCalendarMonths.history = new Date(calendarDate);
  $(`#${kind}-mini-calendar`).hidden = true;
  renderAll();
  if (kind === "training") loadWorkoutForCurrentSelection();
  else renderPreviousWorkout();
}

function toggleMiniCalendar(kind) {
  const container = $(`#${kind}-mini-calendar`);
  const willOpen = container.hidden;
  document.querySelectorAll(".mini-calendar").forEach((calendar) => { calendar.hidden = true; });
  if (willOpen) {
    miniCalendarMonths[kind] = keyDate(selectedDateKey);
    miniCalendarMonths[kind].setDate(1);
    renderMiniCalendar(kind);
    container.hidden = false;
  }
}

function renderCalendar() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  $("#calendar-month").textContent = `${year}年 ${month + 1}月`;
  const start = new Date(year, month, 1);
  start.setDate(start.getDate() - start.getDay());
  const recorded = new Set(workouts.map((item) => item.dateKey));
  const days = [];
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = dateKey(date);
    const button = document.createElement("button");
    button.type = "button"; button.className = "calendar-day"; button.textContent = date.getDate();
    if (date.getMonth() !== month) button.classList.add("outside");
    if (recorded.has(key)) button.classList.add("has-workout");
    if (key === selectedDateKey) button.classList.add("selected");
    if (key === todayKey) button.classList.add("today");
    button.addEventListener("click", () => { selectedDateKey = key; calendarDate = new Date(date.getFullYear(), date.getMonth(), 1); resetEntry(); renderAll(); });
    days.push(button);
  }
  $("#calendar-grid").replaceChildren(...days);
}

function renderAll() { renderCalendar(); renderHistory(); renderMetrics(); renderAnalysis(); renderMiniCalendar("training"); renderMiniCalendar("history"); }
form.addEventListener("submit", (event) => event.preventDefault());
categoryInput.addEventListener("change", () => {
  updateMenuOptions();
  exerciseSelect.value = "__select__";
  exerciseInput.value = "";
  updateExerciseInputVisibility();
  loadWorkoutForCurrentSelection();
});
exerciseSelect.addEventListener("change", () => {
  updateExerciseInputVisibility();
  if (exerciseSelect.value === "__new__") {
    activeWorkoutId = null;
    exerciseInput.value = "";
    setList.replaceChildren();
    addSet();
    renderPreviousWorkout();
  } else {
    loadWorkoutForCurrentSelection();
  }
});
$("#exercise-trigger").addEventListener("click", () => {
  const menu = $("#exercise-menu");
  menu.hidden = !menu.hidden;
  $("#exercise-trigger").setAttribute("aria-expanded", String(!menu.hidden));
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".exercise-dropdown")) {
    $("#exercise-menu").hidden = true;
    $("#exercise-trigger").setAttribute("aria-expanded", "false");
  }
});
exerciseInput.addEventListener("input", () => { renderPreviousWorkout(); scheduleSave(); });
$("#training-date-button").addEventListener("click", () => toggleMiniCalendar("training"));
$("#history-date-button").addEventListener("click", () => toggleMiniCalendar("history"));
$("#add-set-button").addEventListener("click", () => { addSet(); setList.lastElementChild.querySelector(".set-weight").focus(); });
$("#new-workout-button").addEventListener("click", () => { resetEntry(); exerciseInput.focus(); });
$("#prev-month").addEventListener("click", () => { calendarDate.setMonth(calendarDate.getMonth() - 1); renderCalendar(); });
$("#next-month").addEventListener("click", () => { calendarDate.setMonth(calendarDate.getMonth() + 1); renderCalendar(); });
document.querySelectorAll(".bottom-tabs button").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
const savedTheme = localStorage.getItem("workoutTheme") || "light";
document.documentElement.dataset.theme = savedTheme;
$("#theme-select").value = savedTheme;
$("#theme-select").addEventListener("change", (event) => {
  document.documentElement.dataset.theme = event.target.value;
  localStorage.setItem("workoutTheme", event.target.value);
  renderAnalysis();
});
window.addEventListener("resize", () => {
  if (!$("#panel-analysis").hidden && selectedAnalysisCategory !== "全体") renderCategoryAnalysis(selectedAnalysisCategory);
});
$("#retry-sync-button").addEventListener("click", loadRemoteWorkouts);
$("#home-today").textContent = new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", weekday: "short" }).format(new Date());
persist(); updateMenuOptions(); updateExerciseInputVisibility(); addSet(); renderAll(); switchTab("home"); void loadRemoteWorkouts();
