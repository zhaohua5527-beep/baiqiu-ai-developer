const workspaceSessions = new Map();
let workspaceOwner = "";
let workspacePersistTimer = null;

function workspaceState(sessionId = state.selectedSessionId) {
  if (!workspaceSessions.has(sessionId)) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(`baiqiu.workspace.${sessionId}`) || "{}"); } catch {}
    workspaceSessions.set(sessionId, {
      files: Array.isArray(saved.files) ? saved.files.filter(file => file && typeof file.path === "string").slice(-20) : [],
      active: typeof saved.active === "string" ? saved.active : "",
      positions: saved.positions || {}, list: saved.list === true || saved.list === false ? saved.list : null,
      filter: "", query: "", width: Number(saved.width) || 0
    });
  }
  return workspaceSessions.get(sessionId);
}

function workspaceRemember(sessionId = workspaceOwner) {
  if (!sessionId) return;
  const view = workspaceState(sessionId);
  try {
    localStorage.setItem(`baiqiu.workspace.${sessionId}`, JSON.stringify({
      files: view.files.filter(file => file.path || file.sourcePath).map(file => ({
        id: taskBoardFileKey(file), name: file.name, path: file.sourcePath || file.path,
        sourcePath: file.sourcePath || file.path, strictPath: true, sessionId
    })).slice(-20), active: view.active, positions: view.positions, list: view.list, width: view.width
    }));
  } catch {}
}

function workspaceListVisible(view, fileCount) {
  return view.list === null ? fileCount >= 2 : view.list;
}

function workspaceFileLabel(file, files) {
  const name = file.name || "文件";
  const sameName = files.filter(current => String(current.name || "").toLowerCase() === String(name).toLowerCase());
  if (sameName.length < 2) return name;
  const source = file.sourcePath || file.path || "";
  const parts = source.split(/[\\/]/).filter(Boolean);
  return `${name} · ${parts.at(-2) || `文件${sameName.indexOf(file) + 1}`}`;
}

function workspaceCapture() {
  if (!workspaceOwner) return;
  const body = document.getElementById("taskBoardBody");
  const source = body?.querySelector("[data-document-source]");
  const reader = body?.querySelector("[data-document-preview]");
  const view = workspaceState(workspaceOwner);
  const key = body?.dataset.workspaceKey;
  if (key) view.positions[key] = {
    source: source?.scrollTop || 0, left: source?.scrollLeft || 0,
    preview: reader?.scrollTop || 0, start: source?.selectionStart || 0, end: source?.selectionEnd || 0
  };
  workspaceRemember(workspaceOwner);
}

function workspaceRegister(file) {
  workspaceCapture();
  const sessionId = state.selectedSessionId;
  const view = workspaceState(sessionId);
  const item = { ...file, sessionId };
  const key = taskBoardFileKey(item);
  if (!view.files.some(current => taskBoardFileKey(current) === key)) view.files.push(item);
  view.active = key;
  workspaceOwner = sessionId;
  state.taskBoardOpenedFiles[key] = item;
  workspaceRemember(sessionId);
}

function workspaceOpenFile(file) {
  workspaceRegister(file);
  state.taskBoardTab = "files";
  if (isTaskBoardImage(file)) void loadTaskBoardImagePreview(file);
  else void loadTaskBoardFilePreview(file);
}

function workspacePosition(drawer, chat) {
  const view = workspaceState();
  const total = chat.clientWidth;
  const wide = drawer.classList.contains("workspace-maximized") || total < 780;
  const width = wide ? total : Math.max(390, Math.min(view.width || total * .56, total - 340));
  chat.classList.add("workspace-open");
  chat.classList.toggle("workspace-overlay", wide);
  chat.style.setProperty("--workspace-width", `${Math.round(width)}px`);
  drawer.style.bottom = "0px";
  requestEmbeddedBrowserLayout();
}

