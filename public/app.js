const state = {
  session: null,
  selectedPath: null,
  viewed: new Set(),
  fileCache: new Map(),
  mergely: null
};

const els = {
  form: document.querySelector("#compare-form"),
  prUrl: document.querySelector("#pr-url"),
  baseBranch: document.querySelector("#base-branch"),
  submit: document.querySelector("#submit-button"),
  message: document.querySelector("#message"),
  repoTitle: document.querySelector("#repo-title"),
  prMeta: document.querySelector("#pr-meta"),
  totals: document.querySelector("#totals"),
  totalAdditions: document.querySelector("#total-additions"),
  totalDeletions: document.querySelector("#total-deletions"),
  filter: document.querySelector("#file-filter"),
  fileTree: document.querySelector("#file-tree"),
  fileTitle: document.querySelector("#file-title"),
  fileSubtitle: document.querySelector("#file-subtitle"),
  prevChange: document.querySelector("#prev-change"),
  nextChange: document.querySelector("#next-change"),
  viewedToggle: document.querySelector("#viewed-toggle"),
  binaryNotice: document.querySelector("#binary-notice"),
  lhsTitle: document.querySelector(".title-column.lhs"),
  rhsTitle: document.querySelector(".title-column.rhs")
};

els.form.addEventListener("submit", handleSubmit);
els.filter.addEventListener("input", renderFileTree);
els.prevChange.addEventListener("click", () => state.mergely?.scrollToDiff("prev"));
els.nextChange.addEventListener("click", () => state.mergely?.scrollToDiff("next"));
els.viewedToggle.addEventListener("change", () => {
  if (!state.selectedPath) return;
  if (els.viewedToggle.checked) state.viewed.add(state.selectedPath);
  else state.viewed.delete(state.selectedPath);
  renderFileTree();
});

waitForMergely();

async function handleSubmit(event) {
  event.preventDefault();
  const prUrl = els.prUrl.value.trim();
  const baseBranch = els.baseBranch.value.trim() || "master";

  setLoading(true);
  setMessage("loading", "Loading pull request and changed files...");
  clearSelection();

  try {
    const session = await api("/api/pr/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prUrl, baseBranch })
    });
    state.session = session;
    state.selectedPath = null;
    state.viewed.clear();
    state.fileCache.clear();
    renderSession(session);
    setMessage("success", `Loaded ${session.files.length} changed file${session.files.length === 1 ? "" : "s"}.`);
    if (session.files.length) await selectFile(session.files[0].path);
  } catch (error) {
    state.session = null;
    renderSession(null);
    setMessage("error", error.message);
  } finally {
    setLoading(false);
  }
}

function renderSession(session) {
  if (!session) {
    els.repoTitle.textContent = "No PR loaded";
    els.prMeta.textContent = "Submit a pull request URL to begin.";
    els.totals.hidden = true;
    els.fileTree.className = "file-tree empty-state";
    els.fileTree.textContent = "Changed files will appear here.";
    return;
  }

  els.repoTitle.textContent = session.repo;
  els.prMeta.textContent = `#${session.prNumber} ${session.title}`;
  els.totalAdditions.textContent = `+${session.totals.additions}`;
  els.totalDeletions.textContent = `-${session.totals.deletions}`;
  els.totals.hidden = false;
  renderFileTree();
}

function renderFileTree() {
  const session = state.session;
  if (!session) return;

  const filter = els.filter.value.trim().toLowerCase();
  const files = session.files.filter((file) => !filter || file.path.toLowerCase().includes(filter));
  els.fileTree.className = "file-tree";
  els.fileTree.replaceChildren();

  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No files match the filter.";
    els.fileTree.append(empty);
    return;
  }

  const root = buildTree(files);
  els.fileTree.append(renderTreeNode(root, ""));
}

function buildTree(files) {
  const root = { name: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  return root;
}

function renderTreeNode(node, prefix) {
  const fragment = document.createDocumentFragment();
  for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = dir.name;
    details.append(summary, renderTreeNode(dir, `${prefix}${dir.name}/`));
    fragment.append(details);
  }

  for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-row";
    if (file.path === state.selectedPath) button.classList.add("active");
    if (state.viewed.has(file.path)) button.classList.add("viewed");
    button.addEventListener("click", () => selectFile(file.path));

    const badge = document.createElement("span");
    badge.className = `status status-${file.status}`;
    badge.textContent = file.status;

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.path.slice(prefix.length);

    const stats = document.createElement("span");
    stats.className = "file-stats";
    stats.textContent = file.binary ? "binary" : `+${file.additions} -${file.deletions}`;

    button.append(badge, name, stats);
    fragment.append(button);
  }

  return fragment;
}

async function selectFile(path) {
  if (!state.session) return;
  state.selectedPath = path;
  renderFileTree();
  setFileLoading(path);

  try {
    const data = state.fileCache.get(path) || await api(`/api/pr/file?sessionId=${encodeURIComponent(state.session.sessionId)}&path=${encodeURIComponent(path)}`);
    state.fileCache.set(path, data);
    renderFile(data);
  } catch (error) {
    setMessage("error", error.message);
  }
}

function renderFile(file) {
  document.body.classList.remove("empty-diff");
  const session = state.session;
  const title = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} -> ${file.path}` : file.path;
  els.fileTitle.textContent = title;
  els.fileSubtitle.textContent = file.binary ? "Binary file cannot be rendered in the text diff viewer." : `${statusLabel(file.status)} file`;
  els.viewedToggle.disabled = false;
  els.viewedToggle.checked = state.viewed.has(file.path);
  els.prevChange.disabled = file.binary;
  els.nextChange.disabled = file.binary;
  els.binaryNotice.hidden = !file.binary;
  els.binaryNotice.textContent = file.binary ? "This file is binary or too large for text rendering." : "";
  els.lhsTitle.textContent = `${session.baseBranch} @ ${shortSha(session.compareLeftSha || session.mergeBaseSha)}: ${file.oldPath || file.path}`;
  els.rhsTitle.textContent = `${session.headRefName}: ${file.path}`;

  if (!state.mergely || file.binary) {
    setMergelyContent("", "");
    return;
  }

  setMergelyContent(file.left, file.right);
  setTimeout(() => state.mergely?.scrollToDiff("next"), 80);
}

function setFileLoading(path) {
  els.fileTitle.textContent = path;
  els.fileSubtitle.textContent = "Loading file content...";
  els.prevChange.disabled = true;
  els.nextChange.disabled = true;
  els.viewedToggle.disabled = true;
  els.binaryNotice.hidden = true;
}

function clearSelection() {
  document.body.classList.add("empty-diff");
  state.selectedPath = null;
  els.fileTitle.textContent = "Select a file";
  els.fileSubtitle.textContent = "Base code will appear on the left, PR code on the right.";
  els.prevChange.disabled = true;
  els.nextChange.disabled = true;
  els.viewedToggle.checked = false;
  els.viewedToggle.disabled = true;
  els.binaryNotice.hidden = true;
  els.lhsTitle.textContent = "";
  els.rhsTitle.textContent = "";
  setMergelyContent("", "");
}

function setMergelyContent(left, right) {
  if (!state.mergely) return;
  state.mergely.cm("lhs").setValue(String(left ?? ""));
  state.mergely.cm("rhs").setValue(String(right ?? ""));
  state.mergely.update();
  removeMergelyUndefinedTextNodes();
}

function waitForMergely() {
  const started = Date.now();
  const timer = setInterval(() => {
    if (window.prCompareMergely) {
      clearInterval(timer);
      state.mergely = window.prCompareMergely;
      state.mergely.cm("lhs").setOption("readOnly", true);
      state.mergely.cm("rhs").setOption("readOnly", true);
      clearSelection();
      removeMergelyUndefinedTextNodes();
    } else if (Date.now() - started > 5000) {
      clearInterval(timer);
      setMessage("error", "Mergely failed to initialize.");
    }
  }, 50);
}

function removeMergelyUndefinedTextNodes() {
  document.querySelectorAll("#mergely .CodeMirror").forEach((editor) => {
    editor.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue === "undefined") {
        node.remove();
      }
    });
  });
}

async function api(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

function setLoading(loading) {
  els.submit.disabled = loading;
  els.submit.textContent = loading ? "Loading..." : "Compare";
}

function setMessage(type, text) {
  els.message.hidden = false;
  els.message.className = `message ${type}`;
  els.message.textContent = text;
}

function statusLabel(status) {
  return {
    A: "Added",
    D: "Deleted",
    M: "Modified",
    R: "Renamed",
    C: "Copied"
  }[status] || "Changed";
}

function shortSha(value) {
  return String(value || "").slice(0, 7);
}