function workspaceBindShell(drawer) {
  drawer.querySelector("[data-workspace-files]").addEventListener("click", () => {
    const view = workspaceState();
    view.list = drawer.querySelector(".workspace-content")?.dataset.list !== "true";
    workspaceRemember();
    openTaskBoard("files");
  });
  drawer.querySelector("[data-workspace-maximize]").addEventListener("click", event => {
    drawer.classList.toggle("workspace-maximized");
    event.currentTarget.textContent = drawer.classList.contains("workspace-maximized") ? "还原" : "放大";
    positionTaskBoard();
  });
  drawer.querySelector("[data-workspace-browser]").addEventListener("click", () => openTaskBoard("links"));
  drawer.querySelector("[data-workspace-log]").addEventListener("click", () => openTaskBoard("timeline"));
  const resize = drawer.querySelector("[data-workspace-resize]");
  resize.addEventListener("pointerdown", event => {
    if (event.button !== 0 || drawer.classList.contains("workspace-maximized")) return;
    event.preventDefault();
    resize.setPointerCapture(event.pointerId);
    const move = current => {
      const chat = document.querySelector(".chat");
      workspaceState().width = chat.getBoundingClientRect().right - current.clientX;
      positionTaskBoard();
    };
    const finish = () => {
      resize.removeEventListener("pointermove", move);
      resize.removeEventListener("pointerup", finish);
      resize.removeEventListener("pointercancel", finish);
      workspaceRemember();
    };
    resize.addEventListener("pointermove", move);
    resize.addEventListener("pointerup", finish);
    resize.addEventListener("pointercancel", finish);
  });
  resize.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    workspaceState().width = drawer.clientWidth + (event.key === "ArrowLeft" ? 30 : -30);
    positionTaskBoard();
    workspaceRemember();
  });
  window.addEventListener("beforeunload", event => {
    workspaceCapture();
    if (Object.values(state.taskBoardDocumentDrafts).some(draft => draft.dirty || draft.saving)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

function workspaceRender(body) {
  const sessionId = state.selectedSessionId;
  if (workspaceOwner !== sessionId) {
    workspaceCapture();
    workspaceOwner = sessionId;
    state.taskBoardFocusId = workspaceState(sessionId).active;
    delete body.dataset.workspaceSignature;
    delete body.dataset.workspaceKey;
  }
  const view = workspaceState();
  const messages = state.taskBoardMessageSessionId === sessionId ? state.taskBoardMessages : state.currentMessages;
  const assets = cachedTaskBoardAssets(messages || []);
  const candidates = [...assets.files, ...assets.images, ...view.files,
    ...Object.values(state.taskBoardOpenedFiles).filter(file => file.sessionId === sessionId)];
  const files = [...new Map(candidates.map(file => [taskBoardFileKey(file), file])).values()];
  const activeKey = state.taskBoardFocusId || view.active || (files.length === 1 ? taskBoardFileKey(files[0]) : "");
  const active = files.find(file => taskBoardFileKey(file) === activeKey);
  const key = active ? taskBoardFileKey(active) : "";
  const listVisible = workspaceListVisible(view, files.length);
  if (active && !view.files.some(file => taskBoardFileKey(file) === key)) view.files.push({ ...active, sessionId });
  view.active = key;
  const filesButton = document.querySelector("[data-workspace-files]");
  if (filesButton) {
    filesButton.textContent = `${listVisible ? "隐藏目录" : "文件目录"} · ${files.length}`;
    filesButton.setAttribute("aria-expanded", String(listVisible));
  }
  const tabs = document.getElementById("taskBoardTabs");
  const tabHtml = view.files.map(file => {
    const id = taskBoardFileKey(file);
    const dirty = state.taskBoardDocumentDrafts[id]?.dirty || state.taskBoardSheetDrafts[id]?.dirty;
    const label = workspaceFileLabel(file, files);
    return `<div class="workspace-tab ${id === key ? "active" : ""}"><button type="button" data-workspace-open="${escapeHtml(id)}" title="${escapeHtml(file.sourcePath || file.path || label)}">${escapeHtml(label)}${dirty ? " ·" : ""}</button><button type="button" data-workspace-close="${escapeHtml(id)}" aria-label="关闭 ${escapeHtml(label)}">×</button></div>`;
  }).join("");
  if (tabs.innerHTML !== tabHtml) {
    tabs.innerHTML = tabHtml || '<span class="workspace-tab-empty">打开一个文件，开始工作</span>';
    tabs.querySelectorAll("[data-workspace-open]").forEach(button => button.addEventListener("click", () => {
      workspaceOpenFile(view.files.find(file => taskBoardFileKey(file) === button.dataset.workspaceOpen));
    }));
    tabs.querySelectorAll("[data-workspace-close]").forEach(button => button.addEventListener("click", async () => {
      const id = button.dataset.workspaceClose;
      const draft = state.taskBoardDocumentDrafts[id];
      const sheet = state.taskBoardSheetDrafts[id];
      if (draft?.saving) return showCopyToast("正在保存，请稍后关闭");
      if (draft?.dirty || sheet?.dirty) {
        const confirmed = await showAppConfirm({ title: "关闭文件", message: "文件有未保存修改。关闭标签会放弃这些修改。", primary: "放弃并关闭", secondary: "继续编辑" });
        if (!confirmed) return;
      }
      workspaceCapture();
      view.files = view.files.filter(file => taskBoardFileKey(file) !== id);
      if (view.active === id) view.active = taskBoardFileKey(view.files.at(-1) || {});
      state.taskBoardFocusId = view.active;
      delete state.taskBoardDocumentDrafts[id];
      delete state.taskBoardSheetDrafts[id];
      workspaceRemember(sessionId);
      delete body.dataset.workspaceSignature;
      renderTaskBoard();
    }));
  }
  if (active && isTaskBoardImage(active) && active.dataUrl && !state.taskBoardPreviewContent[key]) {
    state.taskBoardPreviewContent[key] = { ok: true, kind: "image", dataUrl: active.dataUrl };
  }
  const cached = state.taskBoardPreviewContent[key];
  const signature = JSON.stringify([sessionId, key, cached?.kind,
    Boolean(state.taskBoardPreviewRows[key]), listVisible, view.filter, view.query, files.map(taskBoardFileKey)]);
  if (body.dataset.workspaceSignature === signature) return;
  workspaceCapture();
  body.dataset.workspaceSignature = signature;
  body.dataset.workspaceKey = key;
  body.classList.add("workspace-body");
  const visibleFiles = files.filter(file => (!view.query || String(file.name || "").toLowerCase().includes(view.query.toLowerCase()))
    && (!view.filter || (view.filter === "tables" ? isSpreadsheetFile(file) : view.filter === "images" ? isTaskBoardImage(file) : !isSpreadsheetFile(file) && !isTaskBoardImage(file))));
  const list = `<aside class="workspace-file-list"><label>查找文件<input data-workspace-search type="search" placeholder="搜索文件名" value="${escapeHtml(view.query)}"></label><select data-workspace-filter aria-label="文件类型"><option value="">全部文件</option><option value="documents">文档与代码</option><option value="tables">表格</option><option value="images">图片</option></select><div>${visibleFiles.map(file => { const label = workspaceFileLabel(file, files); return `<button type="button" data-workspace-file="${escapeHtml(taskBoardFileKey(file))}" title="${escapeHtml(file.sourcePath || file.path || label)}"><small>${escapeHtml(taskBoardFileType(file))}</small><span>${escapeHtml(label)}</span></button>`; }).join("") || '<p>当前会话暂无匹配文件</p>'}</div></aside>`;
  const content = active ? taskBoardInternalPreviewHtml(active) : taskBoardEmptyHtml("成果工作台", "点击对话中的文件，或从文件列表选择，即可在这里查看与编辑。");
  const editing = active && ((isTaskBoardEditableDocument(active) && cached?.kind === "text" && !cached.truncated) || state.taskBoardPreviewRows[key]?.length);
  body.innerHTML = `<div class="workspace-content" data-list="${listVisible}">${list}<main class="workspace-reader">${active && !editing ? `<header class="workspace-reader-head"><strong>${escapeHtml(workspaceFileLabel(active, files))}</strong><button data-workspace-external type="button">打开原文件</button></header>` : ""}${content}</main></div>`;
  const filter = body.querySelector("[data-workspace-filter]");
  filter.value = view.filter;
  filter.addEventListener("change", () => { view.filter = filter.value; renderTaskBoard(); });
  const search = body.querySelector("[data-workspace-search]");
  search.addEventListener("input", () => {
    view.query = search.value;
    const position = search.selectionStart;
    renderTaskBoard();
    const replacement = body.querySelector("[data-workspace-search]");
    replacement.focus();
    if (replacement.type !== "search") replacement.setSelectionRange(position, position);
  });
  body.querySelectorAll("[data-workspace-file]").forEach(button => button.addEventListener("click", () => workspaceOpenFile(files.find(file => taskBoardFileKey(file) === button.dataset.workspaceFile))));
  body.querySelectorAll("[data-workspace-external], [data-board-file-open]").forEach(button => button.addEventListener("click", async () => {
    const result = await api.openOriginalAttachment(active).catch(error => ({ message: error.message }));
    if (!result?.ok) showCopyToast(result?.message || "无法打开原文件");
  }));
  body.querySelector("[data-board-file-location]")?.addEventListener("click", () => showAttachmentInFolder(active));
  body.querySelector("[data-board-preview-close]")?.addEventListener("click", () => {
    workspaceCapture();
    view.active = "";
    view.list = true;
    state.taskBoardFocusId = "";
    renderTaskBoard();
  });
  if (active && !cached) {
    if (isTaskBoardImage(active)) void loadTaskBoardImagePreview(active);
    else void loadTaskBoardFilePreview(active);
    return;
  }
  if (active && isTaskBoardEditableDocument(active)) bindTaskBoardDocumentControls(body, active);
  if (active && isSpreadsheetFile(active)) bindTaskBoardSheetControls(body, active, { files, tables: files.filter(isSpreadsheetFile), images: assets.images, links: assets.links });
  workspaceRemember(sessionId);
}

function workspaceDocumentHtml(file, content) {
  const key = taskBoardFileKey(file);
  const draft = taskBoardDocumentDraft(file, content);
  const loaded = state.taskBoardPreviewContent[key] || {};
  draft.baseContent ??= draft.content;
  draft.contentHash ??= loaded.contentHash;
  draft.mode ??= /\.(md|markdown)$/i.test(file.name || "") ? "read" : "edit";
  const sourcePath = loaded.sourcePath || file.sourcePath || file.path || "";
  return `<section class="task-board-document-editor" data-document-key="${escapeHtml(key)}" data-mode="${draft.mode}">
    <header class="task-board-document-bar"><div><strong>${escapeHtml(file.name || "文本文件")}</strong><small title="${escapeHtml(sourcePath)}">${escapeHtml(sourcePath)}</small></div><div class="task-board-document-actions"><button type="button" data-document-save>保存</button><button type="button" data-document-reload>重新读取</button><button type="button" data-document-location>位置</button></div></header>
    <div class="task-board-document-toolbar"><button type="button" data-document-mode="read">阅读</button><button type="button" data-document-mode="edit">编辑</button><button type="button" data-document-mode="compare">修改对比</button><button type="button" data-document-undo>撤销</button><button type="button" data-document-redo>重做</button><button type="button" data-document-restore>还原修改</button><span data-document-dirty>${draft.dirty ? "未保存" : "已读取"}</span></div>
    <div class="workspace-document-find"><input data-document-find placeholder="查找内容" aria-label="查找内容"><input data-document-replacement placeholder="替换为" aria-label="替换为"><button type="button" data-document-find-next>查找下一处</button><button type="button" data-document-replace>替换选中</button></div>
    <div class="task-board-document-columns"><textarea class="task-board-document-source" data-document-source spellcheck="false" aria-label="文件内容编辑">${escapeHtml(draft.content)}</textarea><div class="task-board-document-preview" data-document-preview>${taskBoardDocumentPreviewHtml(file, draft.content)}</div></div>
    <footer class="workspace-document-footer"><button type="button" data-document-ask>选中内容交给黑球</button><span data-document-status>${loaded.encoding || "文本"} · ${loaded.lineEnding || ""} · 编辑后点击保存写回原文件</span></footer>
  </section>`;
}

function workspaceBindDocument(body, file) {
  const editor = body.querySelector(".task-board-document-editor");
  const key = taskBoardFileKey(file);
  const draft = state.taskBoardDocumentDrafts[key];
  if (!editor || !draft) return;
  const sessionId = state.selectedSessionId;
  const source = editor.querySelector("[data-document-source]");
  const preview = editor.querySelector("[data-document-preview]");
  const status = editor.querySelector("[data-document-status]");
  const dirty = editor.querySelector("[data-document-dirty]");
  let selection = "";
  const setMode = mode => {
    draft.mode = mode;
    editor.dataset.mode = mode;
    if (mode === "read") preview.innerHTML = taskBoardDocumentPreviewHtml(file, draft.content);
    if (mode === "compare") preview.innerHTML = `<strong>磁盘读取版本（修改前）</strong><pre class="task-board-document-plain">${escapeHtml(draft.baseContent)}</pre>`;
    editor.querySelectorAll("[data-document-mode]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.documentMode === mode)));
  };
  setMode(draft.mode);
  const position = workspaceState(sessionId).positions[key];
  if (position) {
    source.scrollTop = position.source || 0;
    source.scrollLeft = position.left || 0;
    source.setSelectionRange(position.start || 0, position.end || 0);
    preview.scrollTop = position.preview || 0;
  }
  const changed = () => {
    draft.content = source.value;
    draft.dirty = draft.content.replace(/\r\n/g, "\n") !== draft.baseContent.replace(/\r\n/g, "\n");
    dirty.textContent = draft.dirty ? "未保存" : "已读取";
    status.textContent = draft.dirty ? "未保存修改 · Ctrl+S 保存" : "内容与读取版本一致";
  };
  source.addEventListener("input", changed);
  const captureSelection = () => {
    selection = source.value.slice(source.selectionStart, source.selectionEnd);
  };
  source.addEventListener("select", captureSelection);
  preview.addEventListener("mouseup", () => {
    const selected = window.getSelection();
    if (selected?.anchorNode && preview.contains(selected.anchorNode) && preview.contains(selected.focusNode)) selection = selected.toString();
  });
  for (const element of [source, preview]) element.addEventListener("scroll", () => {
    clearTimeout(workspacePersistTimer);
    workspacePersistTimer = setTimeout(workspaceCapture, 250);
  }, { passive: true });
  editor.querySelectorAll("[data-document-mode]").forEach(button => button.addEventListener("click", () => setMode(button.dataset.documentMode)));
  editor.querySelector("[data-document-location]").addEventListener("click", () => showAttachmentInFolder(file));
  for (const action of ["undo", "redo"]) editor.querySelector(`[data-document-${action}]`).addEventListener("click", () => {
    setMode("edit");
    source.focus();
    document.execCommand(action);
    changed();
  });
  editor.querySelector("[data-document-restore]").addEventListener("click", async () => {
    if (draft.saving || !draft.dirty) return;
    if (!await showAppConfirm({ title: "还原修改", message: "还原到最近读取或保存的版本？原文件不会改动。", primary: "还原", secondary: "保留修改" })) return;
    source.value = draft.baseContent;
    changed();
    setMode(draft.mode);
  });
  const saveButton = editor.querySelector("[data-document-save]");
  saveButton.disabled = Boolean(draft.saving);
  saveButton.addEventListener("click", async () => {
    if (draft.saving || !draft.dirty) return;
    const loaded = state.taskBoardPreviewContent[key];
    if (!draft.contentHash || !loaded?.sourcePath || loaded.truncated) {
      status.textContent = "尚未完整读取原文件，不能保存。请重新读取";
      return;
    }
    draft.saving = true;
    saveButton.disabled = true;
    const submitted = source.value;
    status.textContent = "正在保存…";
    try {
      const result = await api.documentSave({ sourcePath: loaded.sourcePath, content: submitted, expectedHash: draft.contentHash });
      if (!result?.ok) throw new Error(result?.message || "保存失败");
      draft.baseContent = submitted;
      draft.contentHash = result.contentHash;
      draft.modifiedAt = result.modifiedAt;
      draft.dirty = draft.content.replace(/\r\n/g, "\n") !== submitted.replace(/\r\n/g, "\n");
      Object.assign(loaded, { previewText: submitted, contentHash: result.contentHash, modifiedAt: result.modifiedAt });
      dirty.textContent = draft.dirty ? "未保存" : "已保存";
      status.textContent = draft.dirty ? "此前版本已保存，新增编辑尚未保存" : "已保存到原文件";
    } catch (error) { status.textContent = error.message || "保存失败，编辑内容已保留"; }
    finally {
      draft.saving = false;
      saveButton.disabled = false;
      const mounted = body.querySelector(".task-board-document-editor");
      if (mounted && mounted !== editor && mounted.dataset.documentKey === key) {
        mounted.querySelector("[data-document-save]").disabled = false;
        mounted.querySelector("[data-document-dirty]").textContent = draft.dirty ? "未保存" : "已保存";
        mounted.querySelector("[data-document-status]").textContent = status.textContent;
      }
    }
  });
  editor.querySelector("[data-document-reload]").addEventListener("click", async () => {
    if (draft.saving) return;
    if (draft.dirty && !await showAppConfirm({ title: "重新读取文件", message: "原地编辑尚未保存。重新读取将放弃这些修改，载入磁盘版本。", primary: "放弃修改并读取", secondary: "保留修改" })) return;
    const contentAtRead = draft.content;
    try {
      const loaded = await api.previewAttachment({ ...file, sourcePath: state.taskBoardPreviewContent[key]?.sourcePath || file.sourcePath || file.path, strictPath: true });
      if (!loaded?.ok || loaded.kind !== "text") throw new Error(loaded?.previewText || "读取失败");
      if (draft.content !== contentAtRead) {
        status.textContent = "读取期间又有编辑，已保留草稿；请完成编辑后再读取";
        return;
      }
      state.taskBoardPreviewContent[key] = loaded;
      delete state.taskBoardDocumentDrafts[key];
      if (state.selectedSessionId === sessionId && state.taskBoardFocusId === key) {
        delete body.dataset.workspaceSignature;
        renderTaskBoard();
      }
    } catch (error) { status.textContent = error.message; }
  });
  const find = editor.querySelector("[data-document-find]");
  editor.querySelector("[data-document-find-next]").addEventListener("click", () => {
    if (!find.value) return;
    setMode("edit");
    let offset = source.value.indexOf(find.value, source.selectionEnd);
    if (offset < 0) offset = source.value.indexOf(find.value);
    if (offset < 0) { status.textContent = "没有匹配内容"; return; }
    source.focus();
    source.setSelectionRange(offset, offset + find.value.length);
    captureSelection();
  });
  editor.querySelector("[data-document-replace]").addEventListener("click", () => {
    if (!find.value || source.value.slice(source.selectionStart, source.selectionEnd) !== find.value) {
      status.textContent = "请先查找并选中要替换的内容"; return;
    }
    source.focus();
    document.execCommand("insertText", false, editor.querySelector("[data-document-replacement]").value);
    changed();
  });
  source.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveButton.click(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); find.focus(); }
    if (event.key === "Tab") { event.preventDefault(); document.execCommand("insertText", false, "  "); changed(); }
  });
  editor.querySelector("[data-document-ask]").addEventListener("click", () => {
    if (!selection.trim()) return showCopyToast("先选中需要修改的文字或代码");
    if (selection.length > 16000) return showCopyToast("所选内容较长，请缩小范围后引用");
    if (draft.dirty || draft.saving) return showCopyToast("请先保存修改，再交给黑球，确保它读取同一版本");
    const loaded = state.taskBoardPreviewContent[key];
    const sourcePath = loaded?.sourcePath;
    if (!sourcePath || !loaded.contentHash) return showCopyToast("请先完整读取原文件");
    if (state.selectedSessionId !== sessionId) return;
    const quoted = `文件：${sourcePath}\n读取版本 SHA-256：${loaded.contentHash}\n选中内容：\n${selection}\n修改前请读取并核对当前文件；若版本有变化，先核对差异，不要覆盖其他修改。`;
    state.composerQuote = { sessionId, composerSessionId: sessionId, source: file.name || "工作区文件",
      text: quoted, selectionText: quoted, attachments: [{ name: file.name, path: sourcePath, sourcePath }] };
    renderComposerQuote();
    if (document.querySelector(".chat")?.classList.contains("workspace-overlay")) closeTaskBoard();
    chatInput.focus();
    showCopyToast("文件与选中内容已加入引用，请输入修改要求后发送");
  });
}
